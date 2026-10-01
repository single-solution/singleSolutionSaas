/**
 * Mode A default renderer of the `badges` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; design tokens
 * only; text nodes only; the countdown is announced politely; space is reserved by the stylesheet (no layout shift).
 * Variants: `card` (badge + price + strike-through, for product cards) and `detail` (+ pills with their conditions,
 * countdown and low-stock note, for product pages). `theme.item` picks the item (`itemId` or `itemId:variantId`).
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/badges.js').BadgesState} BadgesState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-deal { color: var(--ss-color-text); font: var(--ss-font-body); display: flex; flex-direction: column; gap: var(--ss-space-1); min-height: var(--ss-deal-min-height, 1.5rem); }
.ss-deal__badge { align-self: flex-start; border-radius: var(--ss-radius-sm); padding: 0 var(--ss-space-2); font-weight: var(--ss-font-weight-bold, 700); background: var(--ss-color-primary); color: var(--ss-color-on-primary); }
.ss-deal__badge--urgent { background: var(--ss-color-danger); color: var(--ss-color-on-danger, var(--ss-color-on-primary)); }
.ss-deal__badge--neutral { background: var(--ss-color-surface-2, var(--ss-color-surface)); color: var(--ss-color-text); }
.ss-deal__badge--success { background: var(--ss-color-success, var(--ss-color-primary)); color: var(--ss-color-on-primary); }
.ss-deal__price { display: flex; gap: var(--ss-space-2); align-items: baseline; }
.ss-deal__now { font-weight: var(--ss-font-weight-bold, 700); }
.ss-deal__was { color: var(--ss-color-text-muted); text-decoration: line-through; }
.ss-deal__pills { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--ss-space-1); }
.ss-deal__pill { border: 1px solid var(--ss-color-border, var(--ss-color-text-muted)); border-radius: var(--ss-radius-full, 999px); padding: 0 var(--ss-space-2); }
.ss-deal__note, .ss-deal__stock { color: var(--ss-color-text-muted); }
.ss-deal__countdown { color: var(--ss-color-danger); font-variant-numeric: tabular-nums; }
.ss-deal__error { color: var(--ss-color-danger); }
@media (prefers-reduced-motion: reduce) { .ss-deal * { transition: none; animation: none; } }
`;

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<any>} [children]
 */
const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * Render the element.
 * @param {{ state: BadgesState, actions?: unknown, strings: Record<string, string>,
 *   theme?: { variant?: string, item?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'detail' ? 'detail' : 'card';
	const item = (theme.item ? state.items.find((i) => i.key === theme.item) : state.items[0]) ?? null;
	/** @type {any[]} */
	const body = [];
	if (state.status === 'error' && state.error)
		body.push(el(dom, 'p', { class: 'ss-deal__error', role: 'status' }, [state.error]));
	if (item) {
		if (item.badgeText) body.push(el(dom, 'span', { class: `ss-deal__badge ss-deal__badge--${item.tone}` }, [item.badgeText]));
		const price = [
			el(dom, 'span', { class: 'ss-deal__now', 'aria-label': t('price.now', { price: item.priceText }) }, [item.priceText]),
		];
		if (item.strikeText)
			price.push(
				el(
					dom,
					item.strikeText === item.compareAtText ? 's' : 'span',
					{
						class: 'ss-deal__was',
						'aria-label': item.compareAtText ? t('price.compare_at', { price: item.compareAtText }) : item.strikeText,
					},
					[item.strikeText],
				),
			);
		body.push(el(dom, 'p', { class: 'ss-deal__price' }, price));
		if (variant === 'detail') {
			if (item.pills.length > 0)
				body.push(
					el(
						dom,
						'ul',
						{ class: 'ss-deal__pills', 'aria-label': t('badges.label') },
						item.pills.map((p) =>
							el(dom, 'li', { class: `ss-deal__pill ss-deal__pill--${p.tone}`, 'data-deal': p.dealId }, [
								p.text,
								...(p.notes.length > 0
									? [el(dom, 'span', { class: 'ss-deal__note' }, [` · ${p.notes.join(' · ')}`])]
									: []),
							]),
						),
					),
				);
			if (item.countdown)
				body.push(
					el(dom, 'p', { class: 'ss-deal__countdown', role: 'timer', 'aria-live': 'off' }, [
						el(dom, 'time', { datetime: item.countdown.endsAt }, [item.countdown.text]),
					]),
				);
			if (item.lowStockText) body.push(el(dom, 'p', { class: 'ss-deal__stock', role: 'note' }, [item.lowStockText]));
		}
	}
	return el(
		dom,
		'div',
		{
			class: `ss-deal ss-deal--${variant}`,
			role: 'group',
			'aria-label': t('badges.label'),
			'aria-busy': String(state.status === 'loading'),
		},
		[...(slots.before ? [slots.before] : []), ...body, ...(slots.after ? [slots.after] : [])],
	);
};
