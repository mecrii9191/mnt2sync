#!/usr/bin/env node
 // server
// TODO configure sudoers
// as we only use cryptsetup, mount
// we cant map ports in Dockerfile so choose a convinent port for this!!

const PARTITION_CONFIG = {
    'sync1': '/dev/sda1' // TODO map to luks uuid instead
};

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
            console.log('stderr', data);
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

    // use shelljs!!
    const volMap = new Map(); // vg -> sync
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
                const [, father, vol] = mat;
                syncMaps[vol] = father;
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

routes.get('/syncs', (req, res) => { // virtual volumes & fathers
    return res.json(Object.keys(PARTITION_CONFIG));
});

routes.get('/globalData', (req, res) => {
    return res.json({
        ...globalData,
        partitions: Object.keys(PARTITION_CONFIG)
    });
});

routes.post('/mount', async (req, res) => { // unlock&mount, use -f to fake mount
    let {
        sync,
        password
    } = req.body;


    if (!sync || !PARTITION_CONFIG[sync]) return res.status(400);
    if (password.match(/[^A-Za-z0-9!_-~]/)) return res.status(400);

    return mutex.runExclusive(async () => {
        const device = PARTITION_CONFIG[sync];
        const mountFlags = await (() => { // fake the mount
            const cmd = stdoutExec(`sudo cryptsetup status ${sync} | grep 'in use'`);
            return cmd.then((stdout) => stdout.trim().length == 0 ? '' : '-f');
        })();

        // todo?? (pass)
        try {
            execSync(`echo -n "${password}" | sudo cryptsetup luksOpen ${device} ${sync} --tries 1 ${mountFlags === '-f' ? '--test-passphrase' : ''}`, {
                stdio: 'inherit'
            });
        } catch (e) {
            return res.status(500).json({
                message: 'failed to open luks device or sync'
            });
        }

        const dests = [];
        for (let i = 0; i < 3; ++i) await resolveLVM();

        if (!globalData.volumeMap.size) return res.status(500).json({
            message: 'failed to resolve lvm'
        });
        globalData.volumeMap.forEach((snc, lvol) => {
            if (snc.endsWith(sync)) {
                const dest = `/syncs/${lvol.substring(lvol.indexOf('-')+1)}`;
                try {
                    execSync(`sudo mkdir -p ${dest}`, {
                        stdio: 'inherit'
                    });
                    execSync(`sudo mount ${mountFlags} ${lvol} ${dest}`, {
                        stdio: 'inherit'
                    });
                } catch (e) {}
                dests.push(dest);
            }
        });

        // ensure all mounted
        const cmd3 = await stdoutExec(`sudo mount | grep '/syncs/'`);
        if (dests.find(d => !cmd3.includes(d)))
            return res.status(500).json({
                message: 'failed to mount'
            });

        // and listen to /syncs from application (syncthing)..

        // use mappings, validate mappings
        // shut down: vgchange -an .. & cryptsetup close ..
        // echo -n "pass" | sudo cryptsetup luksOpen sync1 --tries 1 (--test-passphrase)?
        // mount (-f)? /dev/mapper/vg00-... /... (phone)
        if (!cmd3.trim()) {
            return res.status(500);
        }

        return res.status(200).json({
            mounted: true,
            message: 'successfully mounted!'
        }); // debugging
    });
});

// TODO unmount
backend.listen('19520', '0.0.0.0');
