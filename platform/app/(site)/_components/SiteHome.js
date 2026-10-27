'use client';

import Link from 'next/link.js';
import { useEffect, useState } from 'react';

const PACKS = {
	local: 'JazzCash · EasyPaisa · WhatsApp',
	intl: 'Cards · PayPal · Email',
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * Public marketing home — Unite layout, plain language for merchants and builders, no competitor brands, no fixed prices.
 * @param {{ brandName?: string }} props
 */
export function SiteHome({ brandName = 'Single Solution' }) {
	const [scrolled, setScrolled] = useState(false);
	const [clock, setClock] = useState('00:00:00');
	const [counts, setCounts] = useState({ products: 0, website: 0, tax: 0, desks: 0 });
	const [orders, setOrders] = useState(128);
	const [chats, setChats] = useState(14);
	const [live, setLive] = useState({ orders: true, chats: true });
	const [region, setRegion] = useState('local');
	const [welcomeDone, setWelcomeDone] = useState(false);
	const [email, setEmail] = useState('');

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
						<a href="#why">Why us</a>
						<a href="#how">How it works</a>
						<a href="#tools">Tools</a>
						<a href="#start">Get started</a>
					</nav>
					<Link className="cta" href="/login">
						Sign in
					</Link>
				</header>
			</div>

			<main>
				<section className="hero">
					<div className="hero-copy reveal">
						<p className="live">
							<span /> For online sellers · Pakistan · UAE · Europe · US
						</p>
						<h1>
							Everything you need to run an online shop —
							<br />
							<span className="accent">in one place.</span>
						</h1>
						<p className="lede">
							{brandName} gives you a website, the tools that sell (shop, pay, chat, messages), and a phone app for
							today&apos;s orders. You add tools to your site once. Your developer connects them with one file. You
							and your staff handle the day from the phone.
						</p>
						<div className="hero-actions">
							<a className="btn" href="#why">
								See how we differ
							</a>
							<a className="text-link" href="#how">
								How it works →
							</a>
						</div>
						<div className="metrics">
							<div className="metric glass reveal" data-d={0}>
								<b>{counts.products}</b>
								<span>built-in tools</span>
							</div>
							<div className="metric glass reveal" data-d={1}>
								<b>{counts.website}</b>
								<span>website to manage</span>
							</div>
							<div className="metric glass reveal" data-d={2}>
								<b>{counts.tax}</b>
								<span>extra app bills</span>
							</div>
							<div className="metric glass reveal" data-d={3}>
								<b>{counts.desks}</b>
								<span>places to work</span>
							</div>
						</div>
					</div>

					<div className="hero-stage glass reveal" data-d={1}>
						<div className="stage-chrome">
							<span>Today on your phone</span>
							<span>{clock}</span>
						</div>
						<div className="stage-body">
							<div className="needs">
								<p className="label">Tap to finish</p>
								<ul id="needs">
									<li className="in">
										<span className="task-kind order">Order</span>
										<span>Confirm cash on delivery — ₨12,400</span>
										<em>Now</em>
									</li>
									<li className="in">
										<span className="task-kind chat">Chat</span>
										<span>3 customers waiting for a reply</span>
										<em>2 min</em>
									</li>
									<li className="in">
										<span className="task-kind pay">Pay</span>
										<span>Check a payment screenshot</span>
										<em>5 min</em>
									</li>
									<li className="in">
										<span className="task-kind stock">Stock</span>
										<span>3 products almost sold out</span>
										<em>12 min</em>
									</li>
									<li className="in">
										<span className="task-kind msg">Message</span>
										<span>WhatsApp failed — send again</span>
										<em>18 min</em>
									</li>
								</ul>
							</div>
							<div className="term">
								<p className="label">New here?</p>
								{welcomeDone ? (
									<div className="welcome-done" role="status">
										<p className="welcome-title">You are set</p>
										<ul>
											<li>Account ready</li>
											<li>Website ready to manage</li>
											<li>Phone app ready for today&apos;s work</li>
										</ul>
										<Link className="btn dark" href="/login">
											Open Portal
										</Link>
									</div>
								) : (
									<>
										<p className="welcome-lead">Enter your work email to see how starting looks.</p>
										<form
											id="wizard"
											onSubmit={(e) => {
												e.preventDefault();
												setWelcomeDone(true);
												setEmail('');
											}}>
											<label>
												Your work email
												<input
													name="email"
													type="email"
													placeholder="you@yourshop.com"
													autoComplete="email"
													value={email}
													onChange={(e) => setEmail(e.target.value)}
													required
												/>
											</label>
											<button type="submit">Show me →</button>
										</form>
									</>
								)}
							</div>
						</div>
					</div>
				</section>

				<div className="marquee" aria-hidden="true">
					<div className="track">
						{[
							'Orders',
							'Chat',
							'Payments',
							'WhatsApp',
							'Your website',
							'Phone for staff',
							'Team logins',
							'Sales & stock',
						]
							.concat([
								'Orders',
								'Chat',
								'Payments',
								'WhatsApp',
								'Your website',
								'Phone for staff',
								'Team logins',
								'Sales & stock',
							])
							.map((t, i) => (
								<span key={`${t}-${i}`}>{t}</span>
							))}
					</div>
				</div>

				<section id="why" className="block">
					<header className="block-head reveal">
						<p className="eyebrow">01 · Why this</p>
						<h2>
							A shop page is not enough. <span className="accent">You still need the rest.</span>
						</h2>
						<p>
							Most platforms give you a storefront. Chat, WhatsApp, local payments, and staff phone work usually
							mean more apps, more logins, more bills. {brandName} builds those into one system on your website.
						</p>
					</header>
					<div className="why-split reveal">
						<article className="glass hard">
							<span className="muted">Store only</span>
							<p>
								You get a catalog and checkout. Chat, messages, local pay, and phone work? You buy those
								separately and glue them together.
							</p>
						</article>
						<div className="vs">VS</div>
						<article className="glass hard hot">
							<span className="lime">{brandName}</span>
							<p>
								Six tools on your website, one login to manage them, and a phone app for live orders and chats —
								built to work together.
							</p>
						</article>
					</div>
					<div className="table glass hard reveal">
						<div className="row head">
							<span>What you need</span>
							<span>Store alone</span>
							<span>{brandName}</span>
							<span>Store + many apps</span>
						</div>
						<div className="row">
							<span>Online shop</span>
							<span className="ok">Yes</span>
							<span className="ok">Yes</span>
							<span className="ok">Yes</span>
						</div>
						<div className="row">
							<span>Local &amp; card payments</span>
							<span className="no">Often missing</span>
							<span className="ok">Included</span>
							<span className="mid">Extra apps</span>
						</div>
						<div className="row">
							<span>Customer chat</span>
							<span className="no">No</span>
							<span className="ok">Included</span>
							<span className="mid">Extra app</span>
						</div>
						<div className="row">
							<span>WhatsApp / SMS / email</span>
							<span className="no">No</span>
							<span className="ok">Included</span>
							<span className="mid">Extra apps</span>
						</div>
						<div className="row">
							<span>Phone app for staff</span>
							<span className="no">No</span>
							<span className="ok">Included</span>
							<span className="mid">Usually separate</span>
						</div>
						<div className="row">
							<span>How you pay for it</span>
							<span className="mid">Store + apps</span>
							<span className="ok">One platform</span>
							<span className="no">Many vendors</span>
						</div>
					</div>
				</section>

				<section id="how" className="block band">
					<header className="block-head reveal">
						<p className="eyebrow">02 · How it works</p>
						<h2>Three places. Clear jobs.</h2>
						<p>
							Sign in → manage your website → turn tools on → share a file with your developer → run the day on
							your phone.
						</p>
					</header>
					<div className="desks">
						<article className="glass hard reveal" data-d={0}>
							<span className="desk-step">1 · Manage</span>
							<h3>Portal</h3>
							<p>
								Your control screen. Add a website, turn tools on or off, invite staff, and download the file your
								developer needs. No order queue here.
							</p>
						</article>
						<article className="glass hard reveal" data-d={1}>
							<span className="desk-step">2 · Set up</span>
							<h3>Configure</h3>
							<p>
								Each tool has its own settings screen — texts, options, branding. Change how it works, not the live
								queue of customers.
							</p>
						</article>
						<article className="glass hard hot reveal" data-d={2}>
							<span className="desk-step">3 · Today</span>
							<h3>Phone app (Operate)</h3>
							<p>
								Where you and staff work during the day: confirm orders, answer chat, check payments. Open a task,
								finish it, move on.
							</p>
						</article>
					</div>
					<aside className="pack glass hard reveal">
						<div className="pack-top">
							<span>For your web developer</span>
							<span>Simple hand-off</span>
						</div>
						<div className="share-card">
							<div className="share-file">
								<span className="share-icon">file</span>
								<div>
									<strong>shop-setup</strong>
									<em>One download from the Portal</em>
								</div>
							</div>
							<ol className="share-steps">
								<li>
									<strong>You download</strong>
									<span>from the Portal</span>
								</li>
								<li>
									<strong>You send it</strong>
									<span>to your developer</span>
								</li>
								<li>
									<strong>They connect</strong>
									<span>your shop tools</span>
								</li>
							</ol>
						</div>
						<p>
							You do not paste passwords into many screens. One file holds what your developer needs to connect the
							shop. You keep running the business from the Portal and the phone app.
						</p>
					</aside>
				</section>

				<section id="tools" className="block">
					<header className="block-head reveal">
						<p className="eyebrow">03 · Tools</p>
						<h2>Six tools you turn on for your website</h2>
						<p>
							They are ours — not a third-party app store. Pick local or international payment and message options;
							same platform either way.
						</p>
					</header>
					<div className="products">
						{[
							['01', 'Accounts', 'Staff logins, roles, and phone access'],
							['02', 'Ecommerce', 'Catalog, cart, orders, and returns'],
							['03', 'Payments', 'Local wallets and international cards'],
							['04', 'Chat', 'Customer inbox on desktop and phone'],
							['05', 'Notifications', 'WhatsApp, SMS, email, and push'],
							['06', 'Growth', 'Tracking pixels, SEO helpers, consent'],
						].map(([n, title, blurb], i) => (
							<article key={n} className="glass hard reveal" data-d={i}>
								<span className="tool-n">{n}</span>
								<h3>{title}</h3>
								<p>{blurb}</p>
							</article>
						))}
					</div>
					<div className="streams">
						<article className="glass hard reveal" data-d={0}>
							<header>Open orders</header>
							<p className="num">{orders}</p>
							<p className="meta">last 24 hours</p>
							<button type="button" onClick={() => setLive((L) => ({ ...L, orders: !L.orders }))}>
								{live.orders ? 'Pause demo' : 'Resume demo'}
							</button>
						</article>
						<article className="glass hard reveal" data-d={1}>
							<header>Waiting chats</header>
							<p className="num">{chats}</p>
							<p className="meta">for your staff</p>
							<button type="button" onClick={() => setLive((L) => ({ ...L, chats: !L.chats }))}>
								{live.chats ? 'Pause demo' : 'Resume demo'}
							</button>
						</article>
						<article className="glass hard reveal" data-d={2}>
							<header>Your region</header>
							<div className="pills">
								<button
									type="button"
									className={`pill${region === 'local' ? ' on' : ''}`}
									onClick={() => setRegion('local')}>
									Local
								</button>
								<button
									type="button"
									className={`pill${region === 'intl' ? ' on' : ''}`}
									onClick={() => setRegion('intl')}>
									International
								</button>
							</div>
							<p className="meta">{PACKS[region]}</p>
						</article>
					</div>
				</section>

				<section id="start" className="block band">
					<header className="block-head reveal">
						<p className="eyebrow">04 · Get started</p>
						<h2>Sign in when you are ready.</h2>
						<p>
							Pricing follows your account — there is no fixed public price list here. Once you have access, open
							the Portal, add tools to your website, and use the phone app for the day.
						</p>
					</header>
					<div className="plan glass hard reveal">
						<div className="rail" role="list">
							{[
								['Portal', 'Website, tools, and team'],
								['Tools', 'Turn on · set up · share'],
								['Phone', 'Orders and chats today'],
							].map(([label, em]) => (
								<div key={label} className="stop on" role="listitem">
									<span className="dot" />
									<strong>{label}</strong>
									<em>{em}</em>
								</div>
							))}
						</div>
						<div className="plan-panel">
							<p id="pd">
								One login for the shop owner. Six tools on the website. Live work stays in the phone app — not
								spread across many vendor screens.
							</p>
							<ul id="pl">
								<li>Portal — manage the website and tools</li>
								<li>Configure — change settings and texts</li>
								<li>Phone app — handle today&apos;s work</li>
							</ul>
							<Link className="btn dark" href="/login">
								Sign in to the Portal
							</Link>
						</div>
					</div>
				</section>
			</main>

			<footer className="reveal">
				<div>
					<strong>{brandName}</strong>
					<span className="foot-tag">Website · Tools · Phone app</span>
				</div>
				<Link href="/login">Sign in →</Link>
			</footer>
		</>
	);
}
