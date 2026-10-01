/**
 * Mode A renderer of `deals_page`: one article per live deal (name, badge, description, time left) with its item
 * cards, and "load more" while the Deals API has more pages.
 */
import { createTranslator } from '../headless/strings.js';
import { cardStyles, renderCard } from './card.js';
import { boot, el, pageData, reduced, windowOf } from './dom.js';

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/dealsPage.js').createDealsPage>['state']>,
 *   actions: ReturnType<typeof import('../headless/dealsPage.js').createDealsPage>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike, slots?: Record<string, any>, reducedMotion?: boolean }} props
 */
export const render = ({ state, actions, strings, dom, slots = {}, reducedMotion }) => {
	const t = createTranslator(strings);
	boot(dom, actions, () => void actions.start({ data: pageData(dom, state.pageId) }));
	const motion = !reduced(windowOf(dom), reducedMotion);
	const deals = state.deals.map((deal) =>
		el(dom, 'article', { class: 'ss-deals__deal', 'aria-labelledby': `ss-deal-${deal.id}` }, [
			el(dom, 'header', { class: 'ss-deals__head' }, [
				el(dom, 'h3', { id: `ss-deal-${deal.id}` }, [deal.name]),
				deal.badge ? el(dom, 'span', { class: 'ss-card__badge' }, [deal.badge]) : null,
				deal.left ? el(dom, 'p', { class: 'ss-deals__left' }, [t('deals_page.ends_in', deal.left)]) : null,
			]),
			deal.description ? el(dom, 'p', { class: 'ss-deals__text' }, [deal.description]) : null,
			el(
				dom,
				'ul',
				{ class: `ss-deals__items ss-deals__items--${state.layout}`, role: 'list' },
				deal.items.map((card) =>
					el(dom, 'li', {}, [
						renderCard({ dom, card, t, ratio: state.ratio, cycleMs: 0, motion, locale: state.locale, heading: 'h4' }),
					]),
				),
			),
		]),
	);
	return el(
		dom,
		'section',
		{
			class: 'ss-deals',
			role: 'region',
			'aria-label': t('deals_page.label'),
			'aria-busy': state.status === 'loading' ? 'true' : 'false',
		},
		[
			slots.before ?? el(dom, 'h2', { class: 'ss-deals__title' }, [t('deals_page.title')]),
			state.status === 'error' ? el(dom, 'p', { role: 'alert' }, [state.error ?? '']) : null,
			state.status === 'ready' && deals.length === 0 ? (slots.empty ?? el(dom, 'p', {}, [t('deals_page.empty')])) : deals,
			state.next
				? el(dom, 'button', { type: 'button', class: 'ss-deals__more', onclick: () => void actions.loadMore() }, [
						t('deals_page.more'),
					])
				: null,
			slots.after ?? null,
		],
	);
};

export const styles = `${cardStyles}.ss-deals{display:flex;flex-direction:column;gap:var(--ss-space-4);color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-deals__title{margin:0;font-size:1.5rem}.ss-deals__deal{display:flex;flex-direction:column;gap:var(--ss-space-2)}
.ss-deals__head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ss-space-2)}.ss-deals__head h3{margin:0}
.ss-deals__left{margin:0;color:var(--ss-color-text-muted)}.ss-deals__text{margin:0}
.ss-deals__items{margin:0;padding:0;list-style:none;display:grid;gap:var(--ss-space-3)}
.ss-deals__items--grid{grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))}.ss-deals__items--list{grid-template-columns:1fr}
.ss-deals__more{align-self:center;min-height:2.75rem;padding:0 var(--ss-space-4);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-full);background:var(--ss-color-surface);color:var(--ss-color-text);font:inherit}
.ss-deals__more:focus-visible{outline:2px solid var(--ss-color-focus)}
`;
