/**
 * Mode A renderer of `search_overlay`: a search button (and the `/` key, outside text fields) opens a modal dialog
 * with a combobox and a listbox of instant results. Arrow keys move through results, Enter opens the active result
 * or the website's results page (a real GET form, so it also works as plain navigation), Escape closes and returns
 * focus to the button, Tab stays inside the dialog.
 */
import { formatMoney } from '../headless/format.js';
import { createTranslator } from '../headless/strings.js';
import { boot, el, icon, memo, pageData, refocus, trapTab, windowOf } from './dom.js';

const SEARCH = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4';

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/searchOverlay.js').createSearchOverlay>['state']>,
 *   actions: ReturnType<typeof import('../headless/searchOverlay.js').createSearchOverlay>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 */
export const render = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	const win = windowOf(dom);
	const local = memo(actions);
	boot(dom, actions, () => {
		void actions.start({ data: pageData(dom, state.pageId) });
		if (state.hotkey)
			win?.document?.addEventListener?.('keydown', (/** @type {any} */ event) => {
				const target = event.target;
				const typing = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);
				if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
					event.preventDefault();
					open();
				}
			});
	});
	const open = () => {
		void actions.open();
		queueMicrotask(() => local.input?.focus?.());
	};
	const close = () => {
		void actions.close();
		queueMicrotask(() => local.button?.focus?.());
	};
	const go = async () => {
		const result = await actions.submit();
		if (result.ok) win?.location?.assign?.(result.value.href);
	};
	const lang = state.locale || dom.documentElement?.lang || '';
	const options = state.results.map((item, index) =>
		el(
			dom,
			'li',
			{
				id: `ss-search-${index}`,
				role: 'option',
				'aria-selected': String(index === state.active),
				class: 'ss-search__option',
			},
			[
				el(dom, 'a', { href: item.href ?? state.href, tabindex: '-1' }, [
					item.image ? el(dom, 'img', { src: item.image, alt: '', width: '40', height: '40', loading: 'lazy' }) : null,
					el(dom, 'span', {}, [item.title]),
					el(dom, 'span', { class: 'ss-search__price' }, [formatMoney(item.price, item.currency, lang)]),
				]),
			],
		),
	);
	const input = el(dom, 'input', {
		type: 'search',
		name: 'q',
		'data-k': 'q',
		role: 'combobox',
		autocomplete: 'off',
		enterkeyhint: 'search',
		'aria-label': t('search_overlay.input'),
		placeholder: t('search_overlay.placeholder'),
		'aria-expanded': String(options.length > 0),
		'aria-controls': 'ss-search-list',
		'aria-autocomplete': 'list',
		'aria-activedescendant': state.active >= 0 ? `ss-search-${state.active}` : null,
		value: state.q,
		oninput: (/** @type {any} */ event) => void actions.setQuery(event.target.value),
		onkeydown: (/** @type {any} */ event) => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				void actions.move(event.key === 'ArrowDown' ? 1 : -1);
			}
		},
	});
	const message =
		state.status === 'loading'
			? t('search_overlay.loading')
			: state.status === 'error'
				? t('storefront.error')
				: state.status === 'ready'
					? t('search_overlay.count', { count: state.results.length })
					: '';
	const dialog = el(
		dom,
		'div',
		{
			class: 'ss-search__dialog',
			role: 'dialog',
			'aria-modal': 'true',
			'aria-label': t('search_overlay.label'),
			hidden: !state.open,
			onkeydown: (/** @type {any} */ event) => {
				if (event.key === 'Escape') close();
				else trapTab(event, local.dialog);
			},
		},
		[
			el(
				dom,
				'form',
				{
					role: 'search',
					action: state.href.split('?')[0],
					method: 'get',
					onsubmit: (/** @type {any} */ event) => {
						event.preventDefault();
						void go();
					},
				},
				[input, el(dom, 'button', { type: 'submit', class: 'ss-search__go', 'data-k': 'go' }, [t('search_overlay.submit')])],
			),
			el(dom, 'p', { class: 'ss-search__status', role: 'status', 'aria-live': 'polite' }, [message]),
			el(
				dom,
				'ul',
				{ id: 'ss-search-list', role: 'listbox', class: 'ss-search__list', 'aria-label': t('search_overlay.results') },
				options,
			),
			el(dom, 'button', { type: 'button', class: 'ss-search__close', 'data-k': 'close', onclick: close }, [
				t('search_overlay.close'),
			]),
		],
	);
	const button = el(
		dom,
		'button',
		{
			type: 'button',
			class: 'ss-search__open',
			'data-k': 'open',
			'aria-haspopup': 'dialog',
			'aria-expanded': String(state.open),
			'aria-label': t('search_overlay.open'),
			onclick: open,
		},
		[icon(dom, SEARCH)],
	);
	Object.assign(local, { input, button, dialog });
	const root = el(dom, 'div', { class: 'ss-search', role: 'search', 'aria-label': t('search_overlay.label') }, [button, dialog]);
	refocus(dom, actions, root);
	return root;
};

export const styles = `.ss-search{display:inline-block;color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-search button{min-width:2.75rem;min-height:2.75rem;border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);background:var(--ss-color-surface);color:var(--ss-color-text);font:inherit;cursor:pointer}
.ss-search__dialog{position:fixed;inset:0;z-index:var(--ss-z-overlay,60);display:flex;flex-direction:column;gap:var(--ss-space-2);padding:var(--ss-space-4);background:var(--ss-color-surface);overflow:auto}
@media (min-width:768px){.ss-search__dialog{inset:10vh auto auto 50%;transform:translateX(-50%);width:min(40rem,92vw);max-height:80vh;border-radius:var(--ss-radius-lg);box-shadow:var(--ss-shadow-lg)}}
.ss-search__dialog[hidden]{display:none}.ss-search form{display:flex;gap:var(--ss-space-2)}
.ss-search input{flex:1;min-height:2.75rem;padding:0 var(--ss-space-3);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);font:inherit}
.ss-search__list{margin:0;padding:0;list-style:none}.ss-search__option a{display:flex;gap:var(--ss-space-2);align-items:center;padding:var(--ss-space-2);color:inherit;text-decoration:none;border-radius:var(--ss-radius-sm)}
.ss-search__option[aria-selected="true"] a,.ss-search__option a:hover{background:var(--ss-color-surface-2)}
.ss-search__price{margin-inline-start:auto;color:var(--ss-color-text-muted)}.ss-search__status{margin:0;color:var(--ss-color-text-muted)}
.ss-search__close{align-self:flex-end}.ss-search :focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}
`;
