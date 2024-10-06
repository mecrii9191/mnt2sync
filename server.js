#!/usr/bin/env node
// server
// TODO dockerfile: sudoers, map /usr/sbin /bin, sudo....?
// as we only use cryptsetup, mount
// in syncthing docker-compose bind volume: /syncs:/syncs:rw
// example for ./config: module.exports = { 'sync1': 'abcedf-ghijk-....' }; (find it out using blkid)

const fs = require('fs');
const express = require('express');
const {
    Mutex
} = require('async-mutex');
const path = require('path');
const {
    exec,
    execSync,
    spawn
} = require('child_process');

const PARTITION_CONFIG = require('./config');

const globalData = {
    attempts: 0,
    volumeMap: new Map()
};

const backend = express();
const routes = express.Router();
const mutex = new Mutex();

backend.use(express.static('public'))
backend.use(express.json());
backend.use(express.urlencoded({
    extended: true
}));

backend.use(({
    url
}, res, next) => { // redirect /public
    if (url.startsWith('/css') || url.startsWith('/js') || url.startsWith('/img')) {
        res.sendFile(__dirname + '/public' + url);
    } else {
        next();
    }
});

backend.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

backend.use('/api/v1', routes);

backend.use((req, res, next) => {
    res.sendStatus(500);
    next();
});

const stdoutExec = (cmd) => {
    return new Promise((resolve) => {
        const child = exec(cmd);
        let stdout = '';

        child.stdout.on('data', (data) => {
            stdout += data;
        });

        child.stderr.on('data', (data) => {
            // pipe to stdout...
            //stdout += data;
        });
        child.on('close', (code) => {
            resolve(stdout);
        });
    });
};

const resolveLVM = () => {
    if (globalData.volumeMap.size) {
        return globalData.volumeMap;
    }

    // each sync represents a volume group
    // resolve logical volume
    // (couldve been done much shorter but this just werks)

    const volMap = new Map();

    // replace this with shelljs..
    const cmd1 = stdoutExec(`ls -l /dev/mapper/ | sed -n 's/^.*\\(vg[[:digit:]]*\\)/\\/dev\\/mapper\\/\\1/p' | awk -v sep=" ->" '{print substr($0,0,index($0,sep)-1) }'`);
    const cmd3 = stdoutExec(`pvs`);

    return Promise.allSettled([cmd1, cmd3]).then((results) => {
        const [r1, r2] = results;
        const splitValue = ({
            value
        }) => value.split('\n');

        let syncMaps = {};
        splitValue(r2).forEach((line) => {
            const mat = line.match(/(?:\b|\s*?)(\/dev\/mapper\/sync\d+)\s*?(vg\d+)/);
            if (mat) {
                const [, parent, vol] = mat;
                syncMaps[vol] = parent;
            }
        });

        splitValue(r1).forEach((line) => {
            const res = line.match(/vg\d+/);
            if (res) {
                const [vol] = res;
                volMap.set(line, syncMaps[vol]);
            }
        });

        globalData.volumeMap = volMap;
        return volMap;
    });
}

routes.get('/syncs', (req, res) => {
    return res.json(Object.keys(PARTITION_CONFIG));
});

routes.get('/globalData', (req, res) => {
    return res.json({
        ...globalData,
        volumeMap: {},
        partitions: Object.keys(PARTITION_CONFIG)
    });
});

routes.post('/mount', async (req, res) => { // unlock and mount
    let {
        sync,
        password
    } = req.body;

    if (mutex.isLocked()) return res.status(400);
    if (!sync || !PARTITION_CONFIG[sync]) return res.status(400);
    if (password.match(/[^A-Za-z0-9!_-~]/)) return res.status(400);

    return mutex.runExclusive(async () => {
        const uuid = PARTITION_CONFIG[sync];
        const mountFlags = await (() => { // fake the mount / remount?
            const cmd = stdoutExec(`sudo /usr/sbin/cryptsetup status ${sync} | grep "in use"`);
            return cmd.then((stdout) => stdout.trim().length == 0 ? '' : '-f');
        })();

        try {
            execSync(`echo -n "${password}" | sudo /usr/sbin/cryptsetup luksOpen /dev/disk/by-uuid/${uuid} ${sync} --tries 1 ${mountFlags === '-f' ? '--test-passphrase' : ''}`, {
                stdio: 'inherit'
            });
        } catch (e) {
            return res.status(500).json({
                message: 'failed to open luks device or sync'
            });
        }

        const dests = [];
        execSync('pvscan --cache', {
            stdio: 'ignore'
        }); // watch changes
        for (let i = 0; i < 3; ++i) await resolveLVM();

        if (!globalData.volumeMap.size) return res.status(500).json({
            message: 'failed to resolve lvm'
        });

        globalData.volumeMap.forEach((syncPath, logVol) => {
            if (syncPath.endsWith(sync)) {
                const dest = `/syncs/${logVol.substring(logVol.indexOf('-')+1)}`;
                try {
                    execSync(`sudo mkdir -p ${dest}`, {
                        stdio: 'inherit'
                    });
                    execSync(`sudo mount ${logVol} ${dest} 2> /dev/null`, {
                        stdio: 'inherit'
                    });
                } catch (e) { }
                dests.push(dest);
            }
        });

        // ensure
        const cmd3 = await stdoutExec(`sudo mount | grep '/syncs/'`);
        if (dests.find(d => !cmd3.includes(d))) return res.status(500).json({
            message: 'failed to mount'
        });

        if (!cmd3.trim()) return res.status(500);

        return res.status(200).json({
            mounted: true,
            message: 'successfully mounted!'
        }); // debugging
    });
});

routes.post('/umount', async (req, res) => { // unmount and lock
    let {
        sync,
        password
    } = req.body;

    if (mutex.isLocked()) return res.status(400);
    if (!sync || !PARTITION_CONFIG[sync]) return res.status(400);
    if (password.match(/[^A-Za-z0-9!_-~]/)) return res.status(400);

    return mutex.runExclusive(async () => {
        const inAvail = await (() => {
            const cmd = stdoutExec(`sudo /usr/sbin/cryptsetup status ${sync} | grep "in use"`);
            return cmd.then((stdout) => stdout.trim().length > 0);
        })();

        if (!inAvail) return res.status(500).json({
            message: 'inavailable sync'
        });

        // validate password!
        const uuid = PARTITION_CONFIG[sync];
        const result = await stdoutExec(`echo -n "${password}" | sudo /usr/sbin/cryptsetup luksOpen /dev/disk/by-uuid/${uuid} --tries 1 --test-passphrase 2>&1`);
        if (result.includes('No key')) return res.status(500).json({
            message: 'incorrect password!'
        });

        const dests = await resolveLVM();
        if (!globalData.volumeMap.size) return res.status(500).json({
            message: 'failed to resolve lvm'
        });

        const dm = `/dev/mapper/${sync}`;
        const [dest] = [...dests.entries()].find(([, x]) => x === dm);
        if (!dest) return res.status(500);
        const [vgroup] = dest.match(/vg\d+/);

        execSync(`findmnt -S ${dest} | awk '!/TARGET/{print $1}' | xargs -r sudo umount -f`, {
            stdio: 'ignore'
        });
        try {
            execSync(`vgchange -an ${vgroup}`, {
                stdio: 'inherit'
            });
        } catch (e) {
            debugger;
        }

        execSync(`sudo /usr/sbin/cryptsetup close ${sync}`);
        // done!
    });
});

routes.post('/create', async (req, res) => { // ???
    let {
        part,
        password
    } = req.body;

    // fucking take the partition and give it to lvm?
    // might be hella dumb
    // do this later

});

backend.listen('19520', '0.0.0.0');
