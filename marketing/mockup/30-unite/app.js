const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* header → full width on scroll */
const navShell = document.getElementById('navShell');
const onScroll = () => {
	if (!navShell) return;
	navShell.classList.toggle('is-scrolled', window.scrollY > 24);
};
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

/* scroll reveals */
const reveals = document.querySelectorAll('.reveal');
if (reduce) {
	reveals.forEach((el) => el.classList.add('in'));
} else if ('IntersectionObserver' in window) {
	const io = new IntersectionObserver(
		(entries) => {
			entries.forEach((e) => {
				if (e.isIntersecting) {
					e.target.classList.add('in');
					io.unobserve(e.target);
				}
			});
		},
		{ threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
	);
	reveals.forEach((el) => io.observe(el));
} else {
	reveals.forEach((el) => el.classList.add('in'));
}

/* plan rail + slider */
const tiers = [
	{
		t: 'Start',
		price: '$19',
		d: 'Shop kernel + core ecommerce. Onboard under Shopify Basic — local or international.',
		items: ['Portal + website', 'Ecommerce essentials', 'Light credits'],
	},
	{
		t: 'Run',
		price: '$49',
		d: 'Day-to-day operate — add chat, messaging, or a pay pack without an app invoice.',
		items: ['Everything in Start', 'One operate pack', 'Staff seats'],
	},
	{
		t: 'Full',
		price: '$99',
		d: 'Whole OS. Still priced under a Shopify-shaped Basic + apps basket.',
		items: ['All six products', 'Pocket Operate', 'Honest usage credits'],
	},
];

const panel = document.getElementById('panel');
const show = (i) => {
	const x = tiers[i];
	const apply = () => {
		document.getElementById('pt').textContent = x.t;
		document.getElementById('price').textContent = x.price;
		document.getElementById('pd').textContent = x.d;
		document.getElementById('pl').innerHTML = x.items.map((s) => `<li>${s}</li>`).join('');
		document.querySelectorAll('.stop').forEach((btn) => btn.classList.toggle('on', Number(btn.dataset.i) === i));
		const tier = document.getElementById('tier');
		if (tier && Number(tier.value) !== i) tier.value = String(i);
		if (panel) panel.classList.remove('swap');
	};
	if (panel && !reduce) {
		panel.classList.add('swap');
		setTimeout(apply, 160);
	} else {
		apply();
	}
};

document.querySelectorAll('.stop').forEach((btn) => {
	btn.addEventListener('click', () => show(Number(btn.dataset.i)));
});
const tier = document.getElementById('tier');
if (tier) tier.addEventListener('input', () => show(Number(tier.value)));
show(2);

/* clock */
const clock = document.getElementById('clock');
const pad = (n) => String(n).padStart(2, '0');
const tick = () => {
	const d = new Date();
	if (clock) clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
tick();
setInterval(tick, 1000);

/* count-up */
document.querySelectorAll('[data-count]').forEach((el) => {
	const target = Number(el.dataset.count);
	if (reduce) {
		el.textContent = String(target);
		return;
	}
	let n = 0;
	const step = () => {
		if (target === 0) {
			el.textContent = '0';
			return;
		}
		n += Math.max(1, Math.ceil(target / 20));
		if (n >= target) {
			el.textContent = String(target);
			return;
		}
		el.textContent = String(n);
		requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
});

/* live streams + bump */
const live = { orders: true, chats: true };
const vals = { orders: 128, chats: 14 };
const bump = (id, val) => {
	const el = document.getElementById(id);
	if (!el) return;
	el.textContent = String(val);
	el.classList.remove('bump');
	void el.offsetWidth;
	el.classList.add('bump');
};
setInterval(() => {
	if (live.orders) {
		vals.orders += Math.floor(Math.random() * 3);
		bump('orders', vals.orders);
	}
	if (live.chats) {
		vals.chats = Math.max(0, vals.chats + Math.floor(Math.random() * 3) - 1);
		bump('chats', vals.chats);
	}
}, 1800);

document.querySelectorAll('[data-toggle]').forEach((btn) => {
	btn.addEventListener('click', () => {
		const k = btn.dataset.toggle;
		live[k] = !live[k];
		btn.textContent = live[k] ? 'toggle live' : 'paused';
	});
});

const packs = {
	local: 'jazzcash · easypaisa · whatsapp',
	intl: 'stripe · paypal · email',
};
document.querySelectorAll('[data-region]').forEach((btn) => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('[data-region]').forEach((b) => b.classList.remove('on'));
		btn.classList.add('on');
		const out = document.getElementById('regionOut');
		if (out) {
			out.style.opacity = '0';
			out.style.transform = 'translateY(4px)';
			setTimeout(() => {
				out.textContent = packs[btn.textContent.trim()] || packs.local;
				out.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
				out.style.opacity = '1';
				out.style.transform = 'none';
			}, 120);
		}
	});
});

/* terminal */
const term = document.getElementById('term');
const wizard = document.getElementById('wizard');
if (wizard && term) {
	wizard.addEventListener('submit', (e) => {
		e.preventDefault();
		const email = new FormData(wizard).get('email');
		const lines = [
			`<p><span class="g">$</span> ss init --email ${email}</p>`,
			`<p class="dim">minting developer pack… ok</p>`,
			`<p class="dim">portal ready · operate HOT</p>`,
		];
		lines.forEach((html, i) => {
			setTimeout(() => {
				term.insertAdjacentHTML('beforeend', html);
				term.scrollTop = term.scrollHeight;
			}, i * 180);
		});
		wizard.reset();
	});
}

/* Rift geo pointer parallax */
const geoStage = document.getElementById('geoStage');
if (geoStage && !reduce) {
	geoStage.addEventListener('pointermove', (e) => {
		const r = geoStage.getBoundingClientRect();
		const x = (e.clientX - r.left) / r.width - 0.5;
		const y = (e.clientY - r.top) / r.height - 0.5;
		geoStage.querySelectorAll('.geo i').forEach((el, i) => {
			const m = (i + 1) * 12;
			el.style.transform = `translate(${x * m}px, ${y * m}px) rotate(${(i + 1) * 8}deg)`;
		});
	});
}
