/**
 * Mode A renderer of `filters`: facets as labelled fieldsets of checkboxes (radios for single-select), a price range,
 * an in-stock toggle and removable active-filter chips. Layouts: `sidebar` (always open), `sheet` (a button opens a
 * modal panel: Escape closes, focus returns) and `top_bar` (one disclosure per facet). Every change is written to the
 * URL, which the grid follows.
 */
import { createTranslator } from '../headless/strings.js';
import { boot, el, memo, navigate, pageData, refocus, trapTab, windowOf } from './dom.js';

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/filters.js').createFilters>['state']>,
 *   actions: ReturnType<typeof import('../headless/filters.js').createFilters>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike, slots?: Record<string, any> }} props
 */
export const render = ({ state, actions, strings, dom, slots = {} }) => {
	const t = createTranslator(strings);
	const win = windowOf(dom);
	const local = memo(actions);
	boot(
		dom,
		actions,
		(search) => actions.start({ search, data: pageData(dom, state.pageId) }),
		(search) => actions.setSearch(search),
	);
	/** @param {Promise<any>} pending */
	const follow = (pending) =>
		pending.then((result) => {
			if (result.ok) navigate(win, result.value.search);
		});
	/** @param {{ key: string, label: string }} facet */
	const label = (facet) => facet.label || strings[`filters.facet.${facet.key}`] || facet.key;
	const id = (/** @type {string} */ name) => `ss-filters-${name.replace(/[^\w-]/g, '_')}`;
	const factor = 10 ** state.digits;

	const groups = state.facets.map((facet) => {
		let body;
		if (facet.type === 'range') {
			/** @param {'min' | 'max'} bound */
			const input = (bound) =>
				el(dom, 'label', { class: 'ss-filters__bound' }, [
					t(`filters.${bound}`),
					el(dom, 'input', {
						type: 'number',
						name: bound,
						'data-k': bound,
						min: '0',
						step: 'any',
						inputmode: 'decimal',
						value: state.query[bound] === null ? null : String(state.query[bound] / factor),
						placeholder: facet.range ? String(Math.floor(facet.range[bound] / factor)) : null,
					}),
				]);
			const form = el(
				dom,
				'form',
				{
					class: 'ss-filters__range',
					onsubmit: (/** @type {any} */ event) => {
						event.preventDefault();
						/** @param {string} name */
						const read = (name) => {
							const raw = event.target.elements?.[name]?.value ?? '';
							return raw === '' || !(Number(raw) >= 0) ? null : Math.round(Number(raw) * factor);
						};
						follow(actions.setRange(read('min'), read('max')));
					},
				},
				[
					input('min'),
					input('max'),
					el(dom, 'button', { type: 'submit', class: 'ss-filters__apply', 'data-k': 'apply' }, [t('filters.apply')]),
				],
			);
			body = [form];
		} else {
			body = facet.values.map((entry) =>
				el(dom, 'label', { class: 'ss-filters__option' }, [
					el(dom, 'input', {
						type: facet.multi || facet.type === 'toggle' ? 'checkbox' : 'radio',
						name: id(facet.key),
						value: entry.value,
						'data-k': `${facet.key}:${entry.value}`,
						checked: entry.selected,
						onchange: () => follow(actions.toggle(facet.key, entry.value)),
					}),
					el(dom, 'span', {}, [facet.type === 'toggle' ? label(facet) : entry.value]),
					state.counts
						? el(dom, 'span', { class: 'ss-filters__count' }, [t('filters.count', { count: entry.count })])
						: null,
				]),
			);
		}
		if (body.length === 0) return null;
		return state.layout === 'top_bar'
			? el(dom, 'details', { class: 'ss-filters__group' }, [
					el(dom, 'summary', {}, [label(facet)]),
					el(dom, 'div', { class: 'ss-filters__drop' }, body),
				])
			: el(dom, 'fieldset', { class: 'ss-filters__group' }, [el(dom, 'legend', {}, [label(facet)]), body]);
	});

	const chips = state.filtered
		? el(dom, 'ul', { class: 'ss-filters__active', 'aria-label': t('filters.active') }, [
				...state.active.map((entry) =>
					el(dom, 'li', {}, [
						el(
							dom,
							'button',
							{
								type: 'button',
								class: 'ss-filters__chip',
								'data-k': 'clear',
								'aria-label': t('filters.remove', { value: entry.value }),
								onclick: () => follow(actions.toggle(entry.key, entry.value)),
							},
							[entry.value, el(dom, 'span', { 'aria-hidden': 'true' }, [' ×'])],
						),
					]),
				),
				el(dom, 'li', {}, [
					el(
						dom,
						'button',
						{ type: 'button', class: 'ss-filters__clear', 'data-k': 'clear', onclick: () => follow(actions.clear()) },
						[t('filters.clear')],
					),
				]),
			])
		: null;

	const sheet = state.layout === 'sheet';
	const close = () => {
		void actions.setOpen(false);
		queueMicrotask(() => local.toggle?.focus?.());
	};
	const panel = el(
		dom,
		'div',
		{
			id: 'ss-filters-panel',
			class: 'ss-filters__panel',
			role: sheet ? 'dialog' : null,
			'aria-modal': sheet ? 'true' : null,
			'aria-label': sheet ? t('filters.label') : null,
			hidden: sheet && !state.open,
			onkeydown: (/** @type {any} */ event) => {
				if (!sheet) return;
				if (event.key === 'Escape') close();
				else trapTab(event, local.panel);
			},
		},
		[
			sheet ? el(dom, 'button', { type: 'button', class: 'ss-filters__close', onclick: close }, [t('filters.done')]) : null,
			chips,
			groups,
			state.status === 'error' ? el(dom, 'p', { role: 'alert', class: 'ss-filters__error' }, [state.error ?? '']) : null,
		],
	);
	const toggle = sheet
		? el(
				dom,
				'button',
				{
					type: 'button',
					class: 'ss-filters__toggle',
					'data-k': 'toggle',
					'aria-expanded': String(state.open),
					'aria-controls': 'ss-filters-panel',
					onclick: () => {
						void actions.setOpen(!state.open);
						queueMicrotask(() => local.panel?.querySelector?.('button, input, summary')?.focus?.());
					},
				},
				[t('filters.open', { count: state.active.length })],
			)
		: null;
	local.toggle = toggle;
	local.panel = panel;
	const root = el(
		dom,
		state.layout === 'sidebar' ? 'aside' : 'div',
		{ class: `ss-filters ss-filters--${state.layout}`, role: 'region', 'aria-label': t('filters.label') },
		[slots.before ?? null, toggle, panel, slots.after ?? null],
	);
	refocus(dom, actions, root);
	return root;
};

export const styles = `.ss-filters{color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-filters__panel{display:flex;flex-direction:column;gap:var(--ss-space-3)}
.ss-filters--top_bar .ss-filters__panel{flex-direction:row;flex-wrap:wrap;align-items:flex-start}
.ss-filters--sheet .ss-filters__panel{position:fixed;inset:auto 0 0 0;max-height:80vh;overflow:auto;z-index:var(--ss-z-overlay,50);padding:var(--ss-space-4);background:var(--ss-color-surface);border-radius:var(--ss-radius-lg) var(--ss-radius-lg) 0 0;box-shadow:var(--ss-shadow-lg)}
.ss-filters__panel[hidden]{display:none}
.ss-filters__group{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--ss-space-1)}
.ss-filters__group legend,.ss-filters__group summary{font-weight:var(--ss-font-weight-bold,600);margin-bottom:var(--ss-space-1);cursor:pointer}
.ss-filters__drop{display:flex;flex-direction:column;gap:var(--ss-space-1);padding:var(--ss-space-2)}
.ss-filters__option{display:flex;gap:var(--ss-space-2);align-items:center;min-height:2.75rem}.ss-filters__count{color:var(--ss-color-text-muted)}
.ss-filters__range{display:flex;gap:var(--ss-space-2);align-items:flex-end;flex-wrap:wrap}.ss-filters__bound{display:flex;flex-direction:column}
.ss-filters__bound input{width:6rem;padding:var(--ss-space-2);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);font:inherit}
.ss-filters__active{display:flex;flex-wrap:wrap;gap:var(--ss-space-1);margin:0;padding:0;list-style:none}
.ss-filters button{min-height:2.75rem;padding:0 var(--ss-space-3);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-full);background:var(--ss-color-surface);color:var(--ss-color-text);font:inherit;cursor:pointer}
.ss-filters__apply,.ss-filters__toggle{background:var(--ss-color-primary)!important;color:var(--ss-color-on-primary)!important;border-color:var(--ss-color-primary)!important}
.ss-filters :focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}.ss-filters__error{color:var(--ss-color-danger)}
`;
