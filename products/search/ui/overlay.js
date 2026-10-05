/**
 * Mode A renderer of `overlay`, built only on headless/overlay.js. Variants:
 *
 * - `modal` (default): a search button (and the configured shortcut, outside text fields) opens a dialog;
 * - `inline`: the search box sits in the page and its listbox opens below it.
 *
 * The input is an ARIA 1.2 combobox (`aria-expanded`, `aria-controls`, `aria-autocomplete="list"`,
 * `aria-activedescendant`) over a listbox of options (`aria-selected`), with a polite status line. Arrow keys move
 * through results or suggestions, Enter opens the active option or the website's results page (a real GET form, so
 * it also works as plain navigation), Escape clears the active option, then closes and returns focus, Tab stays in
 * the dialog. Design tokens only (`--ss-*`), reduced motion respected, slots `before`, `after` and `empty`.
 */
import { createTranslator } from '../headless/strings.js';
import { browserStorage, el, memo, refocus, trapTab } from './dom.js';

/**
 * @param {{ state: import('../headless/overlay.js').OverlayState, actions: any, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} props
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const win = dom.defaultView ?? null;
	const local = memo(actions);
	const inline = theme.variant === 'inline';
	const listId = `${local.id}-list`;
	const optionId = (/** @type {number} */ index) => `${local.id}-opt-${index}`;
	if (!local.booted) {
		local.booted = true;
		queueMicrotask(() => {
			void actions.attachStorage(browserStorage(win));
			void actions.start();
		});
		if (state.hotkey !== 'none')
			win?.document?.addEventListener?.('keydown', (/** @type {any} */ event) => {
				const target = event.target;
				const typing = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);
				const hit =
					state.hotkey === '/'
						? event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey
						: event.key?.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey);
				if (!hit) return;
				event.preventDefault();
				open();
			});
	}
	const open = () => {
		void actions.open();
		queueMicrotask(() => local.input?.focus?.());
	};
	const close = () => {
		void actions.close();
		if (!inline) queueMicrotask(() => local.button?.focus?.());
	};
	/** @param {Promise<any>} pending */
	const follow = async (pending) => {
		const result = await pending;
		if (result.ok && result.value.href) win?.location?.assign?.(result.value.href);
	};
	const expanded = state.options.length > 0 && (inline ? state.open : true);
	const groups = /** @type {Record<string, string>} */ ({
		completion: t('overlay.group.completions'),
		history: t('overlay.group.history'),
		popular: t('overlay.group.popular'),
		recent: t('overlay.group.recent'),
	});
	const options = state.options.map((option, index) =>
		el(
			dom,
			'li',
			{
				id: optionId(index),
				role: 'option',
				'aria-selected': String(index === state.active),
				class: `ss-search__option ss-search__option--${option.kind}`,
				onmousedown: (/** @type {any} */ event) => event.preventDefault(),
				onclick: (/** @type {any} */ event) => {
					event.preventDefault();
					void follow(actions.choose(index));
				},
			},
			[
				state.showImages && option.image
					? el(dom, 'img', {
							src: option.image,
							alt: '',
							width: '40',
							height: '40',
							loading: 'lazy',
							class: 'ss-search__image',
						})
					: null,
				el(dom, 'span', { class: 'ss-search__label' }, [option.label]),
				option.kind !== 'result' ? el(dom, 'span', { class: 'ss-search__kind' }, [groups[option.kind] ?? '']) : null,
				option.detail ? el(dom, 'span', { class: 'ss-search__detail' }, [option.detail]) : null,
			],
		),
	);
	const input = el(dom, 'input', {
		type: 'search',
		name: 'q',
		'data-k': 'q',
		role: 'combobox',
		autocomplete: 'off',
		spellcheck: 'false',
		enterkeyhint: 'search',
		'aria-label': t('overlay.input'),
		placeholder: t('overlay.placeholder'),
		'aria-expanded': String(expanded),
		'aria-controls': listId,
		'aria-autocomplete': 'list',
		'aria-activedescendant': state.active >= 0 ? optionId(state.active) : null,
		value: state.q,
		oninput: (/** @type {any} */ event) => void actions.setQuery(event.target.value),
		onfocus: () => (inline ? void actions.open() : undefined),
		onkeydown: (/** @type {any} */ event) => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (inline && !state.open) void actions.open();
				void actions.move(event.key === 'ArrowDown' ? 1 : -1);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				if (state.active >= 0) void actions.clearActive();
				else if (inline) void actions.setQuery('');
				else close();
			}
		},
	});
	const empty = state.status === 'ready' && state.options.length === 0;
	const panel = [
		slots.before ?? null,
		el(
			dom,
			'form',
			{
				role: 'search',
				class: 'ss-search__form',
				action: state.href.split('?')[0],
				method: 'get',
				onsubmit: (/** @type {any} */ event) => {
					event.preventDefault();
					void follow(actions.submit());
				},
			},
			[input, el(dom, 'button', { type: 'submit', class: 'ss-search__go', 'data-k': 'go' }, [t('overlay.submit')])],
		),
		el(dom, 'p', { class: 'ss-search__status', role: 'status', 'aria-live': 'polite' }, [state.message ?? '']),
		el(
			dom,
			'ul',
			{ id: listId, role: 'listbox', class: 'ss-search__list', 'aria-label': t('overlay.results'), hidden: !expanded },
			options,
		),
		empty ? (slots.empty ?? null) : null,
		slots.after ?? null,
	];
	if (inline) {
		const root = el(dom, 'div', { class: 'ss-search ss-search--inline', 'aria-label': t('overlay.label') }, panel);
		local.input = input;
		refocus(dom, actions, root);
		return root;
	}
	const dialog = el(
		dom,
		'div',
		{
			class: 'ss-search__dialog',
			role: 'dialog',
			'aria-modal': 'true',
			'aria-label': t('overlay.label'),
			hidden: !state.open,
			onkeydown: (/** @type {any} */ event) => trapTab(event, local.dialog),
		},
		[
			...panel,
			el(dom, 'button', { type: 'button', class: 'ss-search__close', 'data-k': 'close', onclick: close }, [
				t('overlay.close'),
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
			onclick: open,
		},
		[t('overlay.open')],
	);
	Object.assign(local, { input, button, dialog });
	const root = el(dom, 'div', { class: 'ss-search ss-search--modal' }, [button, dialog]);
	refocus(dom, actions, root);
	return root;
};

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `.ss-search{color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-search button{min-height:2.75rem;padding:0 var(--ss-space-3);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);background:var(--ss-color-surface);color:var(--ss-color-text);font:inherit;cursor:pointer}
.ss-search .ss-search__go{background:var(--ss-color-primary);color:var(--ss-color-on-primary);border-color:transparent}
.ss-search__dialog{position:fixed;inset:0;z-index:var(--ss-z-overlay,60);display:flex;flex-direction:column;gap:var(--ss-space-2);padding:var(--ss-space-4);background:var(--ss-color-surface);overflow:auto}
@media (min-width:768px){.ss-search__dialog{inset:10vh auto auto 50%;transform:translateX(-50%);width:min(40rem,92vw);max-height:80vh;border-radius:var(--ss-radius-lg);box-shadow:var(--ss-shadow-lg)}}
.ss-search__dialog[hidden],.ss-search__list[hidden]{display:none}
.ss-search--inline{position:relative;min-height:2.75rem}
.ss-search--inline .ss-search__list{position:absolute;inset-inline:0;top:100%;z-index:var(--ss-z-overlay,60);background:var(--ss-color-surface);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);box-shadow:var(--ss-shadow-lg)}
.ss-search__form{display:flex;gap:var(--ss-space-2)}
.ss-search input{flex:1;min-height:2.75rem;padding:0 var(--ss-space-3);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);background:var(--ss-color-surface);color:var(--ss-color-text);font:inherit}
.ss-search__list{margin:0;padding:0;list-style:none;max-height:60vh;overflow:auto}
.ss-search__option{display:flex;gap:var(--ss-space-2);align-items:center;padding:var(--ss-space-2);border-radius:var(--ss-radius-sm);cursor:pointer}
.ss-search__option[aria-selected="true"],.ss-search__option:hover{background:var(--ss-color-surface-2)}
.ss-search__image{border-radius:var(--ss-radius-sm);object-fit:cover}
.ss-search__label{flex:1;min-width:0;overflow-wrap:anywhere}
.ss-search__kind,.ss-search__detail,.ss-search__status{color:var(--ss-color-text-muted);font-size:var(--ss-font-size-sm,.875rem)}
.ss-search__status{margin:0;min-height:1.25em}
.ss-search__close{align-self:flex-end}
.ss-search :focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.ss-search *{transition:none;animation:none}}
`;
