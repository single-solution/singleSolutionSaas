/**
 * Mode A default renderer of the `items` element: item cards (image, title, brand, price, compare-at price,
 * availability) in a `grid` or a `list`, a sort select and "show more". A pure function of (state, actions, strings,
 * theme, slots) returning DOM built with the injected `dom`; built only on headless/; design tokens only; keyboard
 * operable; reserves its minimum height (no layout shift).
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-items { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-items-min-height, 12rem); }
.ss-items__grid { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ss-space-3);
  grid-template-columns: repeat(auto-fill, minmax(var(--ss-items-card-min, 12rem), 1fr)); }
.ss-items--list .ss-items__grid { grid-template-columns: 1fr; }
.ss-items__card { background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-md); padding: var(--ss-space-2); }
.ss-items__card a { color: inherit; text-decoration: none; }
.ss-items__card a:focus-visible, .ss-items select:focus-visible, .ss-items button:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-items__image { width: 100%; height: auto; aspect-ratio: var(--ss-items-image-ratio, 1); object-fit: cover; border-radius: var(--ss-radius-sm); }
.ss-items__price { font-weight: var(--ss-font-weight-bold, 700); }
.ss-items__compare { color: var(--ss-color-text-muted); text-decoration: line-through; margin-inline-start: var(--ss-space-1); }
.ss-items__meta, .ss-items__status { color: var(--ss-color-text-muted); }
.ss-items__more { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border-radius: var(--ss-radius-sm); }
@media (prefers-reduced-motion: reduce) { .ss-items * { transition: none; } }
`;

/**
 * @param {{ state: import('../headless/items.js').ItemsState, actions: { setSort: (sort: string) => unknown, loadMore: () => unknown, select: (id: string) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'list' ? 'list' : 'grid';
	const sort = on(
		el(
			dom,
			'select',
			{ class: 'ss-items__sort', 'aria-label': t('catalog.items.sort') },
			state.sorts.map((s) => {
				const option = el(dom, 'option', { value: s, ...(s === state.sort ? { selected: 'selected' } : {}) }, [
					t(`catalog.sort.${s}`),
				]);
				return option;
			}),
		),
		'change',
		(event) => actions.setSort(event.target.value),
	);
	const cards = state.items.map((item) =>
		el(dom, 'li', { class: 'ss-items__card' }, [
			on(
				el(dom, 'a', { href: item.url }, [
					item.image
						? el(dom, 'img', {
								class: 'ss-items__image',
								src: item.image.url,
								srcset: item.image.srcset,
								alt: item.image.alt,
								loading: 'lazy',
							})
						: null,
					el(dom, 'h3', { class: 'ss-items__title' }, [item.title]),
				]),
				'click',
				() => actions.select(item.id),
			),
			item.brand ? el(dom, 'p', { class: 'ss-items__meta' }, [item.brand]) : null,
			el(dom, 'p', {}, [
				item.priceText ? el(dom, 'span', { class: 'ss-items__price' }, [item.priceText]) : null,
				item.compareText
					? el(
							dom,
							'span',
							{ class: 'ss-items__compare', 'aria-label': t('catalog.price.was', { price: item.compareText }) },
							[item.compareText],
						)
					: null,
			]),
			el(dom, 'p', { class: 'ss-items__meta' }, [item.availabilityText]),
		]),
	);
	const empty = state.status === 'ready' && state.items.length === 0;
	return el(
		dom,
		'section',
		{
			class: `ss-items ss-items--${variant}`,
			role: 'region',
			'aria-label': t('catalog.items.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			state.sorts.length > 1 ? sort : null,
			empty
				? (slots.empty ?? el(dom, 'p', { class: 'ss-items__status' }, [t('catalog.items.empty')]))
				: el(dom, 'ul', { class: 'ss-items__grid' }, cards),
			state.hasMore
				? on(
						el(
							dom,
							'button',
							{ type: 'button', class: 'ss-items__more', ...(state.loadingMore ? { 'aria-disabled': 'true' } : {}) },
							[t('catalog.items.more')],
						),
						'click',
						() => actions.loadMore(),
					)
				: null,
			statusLine(dom, 'ss-items', state.error),
			slots.after ?? null,
		],
	);
};
