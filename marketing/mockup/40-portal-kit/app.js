const clock = document.getElementById('clock');
const pad = (n) => String(n).padStart(2, '0');
const tick = () => {
	const d = new Date();
	if (clock) clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
tick();
setInterval(tick, 1000);
