/**
 * Mode A renderer of the `sticky_buy_bar` element: a bar fixed to the bottom of the viewport (safe-area aware) with
 * the title, price and a call-to-action that clicks — or scrolls to — the page's own buy button
 * (`cta_selector`). Visibility follows the device and the page's buy button (IntersectionObserver, else scroll
 * position). Fixed positioning never shifts layout. Design tokens only.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { BASE_STYLES, el, listen, once, query, refocusing, winOf } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/stickyBuyBar.js').createStickyBuyBar>} StickyBuyBar */

export const styles = `${BASE_STYLES}
.ss-sticky{position:fixed;left:var(--ss-space-2);right:var(--ss-space-2);bottom:calc(var(--ss-sticky-offset,0px) + env(safe-area-inset-bottom,0px) + var(--ss-space-2));z-index:var(--ss-z-sticky,900);display:flex;align-items:center;gap:var(--ss-space-2);padding:var(--ss-space-2) var(--ss-space-3);background:var(--ss-color-surface);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-lg);box-shadow:var(--ss-shadow-lg)}
.ss-sticky__info{flex:1;min-width:0;display:grid}
.ss-sticky__title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--ss-font-size-sm)}
.ss-sticky__price{font-weight:var(--ss-font-weight-bold)}
.ss-sticky__cta{border:0;border-radius:var(--ss-radius-full);padding:var(--ss-space-2) var(--ss-space-3);background:var(--ss-color-primary);color:var(--ss-color-on-primary);font-weight:var(--ss-font-weight-bold)}
.ss-sticky__cta[disabled]{opacity:0.6;cursor:not-allowed}
.ss-sticky__dismiss{border:0;background:none;color:var(--ss-color-text-muted);padding:var(--ss-space-1)}`;

const UNAVAILABLE = new Set(['out_of_stock', 'discontinued']);

/**
 * Follow the viewport: device, the page's buy button in view, scroll depth.
 * @param {import('./dom.js').DomLike} dom
 * @param {StickyBuyBar['actions']} actions
 * @param {string} selector
 */
const watch = (dom, actions, selector) => {
	const win = winOf(dom);
	if (!win) return;
	const cta = query(dom, selector);
	const measure = () => {
		const height = Number(win.innerHeight) || 0;
		const total = Math.max(Number(dom.documentElement?.scrollHeight) - height, 1);
		const rect = cta?.getBoundingClientRect?.();
		void actions.setViewport({
			width: Number(win.innerWidth) || 0,
			scrolled: Math.round(((Number(win.scrollY) || 0) / total) * 100),
			...(rect ? { ctaVisible: rect.bottom > 0 && rect.top < height } : {}),
		});
	};
	if (cta && typeof win.IntersectionObserver === 'function') {
		const observer = new win.IntersectionObserver((/** @type {any[]} */ entries) => {
			for (const entry of entries) void actions.setViewport({ ctaVisible: entry.isIntersecting === true });
		});
		observer.observe(cta);
	}
	listen(win, 'scroll', measure);
	listen(win, 'resize', measure);
	measure();
};

/**
 * @param {{ state: ReturnType<StickyBuyBar['state']>, actions: StickyBuyBar['actions'], strings: Record<string, string>,
 *   reducedMotion?: boolean, dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, reducedMotion = false, dom }) => {
	const t = createTranslator(strings);
	once(actions, async () => {
		await actions.load(pageSource(dom, 'sticky_buy_bar'));
		watch(dom, actions, state.ctaSelector);
	});
	const root = el(dom, 'div', {
		class: 'ss-pdp ss-sticky',
		role: 'region',
		'aria-label': t('sticky_buy_bar.label'),
		hidden: !(state.status === 'ready' && state.visible),
	});
	if (state.status !== 'ready' || !state.visible) return root;
	const unavailable = UNAVAILABLE.has(state.availability);
	const button = el(dom, 'button', { type: 'button', class: 'ss-sticky__cta', disabled: unavailable, 'data-ss-focus': 'cta' }, [
		unavailable ? t('sticky_buy_bar.unavailable') : t('sticky_buy_bar.cta'),
	]);
	listen(button, 'click', async () => {
		const result = await actions.buy();
		const cta = query(dom, state.ctaSelector);
		if (!result.ok || !cta) return;
		if (result.value === 'click') cta.click?.();
		else {
			cta.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
			cta.focus?.();
		}
	});
	root.append(
		el(dom, 'div', { class: 'ss-sticky__info' }, [
			el(dom, 'span', { class: 'ss-sticky__title' }, [state.item?.title ?? '']),
			state.price ? el(dom, 'span', { class: 'ss-sticky__price' }, [state.price]) : null,
		]),
		button,
	);
	if (state.dismissible) {
		const dismiss = el(
			dom,
			'button',
			{ type: 'button', class: 'ss-sticky__dismiss', 'aria-label': t('sticky_buy_bar.dismiss') },
			['×'],
		);
		listen(dismiss, 'click', () => void actions.dismiss());
		root.append(dismiss);
	}
	return root;
};

/** In-place update for the Loader that keeps focus on the call-to-action. */
export const update = refocusing(render);
