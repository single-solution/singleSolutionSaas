/**
 * Mode A default renderer of the `deals_page` element: deal buttons (the ibrahimMobiles `/deals` toggle row), the
 * selected deal's details (badge, conditions, schedule, countdown, stock) and its items. Built only on headless/,
 * design tokens only, text nodes only, keyboard operable (native buttons, `aria-pressed`), polite status updates.
 * Variants: `grid` and `list`.
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/dealsPage.js').DealsPageState} DealsPageState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-deals { color: var(--ss-color-text); background: var(--ss-color-surface); font: var(--ss-font-body); padding: var(--ss-space-3); border-radius: var(--ss-radius-md); min-height: var(--ss-deals-min-height, 12rem); }
.ss-deals__tabs { display: flex; flex-wrap: wrap; gap: var(--ss-space-2); margin: 0 0 var(--ss-space-3); padding: 0; list-style: none; }
.ss-deals__tab { border: 1px solid var(--ss-color-border, var(--ss-color-text-muted)); border-radius: var(--ss-radius-full, 999px); background: var(--ss-color-surface); color: var(--ss-color-text); padding: var(--ss-space-1) var(--ss-space-3); }
.ss-deals__tab[aria-pressed="true"] { background: var(--ss-color-primary); color: var(--ss-color-on-primary); }
.ss-deals__tab:focus-visible, .ss-deals__more:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-deals__badge { font-weight: var(--ss-font-weight-bold, 700); color: var(--ss-color-primary); }
.ss-deals__meta { color: var(--ss-color-text-muted); }
.ss-deals__countdown { color: var(--ss-color-danger); font-variant-numeric: tabular-nums; }
.ss-deals__items { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ss-space-3); grid-template-columns: repeat(auto-fill, minmax(var(--ss-deals-card-min, 10rem), 1fr)); }
.ss-deals--list .ss-deals__items { grid-template-columns: 1fr; }
.ss-deals__item img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: var(--ss-radius-sm); }
.ss-deals__was { color: var(--ss-color-text-muted); text-decoration: line-through; margin-inline-start: var(--ss-space-1); }
.ss-deals__more { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border-radius: var(--ss-radius-sm); margin-top: var(--ss-space-3); }
.ss-deals__error { color: var(--ss-color-danger); }
@media (prefers-reduced-motion: reduce) { .ss-deals * { transition: none; animation: none; } }
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
 * @param {{ state: DealsPageState, actions: { select: (id: string) => unknown, loadItems: (id: string) => Promise<unknown>, loadMore: () => Promise<unknown> },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'list' ? 'list' : 'grid';
	/** @type {any[]} */
	const body = [el(dom, 'h2', { class: 'ss-deals__title' }, [t('deals_page.title')])];
	if (state.status === 'loading') body.push(el(dom, 'p', { class: 'ss-deals__meta' }, [t('deals_page.loading')]));
	if (state.status === 'ready' && state.deals.length === 0)
		body.push(slots.empty ?? el(dom, 'p', { class: 'ss-deals__meta' }, [t('deals_page.empty')]));
	if (state.deals.length > 0) {
		body.push(
			el(
				dom,
				'ul',
				{ class: 'ss-deals__tabs', 'aria-label': t('deals_page.title') },
				state.deals.map((deal) => {
					const button = el(
						dom,
						'button',
						{ type: 'button', class: 'ss-deals__tab', 'aria-pressed': String(deal.id === state.activeDealId) },
						[deal.name],
					);
					button.addEventListener('click', () => actions.select(deal.id));
					return el(dom, 'li', {}, [button]);
				}),
			),
		);
		if (state.hasMore) {
			const more = el(dom, 'button', { type: 'button', class: 'ss-deals__more' }, [t('deals_page.more')]);
			if (state.loadingMore) more.setAttribute('disabled', '');
			more.addEventListener('click', () => actions.loadMore());
			body.push(more);
		}
		const deal = state.deals.find((d) => d.id === state.activeDealId) ?? null;
		if (deal) {
			/** @type {any[]} */
			const detail = [
				el(dom, 'p', { class: 'ss-deals__badge' }, [deal.badgeText]),
				el(dom, 'h3', {}, [deal.name]),
				...(deal.description ? [el(dom, 'p', {}, [deal.description])] : []),
				...deal.notes.map((note) => el(dom, 'p', { class: 'ss-deals__meta' }, [note])),
				...(deal.timeText ? [el(dom, 'p', { class: 'ss-deals__meta' }, [deal.timeText])] : []),
				...(deal.countdown
					? [
							el(dom, 'p', { class: 'ss-deals__countdown', role: 'timer' }, [
								el(dom, 'time', { datetime: deal.countdown.endsAt }, [deal.countdown.text]),
							]),
						]
					: []),
				...(deal.stockText ? [el(dom, 'p', { class: 'ss-deals__meta', role: 'note' }, [deal.stockText])] : []),
			];
			if (deal.items.length > 0)
				detail.push(
					el(
						dom,
						'ul',
						{ class: 'ss-deals__items', 'aria-label': t('deals_page.items') },
						deal.items.map((item) => {
							const name = item.url ? el(dom, 'a', { href: item.url }, [item.title]) : el(dom, 'span', {}, [item.title]);
							return el(dom, 'li', { class: 'ss-deals__item' }, [
								...(item.image ? [el(dom, 'img', { src: item.image, alt: '', loading: 'lazy' })] : []),
								name,
								el(dom, 'p', {}, [
									el(dom, 'span', {}, [item.priceText]),
									...(item.compareAtText ? [el(dom, 's', { class: 'ss-deals__was' }, [item.compareAtText])] : []),
								]),
							]);
						}),
					),
				);
			if (deal.moreItems) {
				const more = el(dom, 'button', { type: 'button', class: 'ss-deals__more' }, [t('deals_page.items.more')]);
				if (deal.loadingItems) more.setAttribute('disabled', '');
				more.addEventListener('click', () => actions.loadItems(deal.id));
				detail.push(more);
			}
			body.push(el(dom, 'article', { class: 'ss-deals__deal', 'aria-label': deal.name }, detail));
		}
	}
	body.push(el(dom, 'p', { class: 'ss-deals__error', role: 'status', 'aria-live': 'polite' }, state.error ? [state.error] : []));
	return el(
		dom,
		'section',
		{
			class: `ss-deals ss-deals--${variant}`,
			role: 'region',
			'aria-label': t('deals_page.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[...(slots.before ? [slots.before] : []), ...body, ...(slots.after ? [slots.after] : [])],
	);
};
