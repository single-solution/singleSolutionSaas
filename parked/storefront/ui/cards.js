/**
 * Mode A renderers of `cards` (a section of item cards: grid or horizontal rail) and `trending_band` (a strip of
 * trending items; `marquee` scrolls their names slowly, paused on hover and focus, static under reduced motion).
 */
import { createTranslator } from '../headless/strings.js';
import { cardStyles, renderCard } from './card.js';
import { boot, el, pageData, reduced, windowOf } from './dom.js';

/**
 * @typedef {{ state: ReturnType<ReturnType<typeof import('../headless/cards.js').createCards>['state']>,
 *   actions: ReturnType<typeof import('../headless/cards.js').createCards>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike, slots?: Record<string, any>, reducedMotion?: boolean }} Props
 */

/**
 * @param {Props} props
 * @param {string} key element key (class names and strings)
 */
const section = ({ state, actions, strings, dom, slots = {}, reducedMotion }, key) => {
	const t = createTranslator(strings);
	const win = windowOf(dom);
	boot(dom, actions, () => void actions.start({ data: pageData(dom, state.pageId) }));
	const motion = !reduced(win, reducedMotion);
	const title = t(`${key}.title`);
	const list =
		state.layout === 'marquee'
			? el(dom, 'div', { class: `ss-band__marquee${motion ? ' is-moving' : ''}` }, [
					el(
						dom,
						'ul',
						{ class: 'ss-band__names', role: 'list' },
						state.items.map((card) =>
							el(dom, 'li', {}, [card.href ? el(dom, 'a', { href: card.href }, [card.title]) : card.title]),
						),
					),
					motion
						? el(
								dom,
								'ul',
								{ class: 'ss-band__names', 'aria-hidden': 'true' },
								state.items.map((card) => el(dom, 'li', {}, [card.title])),
							)
						: null,
				])
			: el(
					dom,
					'ul',
					{
						class: `ss-cards__list ss-cards__list--${state.layout}`,
						role: 'list',
						tabindex: state.layout === 'grid' ? null : '0',
						'aria-label': title,
					},
					state.items.map((card) =>
						el(dom, 'li', {}, [
							renderCard({ dom, card, t, ratio: state.ratio, cycleMs: state.cycleMs, motion, locale: state.locale }),
						]),
					),
				);
	return el(
		dom,
		'section',
		{
			class: `ss-cards ss-${key}`,
			role: 'region',
			'aria-label': title,
			'aria-busy': state.status === 'loading' ? 'true' : 'false',
		},
		[
			slots.before ?? el(dom, 'h2', { class: 'ss-cards__title' }, [title]),
			state.status === 'error' ? el(dom, 'p', { role: 'alert' }, [state.error ?? '']) : null,
			state.status === 'ready' && state.items.length === 0 ? (slots.empty ?? null) : list,
			slots.after ?? null,
		],
	);
};

/** @param {Props} props */
export const renderCards = (props) => section(props, 'cards');

/** @param {Props} props */
export const renderTrendingBand = (props) => section(props, 'trending_band');

export const styles = `${cardStyles}.ss-cards{display:flex;flex-direction:column;gap:var(--ss-space-3);color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-cards__title{margin:0;font:var(--ss-font-heading,inherit);font-size:1.25rem;font-weight:var(--ss-font-weight-bold,700)}
.ss-cards__list{margin:0;padding:0;list-style:none;display:grid;gap:var(--ss-space-3)}
.ss-cards__list--grid{grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))}
.ss-cards__list--rail,.ss-cards__list--strip{grid-auto-flow:column;grid-auto-columns:minmax(10rem,14rem);overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:var(--ss-space-2)}
.ss-cards__list--rail>li,.ss-cards__list--strip>li{scroll-snap-align:start}
.ss-cards__list:focus-visible{outline:2px solid var(--ss-color-focus)}
`;

/** The trending band adds the marquee. */
export const bandStyles = `${styles}.ss-band__marquee{display:flex;overflow:hidden;gap:var(--ss-space-6,1.5rem)}
.ss-band__names{display:flex;gap:var(--ss-space-6,1.5rem);margin:0;padding:0;list-style:none;white-space:nowrap;flex-wrap:wrap}
.ss-band__marquee.is-moving .ss-band__names{flex-wrap:nowrap;animation:ss-band 40s linear infinite}
.ss-band__marquee:hover .ss-band__names,.ss-band__marquee:focus-within .ss-band__names{animation-play-state:paused}
.ss-band__names a{color:inherit}.ss-band__names a:focus-visible{outline:2px solid var(--ss-color-focus)}
@keyframes ss-band{to{transform:translateX(calc(-100% - var(--ss-space-6,1.5rem)))}}
@media (prefers-reduced-motion:reduce){.ss-band__names{animation:none!important;flex-wrap:wrap}}
`;
