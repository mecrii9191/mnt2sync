const sendWarn = (msg, type) => {
    const message = document.querySelector('#message');
    switch (type) {
        case 0:
            message.className = 'errorLabel';
            break;
        case 1:
            message.className = 'successLabel';
            break;
        default:
            break;
    }

    message.innerText = msg;
}

(async () => { // global data
    await fetch('/api/v1/syncs');
    const {
        attempts,
        partitions
    } = await fetch('/api/v1/globalData').then((res) => res.json());
    console.log('load', attempts, partitions);

    if (attempts > 0) {
        sendWarn(`invalid attempts: ${globalData.attempts}`, 0);
    }

    if (partitions.length > 0) {
        const dropdown = document.querySelector('select');
        partitions.forEach((key) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.innerHTML = key.replace('/dev/mapper', '');
            dropdown.appendChild(opt);
        });
        // add options...
    }
})();

const mount = (s, pas) => {
    return fetch('/api/v1/mount', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sync: s,
            password: pas
        })
    }).then((res) => res.json());
}

window.mog = async () => {
    sendWarn('', 0);
    const selected = document.querySelector('#type').value;
    const password = document.querySelector('input[type=password]').value;

    try {
        const res = await mount(selected, password);
        console.log(res);
        if (res.mounted) {
            sendWarn('mounted sync!', 1);
        } else {
            sendWarn(`failed to mount sync! (${res.message})`, 0);
        }
    } catch (err) {
        const {
            message
        } = err.message;
        sendWarn(`failed to mount sync! (${message})`, 0);
    }
};
