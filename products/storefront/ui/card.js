/**
 * One item card (shared by `grid`, `cards`, `trending_band` and `deals_page`): image with a reserved aspect ratio,
 * badges, title link, brand, price, and the rotating attribute chips. Chip slides are stacked in one grid cell (no
 * layout shift) and cross-fade on one page-wide, staggered ticker that runs only while a cycling card is on screen,
 * not hovered or focused, and the tab is visible. Reduced motion shows the first slide only.
 */
import { formatMoney } from '../headless/format.js';
import { el, windowOf } from './dom.js';

/** Ticker step; a card advances every `cycleMs / TICK` steps on its own phase. */
const TICK = 250;

/**
 * @typedef {{ node: any, layers: any[], phase: number, every: number, index: number, seen: boolean, paused: boolean }} Sub
 */

/**
 * The page-wide chip ticker of one window: one interval for every cycling card, running only while a card is on
 * screen (one shared IntersectionObserver), not paused, and the tab is visible.
 * @param {any} win
 */
const createTicker = (win) => {
	/** @type {Set<Sub>} */
	const subs = new Set();
	/** @type {any} */
	let timer = null;
	let n = 0;
	const step = () => {
		n += 1;
		for (const sub of subs)
			if (sub.seen && !sub.paused && (n + sub.phase) % sub.every === 0) {
				sub.index = (sub.index + 1) % sub.layers.length;
				sub.layers.forEach((layer, i) => {
					layer.setAttribute('aria-hidden', String(i !== sub.index));
					layer.classList?.toggle('is-on', i === sub.index);
				});
			}
		sync();
	};
	const sync = () => {
		for (const sub of subs) if (!sub.node.isConnected) subs.delete(sub);
		const run = win.document?.visibilityState !== 'hidden' && [...subs].some((sub) => sub.seen && !sub.paused);
		if (run && timer === null) timer = win.setInterval(step, TICK);
		else if (!run && timer !== null) {
			win.clearInterval(timer);
			timer = null;
		}
	};
	const io =
		typeof win.IntersectionObserver === 'function'
			? new win.IntersectionObserver((/** @type {any[]} */ entries) => {
					for (const entry of entries)
						for (const sub of subs) if (sub.node === entry.target) sub.seen = entry.isIntersecting;
					sync();
				})
			: null;
	win.document?.addEventListener?.('visibilitychange', sync);
	return {
		/** @param {Sub} sub */
		add: (sub) => {
			subs.add({ ...sub, seen: io === null });
			io?.observe(sub.node);
			sync();
		},
		/** @param {any} node @param {boolean} paused */
		pause: (node, paused) => {
			for (const sub of subs) if (sub.node === node) sub.paused = paused;
			sync();
		},
	};
};

/** @type {WeakMap<object, ReturnType<typeof createTicker>>} */
const tickers = new WeakMap();

/**
 * Register a card's chip layers with the page ticker (paused while hovered or focused).
 * @param {any} win
 * @param {any} node the card
 * @param {any[]} layers
 * @param {number} phase
 * @param {number} cycleMs
 */
const cycle = (win, node, layers, phase, cycleMs) => {
	if (typeof win?.setInterval !== 'function') return;
	const ticker = tickers.get(win) ?? createTicker(win);
	tickers.set(win, ticker);
	// registered once the Loader has inserted the card (a card replaced before then is never ticked)
	queueMicrotask(() =>
		ticker.add({ node, layers, phase, every: Math.max(1, Math.round(cycleMs / TICK)), index: 0, seen: false, paused: false }),
	);
	for (const [type, paused] of /** @type {const} */ ([
		['mouseenter', true],
		['mouseleave', false],
		['focusin', true],
		['focusout', false],
	]))
		node.addEventListener(type, () => ticker.pause(node, paused));
};

/**
 * @param {{ dom: import('./dom.js').DomLike, card: import('../core/card.js').CardView, t: (key: string, params?: Record<string, string | number>) => string,
 *   ratio: string, cycleMs: number, motion: boolean, priority?: boolean, locale?: string, heading?: string }} input
 */
export const renderCard = ({ dom, card, t, ratio, cycleMs, motion, priority = false, locale = '', heading = 'h3' }) => {
	const lang = locale || dom.documentElement?.lang || '';
	const price = formatMoney(card.price, card.currency, lang);
	const was = formatMoney(card.compareAt, card.currency, lang);
	const layers = card.slides.map((chips, index) =>
		el(
			dom,
			'ul',
			{ class: `ss-card__chips${index === 0 ? ' is-on' : ''}`, 'aria-hidden': index === 0 ? null : 'true' },
			chips.map((chip) => el(dom, 'li', { class: 'ss-card__chip' }, [chip])),
		),
	);
	const badges = [
		...card.badges.map((badge) => el(dom, 'span', { class: 'ss-card__badge' }, [badge])),
		card.soldOut ? el(dom, 'span', { class: 'ss-card__badge ss-card__badge--muted' }, [t('card.sold_out')]) : null,
	];
	const title = card.href ? el(dom, 'a', { class: 'ss-card__link', href: card.href }, [card.title]) : card.title;
	const node = el(dom, 'article', { class: 'ss-card', 'data-ratio': ratio }, [
		el(dom, 'div', { class: 'ss-card__media' }, [
			card.image
				? el(dom, 'img', {
						src: card.image,
						alt: card.imageAlt,
						loading: priority ? 'eager' : 'lazy',
						decoding: 'async',
						fetchpriority: priority ? 'high' : null,
					})
				: null,
			badges.some(Boolean) ? el(dom, 'div', { class: 'ss-card__badges' }, badges) : null,
		]),
		el(dom, heading, { class: 'ss-card__title' }, [title]),
		card.brand ? el(dom, 'p', { class: 'ss-card__brand' }, [card.brand]) : null,
		layers.length > 0 ? el(dom, 'div', { class: 'ss-card__slides' }, layers) : null,
		price
			? el(dom, 'p', { class: 'ss-card__price' }, [
					was ? el(dom, 'span', { class: 'ss-sr' }, [t('card.price_now')]) : null,
					price,
					was ? el(dom, 'del', {}, [el(dom, 'span', { class: 'ss-sr' }, [t('card.price_was')]), was]) : null,
				])
			: null,
	]);
	if (motion && cycleMs > 0 && layers.length > 1) cycle(windowOf(dom), node, layers, card.phase, cycleMs);
	return node;
};

/** Card styles (design tokens only). */
export const cardStyles = `.ss-card{position:relative;display:flex;flex-direction:column;gap:var(--ss-space-1);height:100%;color:var(--ss-color-text);background:var(--ss-color-surface);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-md);overflow:hidden;font:var(--ss-font-body)}
.ss-card__media{position:relative;aspect-ratio:1/1;background:var(--ss-color-surface-2)}
.ss-card[data-ratio="4/3"] .ss-card__media{aspect-ratio:4/3}.ss-card[data-ratio="3/4"] .ss-card__media{aspect-ratio:3/4}.ss-card[data-ratio="16/9"] .ss-card__media{aspect-ratio:16/9}
.ss-card__media img{width:100%;height:100%;object-fit:cover;display:block}
.ss-card__badges{position:absolute;top:var(--ss-space-2);left:var(--ss-space-2);display:flex;gap:var(--ss-space-1);flex-wrap:wrap}
.ss-card__badge{padding:0 var(--ss-space-2);border-radius:var(--ss-radius-full);background:var(--ss-color-accent,var(--ss-color-primary));color:var(--ss-color-on-accent,var(--ss-color-on-primary));font-size:var(--ss-font-size-xs,.75rem)}
.ss-card__badge--muted{background:var(--ss-color-surface);color:var(--ss-color-text-muted)}
.ss-card__title,.ss-card__brand,.ss-card__price{margin:0 var(--ss-space-3)}.ss-card__title{font-size:1rem;font-weight:var(--ss-font-weight-bold,600)}
.ss-card__link{color:inherit;text-decoration:none}.ss-card__link::after{content:"";position:absolute;inset:0}
.ss-card__link:focus-visible{outline:none}.ss-card:focus-within{outline:2px solid var(--ss-color-focus);outline-offset:2px}
.ss-card__brand{color:var(--ss-color-text-muted);font-size:var(--ss-font-size-sm,.875rem)}
.ss-card__slides{display:grid;margin:0 var(--ss-space-3);min-height:1.75rem}
.ss-card__chips{grid-area:1/1;display:flex;flex-wrap:wrap;gap:var(--ss-space-1);margin:0;padding:0;list-style:none;overflow:hidden;max-height:1.75rem;opacity:0;transition:opacity var(--ss-motion-duration,200ms)}
.ss-card__chips.is-on{opacity:1}
.ss-card__chip{padding:0 var(--ss-space-2);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-full);font-size:var(--ss-font-size-xs,.75rem)}
.ss-card__price{margin-bottom:var(--ss-space-3);font-weight:var(--ss-font-weight-bold,600)}.ss-card__price del{margin-inline-start:var(--ss-space-2);color:var(--ss-color-text-muted);font-weight:400}
.ss-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.ss-card__chips{transition:none}}
`;
