/**
 * Mode A renderer of the `related` element: a horizontally scrolling rail or a grid of crawlable links (image,
 * title, price). Hidden when there is nothing related. Design tokens only.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { BASE_STYLES, el, listen, once } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/related.js').createRelated>} Related */

export const styles = `${BASE_STYLES}
.ss-related__title{font-size:var(--ss-font-size-md,1.125em);margin:0 0 var(--ss-space-2)}
.ss-related__list{display:flex;gap:var(--ss-space-3);list-style:none;margin:0;padding:0;overflow-x:auto;scroll-snap-type:x mandatory}
.ss-related--grid .ss-related__list{display:grid;grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));overflow:visible}
.ss-related__card{flex:0 0 10rem;scroll-snap-align:start}
.ss-related__link{display:grid;gap:var(--ss-space-1);color:inherit;text-decoration:none}
.ss-related__link:hover .ss-related__name{text-decoration:underline}
.ss-related__image{width:100%;aspect-ratio:1 / 1;object-fit:cover;border-radius:var(--ss-radius-sm);background:var(--ss-color-surface-2,var(--ss-color-surface))}
.ss-related__price{font-weight:var(--ss-font-weight-bold)}`;

/**
 * @param {{ state: ReturnType<Related['state']>, actions: Related['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	once(actions, () => actions.load(pageSource(dom, 'related')));
	const shown = state.status === 'ready' && state.items.length > 0;
	const title =
		state.strategy === 'same_brand' && state.item?.brand
			? t('related.title_brand', { brand: state.item.brand })
			: t('related.title');
	const root = el(dom, 'section', {
		class: `ss-pdp ss-related ss-related--${state.layout}`,
		role: 'region',
		'aria-label': title,
		hidden: !shown,
	});
	if (!shown) return root;
	const list = el(dom, 'ul', { class: 'ss-related__list' });
	state.items.forEach((entry, index) => {
		const link = el(dom, 'a', { class: 'ss-related__link', href: entry.url }, [
			entry.image
				? el(dom, 'img', { class: 'ss-related__image', src: entry.image, alt: '', loading: 'lazy', decoding: 'async' })
				: null,
			el(dom, 'span', { class: 'ss-related__name' }, [entry.title]),
			entry.priceText ? el(dom, 'span', { class: 'ss-related__price' }, [entry.priceText]) : null,
		]);
		listen(link, 'click', () => void actions.open(index));
		list.append(el(dom, 'li', { class: 'ss-related__card' }, [link]));
	});
	root.append(el(dom, 'h2', { class: 'ss-related__title' }, [title]), list);
	return root;
};
