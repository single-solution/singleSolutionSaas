/**
 * Mode A renderer of `grid`. Crawlable first: every page is a real `<a href="?page=N">` link (with `rel=prev/next`),
 * so crawlers and visitors without scripts page through the listing. With scripts, links update the list in place
 * (history pushed), and `infinite` appends the next page when the end comes into view (the URL is replaced with the
 * deepest page), `load_more` does the same behind a button. A sort select, a live result count, and focus moved to
 * the first new card after a keyboard "load more".
 */
import { createTranslator } from '../headless/strings.js';
import { cardStyles, renderCard } from './card.js';
import { boot, el, memo, navigate, pageData, plainClick, reduced, refocus, setVars, windowOf } from './dom.js';

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/grid.js').createGrid>['state']>,
 *   actions: ReturnType<typeof import('../headless/grid.js').createGrid>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike, slots?: Record<string, any>, reducedMotion?: boolean, config?: Record<string, unknown> }} props
 */
export const render = ({ state, actions, strings, dom, slots = {}, reducedMotion }) => {
	const t = createTranslator(strings);
	const win = windowOf(dom);
	const local = memo(actions);
	boot(
		dom,
		actions,
		(search) => actions.start({ search, data: pageData(dom, state.pageId) }),
		(search) => actions.setSearch(search),
	);
	/** @param {Promise<any>} pending @param {{ replace?: boolean }} [options] */
	const follow = (pending, options) =>
		pending.then((result) => {
			if (result.ok) navigate(win, result.value.search, options);
		});
	/** @param {string} search @param {number} page */
	const link = (search, page, label = String(page), rel = '') =>
		el(
			dom,
			'a',
			{
				href: search || '?',
				class: 'ss-grid__page',
				'data-k': rel || `p${page}`,
				rel: rel || null,
				'aria-current': !rel && page === state.query.page ? 'page' : null,
				'aria-label': rel ? null : t('grid.page', { page }),
				onclick: (/** @type {any} */ event) => {
					if (!plainClick(event)) return;
					event.preventDefault();
					follow(actions.goTo(page));
					local.root?.scrollIntoView?.({ block: 'start' });
				},
			},
			[label],
		);
	const motion = !reduced(win, reducedMotion);
	const items = state.items.map((card, index) =>
		el(dom, 'li', {}, [
			renderCard({
				dom,
				card,
				t,
				ratio: state.ratio,
				cycleMs: state.cycleMs,
				motion,
				priority: index < 2 && state.query.page === 1,
				locale: state.locale,
			}),
		]),
	);
	const list = el(dom, 'ul', { class: 'ss-grid__list', role: 'list' }, items);
	setVars(list, {
		'--ss-grid-m': state.columns.mobile,
		'--ss-grid-t': state.columns.tablet,
		'--ss-grid-d': state.columns.desktop,
	});
	const sort =
		state.sorts.length > 1
			? el(dom, 'label', { class: 'ss-grid__sort' }, [
					t('grid.sort'),
					el(
						dom,
						'select',
						{ 'data-k': 'sort', onchange: (/** @type {any} */ event) => follow(actions.sortBy(event.target.value)) },
						state.sorts.map((value) =>
							el(dom, 'option', { value, selected: value === state.query.sort }, [t(`grid.sort.${value}`)]),
						),
					),
				])
			: null;
	const count = el(dom, 'p', { class: 'ss-grid__count', role: 'status', 'aria-live': 'polite' }, [
		state.status === 'loading' ? t('grid.loading') : state.total === null ? '' : t('grid.count', { count: state.total }),
	]);
	const empty =
		state.status === 'ready' && state.items.length === 0
			? (slots.empty ?? el(dom, 'p', { class: 'ss-grid__empty' }, [t('grid.empty')]))
			: null;
	const error = state.status === 'error' ? el(dom, 'p', { class: 'ss-grid__error', role: 'alert' }, [state.error ?? '']) : null;
	const pages = state.links.pages.map((entry) =>
		entry === null ? el(dom, 'span', { class: 'ss-grid__gap', 'aria-hidden': 'true' }, ['…']) : link(entry.search, entry.page),
	);
	const pager =
		state.links.prev || state.links.next || pages.length > 1
			? el(dom, 'nav', { class: 'ss-grid__pager', 'aria-label': t('grid.pagination') }, [
					state.links.prev ? link(state.links.prev, state.query.page - 1, t('grid.prev'), 'prev') : null,
					pages.length > 1 ? pages : null,
					state.links.next ? link(state.links.next, state.query.page + 1, t('grid.next'), 'next') : null,
				])
			: null;
	const more = () => {
		local.focusFrom = state.items.length;
		follow(actions.loadMore(), { replace: true });
	};
	const button =
		state.hasMore && state.pagination !== 'links'
			? el(
					dom,
					'button',
					{
						type: 'button',
						class: 'ss-grid__more',
						'data-k': 'more',
						'aria-busy': state.appending ? 'true' : null,
						onclick: more,
					},
					[t('grid.more')],
				)
			: null;
	local.io?.disconnect();
	if (button && state.pagination === 'infinite' && typeof win?.IntersectionObserver === 'function') {
		local.io = new win.IntersectionObserver(
			(/** @type {any[]} */ entries) => {
				if (entries.some((entry) => entry.isIntersecting)) follow(actions.loadMore(), { replace: true });
			},
			{ rootMargin: '400px 0px' },
		);
		local.io.observe(button);
	}
	const root = el(
		dom,
		'section',
		{
			class: 'ss-grid',
			role: 'region',
			'aria-label': t('grid.label'),
			'aria-busy': state.status === 'loading' ? 'true' : 'false',
		},
		[
			slots.before ?? null,
			el(dom, 'div', { class: 'ss-grid__bar' }, [count, sort]),
			error,
			empty,
			list,
			button,
			pager,
			slots.after ?? null,
		],
	);
	refocus(dom, actions, root);
	// after a keyboard or pointer "load more", focus moves to the first new card (screen readers continue there)
	const from = local.focusFrom;
	if (typeof from === 'number' && !state.appending && state.status !== 'loading' && state.items.length > from) {
		local.focusFrom = null;
		queueMicrotask(() => local.root?.querySelectorAll?.('.ss-grid__list > li')[from]?.querySelector?.('a')?.focus?.());
	}
	return root;
};

export const styles = `${cardStyles}.ss-grid{display:flex;flex-direction:column;gap:var(--ss-space-3);color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-grid__bar{display:flex;justify-content:space-between;align-items:center;gap:var(--ss-space-2);flex-wrap:wrap}
.ss-grid__count{margin:0;color:var(--ss-color-text-muted)}.ss-grid__sort{display:flex;gap:var(--ss-space-2);align-items:center}
.ss-grid__list{display:grid;grid-template-columns:repeat(var(--ss-grid-m,2),minmax(0,1fr));gap:var(--ss-space-3);margin:0;padding:0;list-style:none}
@media (min-width:768px){.ss-grid__list{grid-template-columns:repeat(var(--ss-grid-t,3),minmax(0,1fr))}}
@media (min-width:1024px){.ss-grid__list{grid-template-columns:repeat(var(--ss-grid-d,4),minmax(0,1fr));gap:var(--ss-space-4)}}
.ss-grid__pager{display:flex;flex-wrap:wrap;justify-content:center;gap:var(--ss-space-1)}
.ss-grid__page,.ss-grid__more{min-width:2.75rem;min-height:2.75rem;display:inline-flex;align-items:center;justify-content:center;padding:0 var(--ss-space-3);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);color:var(--ss-color-text);background:var(--ss-color-surface);text-decoration:none;font:inherit;cursor:pointer}
.ss-grid__page[aria-current]{background:var(--ss-color-primary);color:var(--ss-color-on-primary);border-color:var(--ss-color-primary)}
.ss-grid__more{align-self:center}.ss-grid__page:focus-visible,.ss-grid__more:focus-visible,.ss-grid select:focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}
.ss-grid__error{color:var(--ss-color-danger)}.ss-grid__gap{align-self:center}
`;
