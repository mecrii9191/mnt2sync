// server

const fs = require('fs');
const express = require('express');
const path = require('path');
const {
    exec,
    spawn
} = require('child_process');

const globalData = {
    attempts: 0,
    volumeMap: new Map()
};

const backend = express();
const routes = express.Router();

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

        return globalData.volumeMap = volMap;
    }).then((volumeMap) => volumeMap);
}

routes.get('/syncs', (req, res) => { // virtual volumes & fathers
    if (globalData.volumeMap.size === 0) {
        return resolveLVM().then((m) => res.json(Object.fromEntries(m.entries())));
    } else {
        return res.json(Object.fromEntries(globalData.volumeMap.entries()));
    }
});

routes.get('/globalData', (req, res) => {
    return res.json({
        ...globalData,
        volumeMap: Object.fromEntries(globalData.volumeMap.entries())
    });
});

routes.post('/mount', async (req, res) => { // unlock&mount, use -f to fake mount
    let {
        sync,
        password
    } = req.body;
    if (!sync.match(/^\/dev\/mapper\/vg\d+\-\w+$/)) return res.sendStatus(401);
    if (password.match(/[^A-Za-z0-9!_-~]/)) return res.sendStatus(401);

    const lvm = await resolveLVM();

    let mapping = lvm[sync];
    mapping = mapping.replace('/dev/mapper/', '');

    const [, syncName] = sync.match(/vg\d+\-(\w+)/);
    const mountFlags = await (() => { // fake the mount
        const cmd = stdoutExec(`sudo cryptsetup status ${mapping} | grep 'in use'`);
        return cmd.then((stdout) => stdout.trim().length == 0 ? '' : '-f');
    })();

    // todo?? (pass)
    const cmd1 = await stdoutExec(`echo -n "${password}" | sudo cryptsetup luksOpen ${mapping} --tries 1 ${mountFlags === '-f' ? '--test-passphrase' : ''}`);
    // mount...
    const cmd2 = await stdoutExec(`sudo mount ${mountFlags} ${sync} /syncs/${syncName}`);
    // should we close a volume..?
    const cmd3 = await stdoutExec(`sudo mount | grep '/syncs/${syncName}'`);

    // and listen to /syncs from application (syncthing)..

    // use mappings, validate mappings
    // shut down: vgchange -an ..
    // echo -n "pass" | sudo cryptsetup luksOpen sync1 --tries 1 (--test-passphrase)?
    // mount (-f)? /dev/mapper/vg00-... /... (phone)
    if (!cmd3.trim()) {
        return res.sendStatus(500);
    }

    return res.sendStatus(200).json({
        m1: cmd1,
        m2: cmd2
    }); // debugging
});

backend.listen('19520', '0.0.0.0');
