'use client';

import Link from 'next/link.js';
import { useEffect, useRef, useState } from 'react';

const TIERS = [
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

const PACKS = {
	local: 'jazzcash · easypaisa · whatsapp',
	intl: 'stripe · paypal · email',
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * Public marketing home (Unite mockup) — Portal-hosted website.
 * @param {{ brandName?: string }} props
 */
export function SiteHome({ brandName = 'Single Solution' }) {
	const [scrolled, setScrolled] = useState(false);
	const [tier, setTier] = useState(2);
	const [swap, setSwap] = useState(false);
	const [clock, setClock] = useState('00:00:00');
	const [counts, setCounts] = useState({ products: 0, website: 0, tax: 0, desks: 0 });
	const [orders, setOrders] = useState(128);
	const [chats, setChats] = useState(14);
	const [live, setLive] = useState({ orders: true, chats: true });
	const [region, setRegion] = useState('local');
	const [termLines, setTermLines] = useState([
		{ g: true, text: 'ss doctor' },
		{ dim: true, text: '6 products · portal ok · operate HOT' },
	]);
	const [email, setEmail] = useState('');
	const geoRef = useRef(/** @type {HTMLDivElement | null} */ (null));
	const panel = TIERS[tier];

	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 24);
		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => window.removeEventListener('scroll', onScroll);
	}, []);

	useEffect(() => {
		const tick = () => {
			const d = new Date();
			setClock(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
		};
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduce) {
			setCounts({ products: 6, website: 1, tax: 0, desks: 3 });
			return;
		}
		const targets = { products: 6, website: 1, tax: 0, desks: 3 };
		/** @type {Record<string, number>} */
		const n = { products: 0, website: 0, tax: 0, desks: 0 };
		let raf = 0;
		const step = () => {
			let done = true;
			for (const k of Object.keys(targets)) {
				const t = targets[/** @type {keyof typeof targets} */ (k)];
				if (t === 0) {
					n[k] = 0;
					continue;
				}
				if (n[k] < t) {
					n[k] = Math.min(t, n[k] + Math.max(1, Math.ceil(t / 20)));
					done = false;
				}
			}
			setCounts({ ...n });
			if (!done) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, []);

	useEffect(() => {
		const id = setInterval(() => {
			setOrders((o) => (live.orders ? o + Math.floor(Math.random() * 3) : o));
			setChats((c) => (live.chats ? Math.max(0, c + Math.floor(Math.random() * 3) - 1) : c));
		}, 1800);
		return () => clearInterval(id);
	}, [live]);

	useEffect(() => {
		const root = geoRef.current;
		if (!root || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		/** @param {PointerEvent} e */
		const onMove = (e) => {
			const r = root.getBoundingClientRect();
			const x = (e.clientX - r.left) / r.width - 0.5;
			const y = (e.clientY - r.top) / r.height - 0.5;
			root.querySelectorAll('.geo i').forEach((node, i) => {
				const el = /** @type {HTMLElement} */ (node);
				const m = (i + 1) * 12;
				el.style.transform = `translate(${x * m}px, ${y * m}px) rotate(${(i + 1) * 8}deg)`;
			});
		};
		root.addEventListener('pointermove', onMove);
		return () => root.removeEventListener('pointermove', onMove);
	}, []);

	useEffect(() => {
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		const nodes = document.querySelectorAll('.ss-site .reveal');
		if (reduce) {
			nodes.forEach((el) => el.classList.add('in'));
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				entries.forEach((e) => {
					if (e.isIntersecting) {
						e.target.classList.add('in');
						io.unobserve(e.target);
					}
				});
			},
			{ threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
		);
		nodes.forEach((el) => io.observe(el));
		return () => io.disconnect();
	}, []);

	/** @param {number} i */
	const pickTier = (i) => {
		setSwap(true);
		setTimeout(() => {
			setTier(i);
			setSwap(false);
		}, 160);
	};

	return (
		<>
			<div className="wash" aria-hidden="true" />
			<div className="grid-hard" aria-hidden="true" />
			<div className="signal" aria-hidden="true">
				<i />
			</div>

			<div className={`nav-shell${scrolled ? ' is-scrolled' : ''}`}>
				<header className="nav glass">
					<span className="brand">{brandName}</span>
					<nav>
						<a href="#basket">Basket</a>
						<a href="#desks">Desks</a>
						<a href="#stack">Stack</a>
						<a href="#plan">Plan</a>
					</nav>
					<Link className="cta" href="/login">
						Start
					</Link>
				</header>
			</div>

			<main>
				<section className="hero">
					<div className="hero-copy reveal">
						<p className="live">
							<span /> LIVE · PK · UAE · EU · US
						</p>
						<h1>
							Shopify sells a store.
							<br />
							<span className="accent">We sell the stack that runs it.</span>
						</h1>
						<p className="lede">
							Portal · six products · Pocket Operate. Land under Basic. Full under Basic + apps — local rails or
							Stripe, same OS.
						</p>
						<div className="hero-actions">
							<a className="btn" href="#plan">
								See Start / Run / Full
							</a>
							<a className="text-link" href="#basket">
								Open the basket →
							</a>
						</div>
						<div className="metrics">
							<div className="metric glass reveal" data-d={0}>
								<b>{counts.products}</b>
								<span>products</span>
							</div>
							<div className="metric glass reveal" data-d={1}>
								<b>{counts.website}</b>
								<span>website</span>
							</div>
							<div className="metric glass reveal" data-d={2}>
								<b>{counts.tax}</b>
								<span>app_tax</span>
							</div>
							<div className="metric glass reveal" data-d={3}>
								<b>{counts.desks}</b>
								<span>desks</span>
							</div>
						</div>
					</div>

					<div className="hero-stage glass reveal" ref={geoRef} data-d={1}>
						<div className="stage-chrome">
							<span className="mono">ss://operate · GRIDLOCK</span>
							<span className="mono">{clock}</span>
						</div>
						<div className="stage-body">
							<div className="needs">
								<p className="label">// NEEDS_YOU</p>
								<ul>
									<li className="in">
										<b>IM-2201</b>
										<span>COD confirm · ₨12,400</span>
										<em>now</em>
									</li>
									<li className="in">
										<b>CHAT</b>
										<span>3 waiting</span>
										<em>2m</em>
									</li>
									<li className="in">
										<b>PAY</b>
										<span>proof review</span>
										<em>5m</em>
									</li>
									<li className="in">
										<b>STOCK</b>
										<span>3 SKUs under 5</span>
										<em>12m</em>
									</li>
									<li className="in">
										<b>WA</b>
										<span>retry failed send</span>
										<em>18m</em>
									</li>
								</ul>
							</div>
							<div className="term">
								<p className="label">// ONBOARD</p>
								<div className="term-log">
									{termLines.map((line, i) => (
										<p key={i} className={line.dim ? 'dim' : undefined}>
											{line.g ? <span className="g">$ </span> : null}
											{line.text}
										</p>
									))}
								</div>
								<form
									onSubmit={(e) => {
										e.preventDefault();
										const v = email.trim() || 'you@brand.com';
										setTermLines((lines) => [
											...lines,
											{ g: true, text: `ss init --email ${v}` },
											{ dim: true, text: 'minting developer pack… ok' },
											{ dim: true, text: 'portal ready · operate HOT' },
										]);
										setEmail('');
									}}>
									<label>
										merchant email
										<input
											name="email"
											type="email"
											placeholder="you@brand.com"
											autoComplete="email"
											value={email}
											onChange={(e) => setEmail(e.target.value)}
											required
										/>
									</label>
									<button type="submit">run init →</button>
								</form>
							</div>
						</div>
						<div className="geo" aria-hidden="true">
							<i className="s1" />
							<i className="s2" />
							<i className="s3" />
						</div>
					</div>
				</section>

				<div className="marquee" aria-hidden="true">
					<div className="track">
						{[
							'ACCOUNTS',
							'ECOMMERCE',
							'PAYMENTS',
							'CHAT',
							'NOTIFICATIONS',
							'GROWTH',
							'PORTAL',
							'OPERATE',
							'RIFT',
							'GRIDLOCK',
							'DEVELOPER_PACK',
						]
							.concat([
								'ACCOUNTS',
								'ECOMMERCE',
								'PAYMENTS',
								'CHAT',
								'NOTIFICATIONS',
								'GROWTH',
								'PORTAL',
								'OPERATE',
							])
							.map((t, i) => (
								<span key={`${t}-${i}`}>{t}</span>
							))}
					</div>
				</div>

				<section id="basket" className="block">
					<header className="block-head reveal">
						<p className="eyebrow mono">01 // BASKET_MATH</p>
						<h2>
							Same sticker. <span className="accent">Different basket.</span>
						</h2>
						<p>Compete on the wired stack — not on undercutting $30 forever.</p>
					</header>
					<div className="why-split reveal">
						<article className="glass hard">
							<span className="mono muted">SHOPIFY_$30</span>
							<p>Kernel. Apps for chat, WhatsApp, local pay.</p>
						</article>
						<div className="vs mono">VS</div>
						<article className="glass hard hot">
							<span className="mono lime">SS_FULL</span>
							<p>Six products wired. Full still under Basic+apps.</p>
						</article>
					</div>
					<div className="table glass hard reveal">
						<div className="row head">
							<span>CAPABILITY</span>
							<span>BASIC</span>
							<span>SS_FULL</span>
							<span>+APPS</span>
						</div>
						<div className="row">
							<span>Ecommerce</span>
							<span className="ok">Kernel</span>
							<span className="ok">Deep</span>
							<span className="ok">Kernel+</span>
						</div>
						<div className="row">
							<span>Local + intl pay</span>
							<span className="no">Gaps</span>
							<span className="ok">Payments</span>
							<span className="mid">Apps</span>
						</div>
						<div className="row">
							<span>Chat</span>
							<span className="no">—</span>
							<span className="ok">Wired</span>
							<span className="mid">$+/mo</span>
						</div>
						<div className="row">
							<span>WhatsApp / SMS</span>
							<span className="no">—</span>
							<span className="ok">Notify</span>
							<span className="mid">$+/mo</span>
						</div>
						<div className="row">
							<span>Control + phone</span>
							<span className="no">—</span>
							<span className="ok">Portal+Operate</span>
							<span className="mid">Split</span>
						</div>
						<div className="row">
							<span>Typical all-in</span>
							<span className="mid">~$30+</span>
							<span className="ok">~$99</span>
							<span className="no">$100–200+</span>
						</div>
					</div>
				</section>

				<section id="desks" className="block band">
					<header className="block-head reveal">
						<p className="eyebrow mono">02 // THREE_DESKS</p>
						<h2>Portal · Configure · Operate</h2>
						<p>Marketing is the promise. These desks are how the day runs.</p>
					</header>
					<div className="desks">
						<article className="glass hard reveal" data-d={0}>
							<span className="mono">A · CONTROL</span>
							<h3>Portal</h3>
							<p>Website, place products, mint the developer pack. No live queues.</p>
						</article>
						<article className="glass hard reveal" data-d={1}>
							<span className="mono">B · SETUP</span>
							<h3>Configure</h3>
							<p>Product dashboards — settings and texts, never the firehose.</p>
						</article>
						<article className="glass hard hot reveal" data-d={2}>
							<span className="mono">C · DAY</span>
							<h3>Pocket Operate</h3>
							<p>Needs you. Staff + owner. Act → done.</p>
						</article>
					</div>
					<aside className="pack glass hard reveal">
						<div className="pack-top">
							<span className="mono">DEVELOPER_PACK</span>
							<span className="mono">one JSON · RIFT</span>
						</div>
						<pre>
							<code>{`{
  "domain": "store.example",
  "products": [{
    "id": "ecommerce",
    "docs": "…/docs",
    "browserToken": "…",
    "serverToken": "…"
  }]
}`}</code>
						</pre>
						<p>Builders get tokens + docs once. Merchants never paste secrets into six dashboards.</p>
					</aside>
				</section>

				<section id="stack" className="block">
					<header className="block-head reveal">
						<p className="eyebrow mono">03 // STACK</p>
						<h2>Placed on the website — not installed from a store</h2>
						<p>Six first-party products. Region packs for rails — not forks.</p>
					</header>
					<div className="products">
						{[
							['01', 'Accounts', 'Roles · staff · phone'],
							['02', 'Ecommerce', 'Catalog → returns'],
							['03', 'Payments', 'Local + international'],
							['04', 'Chat', 'Inbox on the phone'],
							['05', 'Notifications', 'WA · SMS · email · push'],
							['06', 'Growth', 'Pixels · SEO · consent'],
						].map(([n, title, blurb], i) => (
							<article key={n} className="glass hard reveal" data-d={i}>
								<span className="mono">{n}</span>
								<h3>{title}</h3>
								<p>{blurb}</p>
							</article>
						))}
					</div>
					<div className="streams">
						<article className="glass hard reveal" data-d={0}>
							<header className="mono">STREAM // ORDERS</header>
							<p className="num">{orders}</p>
							<p className="meta">open · last 24h</p>
							<button type="button" onClick={() => setLive((L) => ({ ...L, orders: !L.orders }))}>
								{live.orders ? 'toggle live' : 'paused'}
							</button>
						</article>
						<article className="glass hard reveal" data-d={1}>
							<header className="mono">STREAM // CHAT</header>
							<p className="num">{chats}</p>
							<p className="meta">waiting · staff</p>
							<button type="button" onClick={() => setLive((L) => ({ ...L, chats: !L.chats }))}>
								{live.chats ? 'toggle live' : 'paused'}
							</button>
						</article>
						<article className="glass hard reveal" data-d={2}>
							<header className="mono">REGION</header>
							<div className="pills">
								<button
									type="button"
									className={`pill${region === 'local' ? ' on' : ''}`}
									onClick={() => setRegion('local')}>
									local
								</button>
								<button
									type="button"
									className={`pill${region === 'intl' ? ' on' : ''}`}
									onClick={() => setRegion('intl')}>
									intl
								</button>
							</div>
							<p className="mono meta">{PACKS[region]}</p>
						</article>
					</div>
				</section>

				<section id="plan" className="block band">
					<header className="block-head reveal">
						<p className="eyebrow mono">04 // PLAN_RAIL · RIFT</p>
						<h2>Land cheap. Full still under the real bill.</h2>
						<p>Slider and rail are one instrument — same panel.</p>
					</header>
					<div className="plan glass hard reveal">
						<div className="slider-wrap">
							<input
								type="range"
								min={0}
								max={2}
								step={1}
								value={tier}
								aria-label="Pricing tier"
								onChange={(e) => pickTier(Number(e.target.value))}
							/>
							<div className="tier-labels">
								<span>Start $19</span>
								<span>Run $49</span>
								<span>Full $99</span>
							</div>
						</div>
						<div className="rail" role="list">
							{[
								['START', 'land under Basic'],
								['RUN', 'operate day-to-day'],
								['FULL', 'whole OS'],
							].map(([label, em], i) => (
								<button
									key={label}
									type="button"
									className={`stop${tier === i ? ' on' : ''}`}
									onClick={() => pickTier(i)}>
									<span className="dot" />
									<strong>{label}</strong>
									<em>{em}</em>
								</button>
							))}
						</div>
						<div className={`plan-panel${swap ? ' swap' : ''}`}>
							<div className="plan-price">
								<span>{panel.t}</span>
								<b>{panel.price}</b>
								<small>/mo</small>
							</div>
							<p>{panel.d}</p>
							<ul>
								{panel.items.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
							<Link className="btn dark" href="/login">
								Continue with this plan
							</Link>
						</div>
					</div>
				</section>
			</main>

			<footer className="reveal">
				<div>
					<strong>{brandName}</strong>
					<span className="mono">PORTAL SITE · UNITE</span>
				</div>
				<Link href="/login">Sign in →</Link>
			</footer>
		</>
	);
}
