'use client';

import Link from 'next/link.js';
import { ButtonLink } from '@ss/ui';
import { useEffect, useState } from 'react';
import { COMPANY_NAME, PRODUCT_BRAND, SiteFooter, SiteHeader } from './SiteNav.js';

export { COMPANY_NAME, PRODUCT_BRAND };

/**
 * Plain lines for known products; catalog description / name otherwise.
 * New products appear automatically — this map is optional enrichment only.
 * @type {Record<string, { name: string, blurb: string, more: string, for: string, gets: string[], use: string }>}
 */
const PRODUCT_COPY = {
	accounts: {
		name: 'Accounts',
		blurb: 'Visitors sign in. Your team gets access.',
		more: 'Members and staff on your website — without building sign-in from scratch.',
		for: 'Any site that needs logins, members, or staff.',
		gets: ['Sign-in on your pages', 'Staff invites and roles', 'My Account for members', 'Turn methods on when you need them'],
		use: 'Add it once. Visitors sign in on your site; you manage staff in your Shelfway account.',
	},
	ecommerce: {
		name: 'Ecommerce',
		blurb: 'Catalog, cart, and orders — when you sell.',
		more: 'Optional. Skip it if you are not selling online.',
		for: 'Anyone who sells goods or services on the website.',
		gets: ['Catalog and categories', 'Cart and checkout', 'Orders and returns', 'Shop pieces for your pages'],
		use: 'Turn on when you sell. Leave off for services, community, or content sites.',
	},
	payments: {
		name: 'Payments',
		blurb: 'Collect money on your website.',
		more: 'Payment links, wallets, cards, and proof checks — set up in your account.',
		for: 'Anyone who needs to take payment on the site.',
		gets: ['Payment links and checkout', 'Providers you connect', 'Proof review for staff', 'Pay steps on your pages'],
		use: 'Connect your payment providers. Your pages show the pay step; staff review on the site.',
	},
	chat: {
		name: 'Chat',
		blurb: 'Talk to visitors on your pages.',
		more: 'Live chat where people already are — with help from AI when you want it.',
		for: 'Sites that answer questions before or after someone buys or signs up.',
		gets: ['Chat on your pages', 'Inbox for your team', 'AI replies when enabled', 'Hand off to a person'],
		use: 'Add chat to your pages. Your team replies on the live site.',
	},
	notifications: {
		name: 'Notifications',
		blurb: 'Message people by WhatsApp, SMS, email, or push.',
		more: 'Updates and alerts from one place — not five separate tools.',
		for: 'Anyone who sends status, alerts, or reminders.',
		gets: ['WhatsApp, SMS, email, push', 'Sending rules you control', 'Templates', 'Caps and quiet hours'],
		use: 'Connect channels once. Your site features send through the same place.',
	},
	growth: {
		name: 'Growth',
		blurb: 'Consent, SEO, and site measurement.',
		more: 'Stay with this website — not a maze of extra tools.',
		for: 'Anyone who wants consent, SEO, and analytics together.',
		gets: ['Consent and tags', 'SEO helpers', 'Analytics hooks', 'Tied to this website'],
		use: 'Turn it on for the website. Measurement stays next to your other features.',
	},
};

const WORK_STEPS = [
	{
		n: '01',
		k: 'Your account',
		t: 'Manage the website',
		d: 'Add a site, turn features on, invite staff, and share setup with your developer.',
	},
	{
		n: '02',
		k: 'Settings',
		t: 'Adjust each feature',
		d: 'Choose what is on, edit the words visitors see, connect outside services.',
	},
	{
		n: '03',
		k: 'On your site',
		t: 'Do the daily work',
		d: 'Reply to chat, check payments, handle tasks — on the live website with your team.',
	},
];

const FAQ = [
	{
		q: 'What is Shelfway, in one line?',
		a: 'Ready website features (sign-in, payments, chat, and more) you turn on — you keep your own site design.',
	},
	{
		q: 'Do I need every feature?',
		a: 'No. Turn on only what this site needs. Add more later.',
	},
	{
		q: 'Is this only for online shops?',
		a: 'No. Selling online is optional. Use it for services, community, or content too.',
	},
	{
		q: 'Who builds how the site looks?',
		a: 'You or your developer. Shelfway provides the features behind those pages.',
	},
];

const COMPARE = [
	{
		need: 'Sign-in, payments, chat, messages…',
		diy: 'You build and maintain each one yourself',
		us: 'Turn on ready features for the site',
	},
	{
		need: 'A place to manage the business',
		diy: 'You invent your own admin tools',
		us: 'One account for sites, staff, and features',
	},
	{
		need: 'Team access',
		diy: 'You build roles and fix the edge cases',
		us: 'Invite staff with the right access',
	},
	{
		need: 'Working with a developer',
		diy: 'Passwords and notes scattered in chat',
		us: 'One share file plus public docs',
	},
	{
		need: 'Day-to-day work',
		diy: 'Yet another admin tool to buy or build',
		us: 'Work on the live site with your team',
	},
	{
		need: 'Growing later',
		diy: 'You rebuild when needs change',
		us: 'Add features when you need them',
	},
];

/**
 * @typedef {{ id: string, name: string, description?: string }} MarketingProduct
 */

/**
 * Public marketing home — plain first, craft second.
 * @param {{ productName?: string, companyName?: string, products?: MarketingProduct[] }} props
 */
export function SiteHome({ productName = PRODUCT_BRAND, companyName = COMPANY_NAME, products = [] }) {
	const [spotId, setSpotId] = useState('');

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
	const strip = catalog.map((p) => p.name);

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
			{ threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
		);
		nodes.forEach((el) => io.observe(el));
		return () => io.disconnect();
	}, [catalog.length]);

	return (
		<>
			<div className="wash" aria-hidden="true" />
			<div className="grid-hard" aria-hidden="true" />

			<SiteHeader brandName={productName} isHome={true} />

			<main id="top">
				<section className="hero">
					<div className="hero-copy reveal">
						<p className="byline">by {companyName}</p>
						<h1>
							Website features,
							<br />
							<span className="accent">already built for you.</span>
						</h1>
						<p className="lede">
							Sign-in, payments, chat, and more — on your site. You keep how it looks. {productName} provides the features.
							One account to manage it.
						</p>
						<div className="hero-actions">
							<a className="text-link" href="#products">
								See what you can add →
							</a>
							<a className="text-link muted-link" href="#why">
								Compare options →
							</a>
						</div>
					</div>

					<div className="hero-stage glass reveal" data-d={1} aria-hidden="true">
						<div className="stage-chrome">
							<span className="mono">in plain terms</span>
						</div>
						<div className="fit-body">
							<div className="fit-col">
								<p className="label">You keep</p>
								<div className="fit-card">
									<strong>Your website look</strong>
									<em>Pages and design you own</em>
								</div>
							</div>
							<div className="fit-vs mono">+</div>
							<div className="fit-col">
								<p className="label">We provide</p>
								<div className="fit-card hot">
									<ul>
										<li>Ready features</li>
										<li>Pieces for your pages</li>
										<li>Account for you and staff</li>
										<li>Docs for your developer</li>
									</ul>
								</div>
							</div>
						</div>
						<p className="fit-foot mono">Add features · share setup · run the site</p>
					</div>
				</section>

				<div className="product-strip" aria-hidden="true">
					<div className="product-strip-inner">
						{strip.map((name) => (
							<span key={name}>{name}</span>
						))}
					</div>
				</div>

				<section id="why" className="block">
					<header className="block-head reveal">
						<p className="eyebrow">Why not build it all yourself</p>
						<h2>
							Those features take months.
							<span className="accent"> {productName} already has them.</span>
						</h2>
						<p>
							Most teams spend forever on sign-in, payments, chat, and messages. With {productName} you turn those on for
							your website and spend time on what customers actually see.
						</p>
					</header>
					<div className="why-split reveal">
						<article className="glass hard burden">
							<span className="mono muted">Build it yourself</span>
							<p>Every layer stays on you: build, host, fix, and hand secrets around. Time and risk compound.</p>
						</article>
						<div className="vs mono">vs</div>
						<article className="glass hard hot">
							<span className="mono lime">With {productName}</span>
							<p>You keep the look. We provide the features, your account, and one share file for your developer.</p>
						</article>
					</div>
					<div className="compare-pair reveal">
						<div className="compare-card diy-card glass hard">
							<p className="compare-card-h mono">If you build it yourself</p>
							<ul>
								{COMPARE.map((row) => (
									<li key={`diy-${row.need}`}>
										<span className="mark" aria-hidden="true">
											✗
										</span>
										<div>
											<strong>{row.need}</strong>
											<p>{row.diy}</p>
										</div>
									</li>
								))}
							</ul>
						</div>
						<div className="compare-card us-card glass hard">
							<p className="compare-card-h mono">With {productName}</p>
							<ul>
								{COMPARE.map((row) => (
									<li key={`us-${row.need}`}>
										<span className="mark" aria-hidden="true">
											✓
										</span>
										<div>
											<strong>{row.need}</strong>
											<p>{row.us}</p>
										</div>
									</li>
								))}
							</ul>
						</div>
					</div>
				</section>

				<section id="products" className="block band">
					<header className="block-head reveal">
						<p className="eyebrow">What you can add</p>
						<h2>Pick the features this website needs.</h2>
						<p>
							Not only for shops — services, community, or content work too. Tap one to see what it includes and what you
							can customize.
						</p>
					</header>

					<div className="feature-stage reveal">
						<div className="feature-rail" role="tablist" aria-label="Features">
							{catalog.map((p, i) => {
								const copy = PRODUCT_COPY[p.id];
								const blurb = copy?.blurb || 'Ready on your website';
								return (
									<button
										key={p.id}
										type="button"
										role="tab"
										aria-selected={activeId === p.id}
										className={`feature-tab${activeId === p.id ? ' on' : ''}`}
										onClick={() => setSpotId(p.id)}>
										<span className="mono">{String(i + 1).padStart(2, '0')}</span>
										<span className="feature-tab-copy">
											<strong>{p.name}</strong>
											<em>{blurb}</em>
										</span>
									</button>
								);
							})}
						</div>

						{active ? (
							<div className="feature-panel glass hard" key={active.id}>
								<div className="feature-detail">
									<p className="eyebrow">Includes</p>
									<h3>{active.name}</h3>
									<p>{activeCopy?.more || active.description || `Add ${active.name} when you need it.`}</p>
									<ul className="gets">
										{(
											activeCopy?.gets || ['Ready on your site', 'Settings in your account', 'Docs for your developer']
										).map((g) => (
											<li key={g}>{g}</li>
										))}
									</ul>
									{activeCopy?.for ? (
										<p className="spot-for">
											<span className="mono">For</span> {activeCopy.for}
										</p>
									) : null}
									{activeCopy?.use ? (
										<p className="spot-use">
											<span className="mono">Customize</span> {activeCopy.use}
										</p>
									) : null}
									<Link className="product-docs" href="/docs">
										{active.name} docs →
									</Link>
								</div>
							</div>
						) : null}
					</div>
				</section>

				<section id="work" className="block">
					<header className="block-head reveal">
						<p className="eyebrow">How you use it</p>
						<h2>Your account, settings, then work on the live site.</h2>
						<p>You run the business here. Your developer starts from one share file and public docs.</p>
					</header>

					<ol className="work-steps reveal">
						{WORK_STEPS.map((r) => (
							<li key={r.k} className="glass hard">
								<div className="work-head">
									<span className="mono work-n">{r.n}</span>
									<span className="mono work-k">{r.k}</span>
								</div>
								<h3>{r.t}</h3>
								<p>{r.d}</p>
							</li>
						))}
					</ol>

					<div className="handoff glass hard reveal">
						<div className="handoff-copy">
							<p className="eyebrow">For your developer</p>
							<h3>One share file. Public docs. They do not start from zero.</h3>
							<p>
								Share the file from your account. It points to the site, the features on it, and the docs. Keys stay in
								the file — not in chat.
							</p>
						</div>
						<ul className="handoff-bits" aria-label="What the share file covers">
							<li>Site address & API endpoints</li>
							<li>Features enabled on this site</li>
							<li>Docs hub and page piece guides</li>
							<li>API keys stay safely in the file</li>
						</ul>
						<div className="handoff-action">
							<ButtonLink href="/docs" variant="secondary" size="md">
								Browse docs →
							</ButtonLink>
						</div>
					</div>
				</section>

				<section id="start" className="block band">
					<header className="block-head reveal">
						<p className="eyebrow">Common questions</p>
						<h2>Still unsure? Start here.</h2>
					</header>
					<dl className="faq reveal">
						{FAQ.map((f) => (
							<div className="faq-item" key={f.q}>
								<dt>{f.q}</dt>
								<dd>{f.a}</dd>
							</div>
						))}
					</dl>
					<div className="hero-actions reveal" style={{ marginTop: '1.75rem' }}>
						<ButtonLink href="/login" variant="primary" size="lg">
							Sign in
						</ButtonLink>
						<ButtonLink href="/docs" variant="secondary" size="lg">
							Browse docs
						</ButtonLink>
					</div>
				</section>
			</main>

			<SiteFooter brandName={productName} companyName={companyName} isHome={true} />
		</>
	);
}
