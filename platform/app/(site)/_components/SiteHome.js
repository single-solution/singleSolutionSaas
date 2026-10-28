'use client';

import Link from 'next/link.js';
import { ButtonLink } from '@ss/ui';
import { useEffect, useState } from 'react';

/**
 * Plain lines for known products; catalog description / name otherwise.
 * New products appear automatically — this map is optional enrichment only.
 * @type {Record<string, { name: string, blurb: string, more: string, for: string, gets: string[], use: string }>}
 */
const PRODUCT_COPY = {
	accounts: {
		name: 'Accounts',
		blurb: 'Sign-in & staff access',
		more: 'Let people sign in, manage roles, and give your team the right access.',
		for: 'Any site that needs members, staff, or protected pages.',
		gets: [
			'Visitor sign-in on your pages',
			'Roles and staff invites in Portal',
			'My Account surfaces for members',
			'Configure methods without a custom auth stack',
		],
		use: 'Place once. Visitors sign in on your frontend; you manage staff in the Portal.',
	},
	ecommerce: {
		name: 'Ecommerce',
		blurb: 'Catalog, cart & orders',
		more: 'Sell online when you need it — catalog, checkout, orders, and returns.',
		for: 'Merchants who sell goods or services — optional, not required.',
		gets: ['Catalog and categories', 'Cart and checkout', 'Orders and returns', 'Shop widgets for your frontend'],
		use: 'Turn on when you sell. Skip it if your site is services, community, or content.',
	},
	payments: {
		name: 'Payments',
		blurb: 'Take payments',
		more: 'Accept payments your way — wallets, cards, links, and proofs on the same site.',
		for: 'Anyone who needs to collect money on the website.',
		gets: ['Payment links and checkout', 'Wallets and cards you configure', 'Proof review for staff', 'Same-site pay flows'],
		use: 'Configure providers in Portal. Your frontend shows the pay flow; staff clear reviews on the site.',
	},
	chat: {
		name: 'Chat',
		blurb: 'Talk to visitors',
		more: 'Live chat on your site, with help from AI when you want it and a human when you need it.',
		for: 'Sites that answer questions before and after someone buys or signs up.',
		gets: ['Visitor chat widget', 'Inbox for your team', 'AI replies when enabled', 'Handoff to humans'],
		use: 'Drop the widget on your pages. Reply from the live site — same product your visitors use.',
	},
	notifications: {
		name: 'Notifications',
		blurb: 'Reach people',
		more: 'WhatsApp, SMS, email, and push — updates and alerts without bolting on another tool.',
		for: 'Merchants who need status updates, alerts, and reminders to customers or staff.',
		gets: ['WhatsApp, SMS, email, push', 'Sending policy you control', 'Templates', 'Caps and quiet hours'],
		use: 'Connect channels once. Products and your flows send through the same stack.',
	},
	growth: {
		name: 'Growth',
		blurb: 'Measure & grow',
		more: 'Consent, tags, SEO, and analytics that stay with your website.',
		for: 'Anyone who wants consent, SEO, and analytics without a bolt-on maze.',
		gets: ['Consent and tags', 'SEO helpers', 'Analytics hooks', 'Stays with the website'],
		use: 'Enable on the website. Keep measurement next to the products that already run there.',
	},
};

const WORK = [
	{
		k: 'Portal',
		t: 'Control the website',
		d: 'Claim sites, place products, invite staff, share one pack with whoever builds the frontend.',
	},
	{
		k: 'Configure',
		t: 'Shape each product',
		d: 'Features, texts, and connections — how the product behaves for your visitors.',
	},
	{
		k: 'Operate',
		t: 'Run on the live site',
		d: 'Tickets, chat, payments, and day work happen on the site with your team — not a separate admin stack to invent.',
	},
	{
		k: 'Docs',
		t: 'Builder-ready',
		d: 'Public guides, OpenAPI, and widgets. Merchants keep secrets in the pack.',
	},
];

const FAQ = [
	{
		q: 'Do I need every product?',
		a: 'No. Place only what the site needs. Add more later.',
	},
	{
		q: 'Only for online shops?',
		a: 'No. Ecommerce is optional. Products define what the site can do.',
	},
	{
		q: 'Who builds the look?',
		a: 'You or your developer own the frontend. We ship the features behind it.',
	},
];

const SCREENS = [
	{
		id: 'portal',
		label: 'Portal',
		path: 'portal · websites',
		side: ['Overview', 'Websites', 'Credits', 'Account'],
		sideOn: 1,
		title: 'Your website home',
		lede: 'Add products, open configure, share one pack with your developer.',
		cards: [
			{ b: 'Site', s: 'live' },
			{ b: 'Products', s: 'placed' },
			{ b: 'Staff', s: 'invited' },
		],
		rows: [
			{ k: 'Add', t: 'Products on this website', e: '→' },
			{ k: 'Share', t: 'Developer pack (one file)', e: '→' },
			{ k: 'Open', t: 'Configure a product', e: '→' },
		],
	},
	{
		id: 'settings',
		label: 'Configure',
		path: 'configure · product',
		side: ['Features', 'Texts', 'Connections', 'Lists'],
		sideOn: 0,
		title: 'Product settings',
		lede: 'Switch features on, edit texts, connect providers.',
		cards: [
			{ b: 'On', s: 'features' },
			{ b: 'Edit', s: 'texts' },
			{ b: 'Link', s: 'providers' },
		],
		rows: [
			{ k: 'On', t: 'Core features for this product', e: 'edit' },
			{ k: 'Text', t: 'Labels visitors see', e: 'edit' },
			{ k: 'Conn', t: 'Providers when needed', e: 'link' },
		],
	},
	{
		id: 'operate',
		label: 'On site',
		path: 'site · operate',
		side: ['Inbox', 'Orders', 'Payments', 'Team'],
		sideOn: 0,
		title: 'Operate on the live site',
		lede: 'Staff work where the product runs — chat, payments, day tasks on the website.',
		cards: [
			{ b: 'Chat', s: 'open' },
			{ b: 'Pay', s: 'review' },
			{ b: 'Task', s: 'now' },
		],
		rows: [
			{ k: 'Chat', t: 'Visitor waiting for a reply', e: '2m' },
			{ k: 'Pay', t: 'Payment to confirm', e: '5m' },
			{ k: 'Team', t: 'Staff on the same site', e: '→' },
		],
	},
	{
		id: 'docs',
		label: 'Docs',
		path: 'docs · hub',
		side: ['Guides', 'OpenAPI', 'Widgets', 'Quickstart'],
		sideOn: 0,
		title: 'Public Docs hub',
		lede: 'Builders get guides and specs without a Portal login. Secrets stay in the pack.',
		cards: [
			{ b: 'All', s: 'products' },
			{ b: 'API', s: 'openapi' },
			{ b: 'UI', s: 'widgets' },
		],
		rows: [
			{ k: 'Guide', t: 'How to place a product', e: 'read' },
			{ k: 'API', t: 'OpenAPI for each product', e: 'json' },
			{ k: 'Widget', t: 'Script URL when you need it', e: 'link' },
		],
	},
];

const pad = (n) => String(n).padStart(2, '0');

/**
 * @typedef {{ id: string, name: string, description?: string }} MarketingProduct
 */

/**
 * Public marketing home — four-beat portfolio, product-honest.
 * @param {{ brandName?: string, products?: MarketingProduct[] }} props
 */
export function SiteHome({ brandName = 'Single Solution', products = [] }) {
	const [scrolled, setScrolled] = useState(false);
	const [clock, setClock] = useState('00:00:00');
	const [screen, setScreen] = useState(0);
	const [spotId, setSpotId] = useState('');
	const shot = SCREENS[screen];

	const fromApi = products.filter((p) => p.id && p.name);
	const catalog =
		fromApi.length > 0
			? fromApi
			: Object.entries(PRODUCT_COPY).map(([id, copy]) => ({
					id,
					name: copy.name || id,
					description: copy.more,
				}));

	const activeId = spotId && catalog.some((p) => p.id === spotId) ? spotId : catalog[0]?.id || '';
	const active = catalog.find((p) => p.id === activeId);
	const activeCopy = active ? PRODUCT_COPY[active.id] : null;
	const marquee = catalog.map((p) => p.name).concat(['Portal', 'Docs', 'Developer pack']);

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
			{ threshold: 0.08, rootMargin: '0px 0px -4% 0px' },
		);
		nodes.forEach((el) => io.observe(el));
		return () => io.disconnect();
	}, [catalog.length]);

	return (
		<>
			<div className="wash" aria-hidden="true" />
			<div className="grid-hard" aria-hidden="true" />
			<div className="signal" aria-hidden="true">
				<i />
			</div>

			<div className={`nav-shell${scrolled ? ' is-scrolled' : ''}`}>
				<header className="nav glass">
					<a className="brand" href="#top">
						{brandName}
					</a>
					<nav aria-label="Account">
						<Link href="/docs">Docs</Link>
					</nav>
					<Link className="cta" href="/login">
						Sign in
					</Link>
				</header>
			</div>

			<main id="top">
				<section className="hero">
					<div className="hero-copy reveal">
						<p className="live">
							<span /> {brandName}
						</p>
						<h1>
							Build your frontend.
							<br />
							<span className="accent">We ship the features behind it.</span>
						</h1>
						<p className="lede">
							Your site. Our products. One Portal — so you never invent the backend from scratch.
						</p>
						<div className="hero-actions">
							<a className="text-link" href="#why">
								See why →
							</a>
							<a className="text-link" href="#products">
								See products →
							</a>
						</div>
					</div>

					<div className="hero-stage glass reveal" data-d={1} aria-hidden="true">
						<div className="stage-chrome">
							<span className="mono">how it fits</span>
							<span className="mono">{clock}</span>
						</div>
						<div className="fit-body">
							<div className="fit-col">
								<p className="label">You build</p>
								<div className="fit-card">
									<span className="fit-bar" />
									<span className="fit-bar short" />
									<span className="fit-bar mid" />
									<strong>Your frontend</strong>
									<em>Design and pages you own</em>
								</div>
							</div>
							<div className="fit-vs mono">+</div>
							<div className="fit-col">
								<p className="label">We provide</p>
								<div className="fit-card hot">
									<ul>
										<li>Ready products</li>
										<li>APIs & widgets</li>
										<li>Portal · staff · pack</li>
										<li>Public Docs hub</li>
									</ul>
								</div>
							</div>
						</div>
						<p className="fit-foot mono">Place products · share a pack · run the site</p>
					</div>
				</section>

				<div className="marquee" aria-hidden="true">
					<div className="track">
						{[...marquee, ...marquee].map((t, i) => (
							<span key={`${t}-${i}`}>{t}</span>
						))}
					</div>
				</div>

				<section id="why" className="block">
					<header className="block-head reveal">
						<p className="eyebrow mono">01 // WHY</p>
						<h2>
							Stop rebuilding the hard parts.
							<span className="accent"> Ship your site.</span>
						</h2>
						<p>
							Accounts, payments, chat, messages, and admin tooling eat months. {brandName} ships them as products on
							your website — your effort goes into what customers see.
						</p>
					</header>
					<div className="why-split reveal">
						<article className="glass hard burden">
							<span className="mono muted">Build it yourself</span>
							<p>
								You own every layer — auth, payments, chat, admin, staff, docs handoff. Time, risk, and upkeep stay on
								you.
							</p>
						</article>
						<div className="vs mono">VS</div>
						<article className="glass hard hot">
							<span className="mono lime">With {brandName}</span>
							<p>You build the frontend. We ship the products, Portal, and one pack for your builder.</p>
						</article>
					</div>
					<div className="table cols-3 compare glass hard reveal">
						<div className="row head">
							<span>What you need</span>
							<span>If you build it yourself</span>
							<span>With {brandName}</span>
						</div>
						<div className="row">
							<span>Accounts, payments, chat, messages…</span>
							<span className="no">You design, build, host, and maintain each one</span>
							<span className="ok">Place ready products on the site</span>
						</div>
						<div className="row">
							<span>Somewhere to run the business</span>
							<span className="no">You invent dashboards and keep them alive</span>
							<span className="ok">Portal for websites, staff, and products</span>
						</div>
						<div className="row">
							<span>Team access</span>
							<span className="no">Custom roles — you own the bugs and edge cases</span>
							<span className="ok">Staff invites and access built in</span>
						</div>
						<div className="row">
							<span>Handing work to a developer</span>
							<span className="no">Keys and notes scattered in chat and files</span>
							<span className="ok">One pack + public Docs hub</span>
						</div>
						<div className="row">
							<span>Day-to-day work</span>
							<span className="no">Another admin stack to buy or build</span>
							<span className="ok">Operate on the live site with your team</span>
						</div>
						<div className="row">
							<span>Growing later</span>
							<span className="no">You rebuild or rewire when needs change</span>
							<span className="ok">Add products when you need them</span>
						</div>
						<div className="row burden-foot">
							<span>Who carries the load</span>
							<span className="no">You — every integration, every release</span>
							<span className="ok">Shared — you own the frontend; we own the platform</span>
						</div>
					</div>
				</section>

				<section id="products" className="block band">
					<header className="block-head reveal">
						<p className="eyebrow mono">02 // PRODUCTS</p>
						<h2>Turn on what the site needs.</h2>
						<p>
							Optional building blocks for shops, services, or communities — not locked to one industry. Select a
							product for detail.
						</p>
					</header>

					<div className="products reveal">
						{catalog.map((p, i) => {
							const copy = PRODUCT_COPY[p.id];
							const blurb = copy?.blurb || 'Ready on your website';
							return (
								<button
									key={p.id}
									type="button"
									className={`glass hard product-card${activeId === p.id ? ' on' : ''}`}
									onClick={() => setSpotId(p.id)}
									aria-pressed={activeId === p.id}>
									<span className="mono">{String(i + 1).padStart(2, '0')}</span>
									<h3>{p.name}</h3>
									<p>{blurb}</p>
								</button>
							);
						})}
					</div>

					{active ? (
						<div className="spot split reveal" key={active.id}>
							<div className="split-copy">
								<p className="eyebrow mono">{active.name}</p>
								<h3>{activeCopy?.blurb || active.name}</h3>
								<p>{activeCopy?.more || active.description || `Add ${active.name} when you need it.`}</p>
								{activeCopy?.for ? (
									<p className="spot-for">
										<span className="mono">For</span> {activeCopy.for}
									</p>
								) : null}
								{activeCopy?.use ? (
									<p className="spot-use">
										<span className="mono">Use</span> {activeCopy.use}
									</p>
								) : null}
								<Link className="product-docs" href={`/docs/${active.id}`}>
									Open {active.name} docs →
								</Link>
							</div>
							<div className="table cols-1 glass hard">
								<div className="row head">
									<span>What you actually get</span>
								</div>
								{(activeCopy?.gets || ['Ready features', 'Portal configure', 'Docs & widgets']).map((g) => (
									<div className="row" key={g}>
										<span>{g}</span>
									</div>
								))}
							</div>
						</div>
					) : null}
				</section>

				<section id="work" className="block">
					<header className="block-head reveal">
						<p className="eyebrow mono">03 // WHERE YOU WORK</p>
						<h2>Portal, configure, operate on site, docs.</h2>
						<p>Illustrated surfaces — same Unite craft as the product. The pack is how builders start.</p>
					</header>

					<div className="desks reveal">
						{WORK.map((r) => (
							<article key={r.k} className="glass hard">
								<span className="mono">{r.k}</span>
								<h3>{r.t}</h3>
								<p>{r.d}</p>
							</article>
						))}
					</div>

					<div className="pack glass hard reveal">
						<div className="pack-top">
							<span className="mono">developer pack</span>
							<span className="mono">one handoff</span>
						</div>
						<pre>{`docsHubUrl
domain
products[]: id, docs, openapi, widget,
            browserToken, serverToken,
            featuresOn
secrets stay in the pack
frontend: you build`}</pre>
						<div>
							<p className="eyebrow mono">Builder handoff</p>
							<h3 className="pack-h">One file. Public docs. No backend project.</h3>
							<p>
								Share the pack from Portal. Builders follow the Docs hub. You keep credentials out of chat threads.
							</p>
							<div className="hero-actions">
								<ButtonLink href="/docs" variant="secondary" size="md">
									Browse docs
								</ButtonLink>
							</div>
						</div>
					</div>

					<div className="reveal" style={{ marginTop: '1.5rem' }}>
						<p className="eyebrow mono" style={{ marginBottom: '0.65rem' }}>
							Illustrated · not live screenshots
						</p>
						<div className="shot-tabs" role="tablist" aria-label="Product surfaces">
							{SCREENS.map((s, i) => (
								<button
									key={s.id}
									type="button"
									role="tab"
									aria-selected={screen === i}
									className={`shot-tab${screen === i ? ' on' : ''}`}
									onClick={() => setScreen(i)}>
									{s.label}
								</button>
							))}
						</div>
						<div className="shot-frame glass hard" role="tabpanel">
							<div className="shot-chrome">
								<i />
								<i />
								<i />
								<span className="mono">{shot.path}</span>
								<span className="mono" style={{ marginLeft: 'auto' }}>
									{clock}
								</span>
							</div>
							<div className="shot-body">
								<aside className="shot-side">
									<p>Nav</p>
									<ul>
										{shot.side.map((item, i) => (
											<li key={item} className={i === shot.sideOn ? 'on' : undefined}>
												{item}
											</li>
										))}
									</ul>
								</aside>
								<div className="shot-main">
									<h4>{shot.title}</h4>
									<p className="shot-lede">{shot.lede}</p>
									<div className="shot-grid">
										{shot.cards.map((c) => (
											<div key={c.s} className="shot-card">
												<b>{c.b}</b>
												<span>{c.s}</span>
											</div>
										))}
									</div>
									<div className="shot-rows">
										{shot.rows.map((r) => (
											<div key={r.t} className="shot-row">
												<b>{r.k}</b>
												<span>{r.t}</span>
												<em>{r.e}</em>
											</div>
										))}
									</div>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section id="start" className="block band close-band">
					<header className="block-head reveal">
						<p className="eyebrow mono">04 // START</p>
						<h2>Sign in. Place products. Share a pack.</h2>
						<p>Then build the frontend and run the day on the live site.</p>
					</header>
					<div className="table cols-2 glass hard reveal">
						<div className="row head">
							<span>Question</span>
							<span>Answer</span>
						</div>
						{FAQ.map((f) => (
							<div className="row" key={f.q}>
								<span>{f.q}</span>
								<span>{f.a}</span>
							</div>
						))}
					</div>
					<div className="close-inner reveal">
						<h2>Ready when you are.</h2>
						<p>
							{brandName} is the prebuilt platform behind your frontend — products, Portal, and docs. Plans follow your
							account.
						</p>
						<div className="hero-actions">
							<ButtonLink href="/login" variant="primary" size="lg">
								Sign in
							</ButtonLink>
							<ButtonLink href="/docs" variant="secondary" size="lg">
								Browse docs
							</ButtonLink>
						</div>
					</div>
				</section>
			</main>

			<footer className="reveal">
				<div>
					<strong>{brandName}</strong>
					<span className="mono">Portal · Products · Docs · Pack</span>
				</div>
				<nav aria-label="Footer">
					<a href="#products">Products</a>
					<Link href="/docs">Docs</Link>
					<Link href="/login">Sign in</Link>
				</nav>
			</footer>
		</>
	);
}
