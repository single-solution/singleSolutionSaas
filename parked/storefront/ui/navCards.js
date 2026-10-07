/**
 * Mode A renderers of `category_cards` and `brand_cards`: a navigation landmark with a list of link cards (image or
 * logo, name, optional count), as a grid or a horizontally scrolling rail.
 */
import { createTranslator } from '../headless/strings.js';
import { boot, el, pageData, setVars } from './dom.js';

/**
 * @typedef {{ state: ReturnType<ReturnType<typeof import('../headless/navCards.js').createCategoryCards>['state']>,
 *   actions: ReturnType<typeof import('../headless/navCards.js').createCategoryCards>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike, slots?: Record<string, any> }} Props
 */

/** @param {Props} props @param {string} key */
const nav = ({ state, actions, strings, dom, slots = {} }, key) => {
	const t = createTranslator(strings);
	boot(dom, actions, () => void actions.start({ data: pageData(dom, state.pageId) }));
	const list = el(
		dom,
		'ul',
		{ class: `ss-nav__list ss-nav__list--${state.layout}`, role: 'list' },
		state.cards.map((card) => {
			const body = [
				card.image
					? el(dom, 'img', { src: card.image, alt: state.names ? '' : card.title, loading: 'lazy', decoding: 'async' })
					: null,
				state.names || !card.image ? el(dom, 'span', { class: 'ss-nav__name' }, [card.title]) : null,
				state.counts && card.count !== null
					? el(dom, 'span', { class: 'ss-nav__count' }, [t('nav.count', { count: card.count })])
					: null,
			];
			return el(dom, 'li', {}, [
				card.href
					? el(dom, 'a', { class: 'ss-nav__card', href: card.href }, body)
					: el(dom, 'div', { class: 'ss-nav__card' }, body),
			]);
		}),
	);
	setVars(list, { '--ss-nav-cols': state.columns });
	return el(
		dom,
		'nav',
		{ class: `ss-nav ss-nav--${state.logos ? 'logos' : 'images'}`, role: 'navigation', 'aria-label': t(`${key}.label`) },
		[slots.before ?? null, list, slots.after ?? null],
	);
};

/** @param {Props} props */
export const renderCategoryCards = (props) => nav(props, 'category_cards');

/** @param {Props} props */
export const renderBrandCards = (props) => nav(props, 'brand_cards');

export const styles = `.ss-nav{color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-nav__list{margin:0;padding:0;list-style:none;display:grid;gap:var(--ss-space-3)}
.ss-nav__list--grid{grid-template-columns:repeat(2,minmax(0,1fr))}
@media (min-width:768px){.ss-nav__list--grid{grid-template-columns:repeat(var(--ss-nav-cols,4),minmax(0,1fr))}}
.ss-nav__list--rail{grid-auto-flow:column;grid-auto-columns:minmax(8rem,12rem);overflow-x:auto;scroll-snap-type:x mandatory}
.ss-nav__card{display:flex;flex-direction:column;align-items:center;gap:var(--ss-space-2);padding:var(--ss-space-3);height:100%;border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-md);background:var(--ss-color-surface);color:inherit;text-decoration:none;scroll-snap-align:start}
.ss-nav__card img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--ss-radius-sm)}
.ss-nav--logos .ss-nav__card img{aspect-ratio:3/2;object-fit:contain}
.ss-nav__name{font-weight:var(--ss-font-weight-bold,600);text-align:center}.ss-nav__count{color:var(--ss-color-text-muted);font-size:var(--ss-font-size-sm,.875rem)}
.ss-nav__card:focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}
`;
