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
	const { attempts, volumeMap } = await fetch('/api/v1/globalData').then((res) => res.json());
	console.log('load', attempts, volumeMap);
	
	if (attempts > 0) {
		sendWarn(`invalid attempts: ${globalData.attempts}`, 0);
	}
	
	const keys = Object.keys(volumeMap);

	if (keys.length > 0) {
		const dropdown = document.querySelector('select');
		keys.forEach((key) => {
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
		body: JSON.stringify({
			sync: s,
			password: pas
		})
	}).then((res) => res.json());
}

window.mog = async () => {
	const selected = document.querySelector('#type').value;
	const password = document.querySelector('input[type=password]').value;
	
	try {
		const res = await mount(selected, password);
		console.log(res);
		sendWarn('mounted sync!', 1);
	}
	catch (err) {
		console.log(err.message);
		sendWarn('failed to mount sync! (invalid password?)', 0);
	}
};