/**
 * Mode A renderer of `widgets`: pure (state, actions, strings, theme, slots, dom) → DOM, on headless/ only; tokens
 * only, native controls, visible focus, polite status. Variants: `heart` (aria-pressed), `page`, `share`.
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/wishlist.js').WishlistState} WishlistState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet (CSP-safe). */
export const styles = `
.ss-wl{color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-wl--page,.ss-wl--share{background:var(--ss-color-surface);border-radius:var(--ss-radius-md);padding:var(--ss-space-3);min-height:var(--ss-wl-min-height,6rem)}
.ss-wl__heart{display:inline-grid;place-items:center;inline-size:2.5rem;block-size:2.5rem;border-radius:50%;border:1px solid var(--ss-color-border);background:var(--ss-color-surface);color:var(--ss-color-text-muted);cursor:pointer;font-size:1.25rem;line-height:1}
.ss-wl__heart[aria-pressed=true]{color:var(--ss-color-danger)}
.ss-wl button:focus-visible,.ss-wl input:focus-visible,.ss-wl a:focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}
.ss-wl__btn{background:var(--ss-color-primary);color:var(--ss-color-on-primary);border:0;border-radius:var(--ss-radius-sm);padding:var(--ss-space-1) var(--ss-space-3);font:inherit;cursor:pointer}
.ss-wl__ghost{background:none;border:1px solid var(--ss-color-border);color:inherit;border-radius:var(--ss-radius-sm);padding:var(--ss-space-1) var(--ss-space-2);font:inherit;cursor:pointer}
.ss-wl__tabs,.ss-wl__row{display:flex;flex-wrap:wrap;gap:var(--ss-space-2);align-items:center;margin-block:var(--ss-space-2)}
.ss-wl__tabs [aria-current=true]{border-color:var(--ss-color-primary)}
.ss-wl__items{list-style:none;padding:0;margin:0;display:grid;gap:var(--ss-space-3)}
.ss-wl__items--grid{grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))}
.ss-wl__item{display:grid;gap:var(--ss-space-1);align-content:start}
.ss-wl__img{inline-size:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--ss-radius-sm);background:var(--ss-color-border)}
.ss-wl__muted,.ss-wl__status{color:var(--ss-color-text-muted)}
.ss-wl__input{font:inherit;padding:var(--ss-space-1);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-sm);background:inherit;color:inherit}
.ss-wl__sr{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.ss-wl *{transition:none}}
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
	for (const child of children)
		if (child !== null && child !== undefined) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * A button; its click never reaches a surrounding card link.
 * @param {DomLike} dom
 * @param {string} label
 * @param {() => unknown} onClick
 * @param {Record<string, string>} [attributes]
 */
const button = (dom, label, onClick, attributes = {}) => {
	const node = el(dom, 'button', { type: 'button', class: 'ss-wl__ghost', ...attributes }, [label]);
	node.addEventListener('click', (/** @type {any} */ event) => {
		event?.preventDefault?.();
		event?.stopPropagation?.();
		onClick();
	});
	return node;
};

/**
 * Items of a list; `extra` adds a control per item.
 * @param {DomLike} dom
 * @param {(key: string) => string} t
 * @param {Array<any>} items
 * @param {string} layout
 * @param {((item: any) => any) | null} extra
 */
const itemList = (dom, t, items, layout, extra) =>
	el(
		dom,
		'ul',
		{ class: `ss-wl__items ss-wl__items--${layout === 'rows' ? 'rows' : 'grid'}` },
		items.map((item) => {
			const title = item.title ?? t('heart.item');
			return el(dom, 'li', { class: 'ss-wl__item' }, [
				item.image ? el(dom, 'img', { class: 'ss-wl__img', src: item.image, alt: title, loading: 'lazy' }) : null,
				item.url ? el(dom, 'a', { href: item.url }, [title]) : el(dom, 'span', {}, [title]),
				item.priceText ? el(dom, 'span', {}, [item.priceText]) : null,
				item.inStock === false ? el(dom, 'span', { class: 'ss-wl__muted' }, [t('page.out_of_stock')]) : null,
				extra ? extra(item) : null,
			]);
		}),
	);

/**
 * Render the element.
 * @param {{ state: WishlistState, actions: Record<string, (...args: any[]) => Promise<unknown>>, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = ['heart', 'page', 'share'].includes(String(theme.variant)) ? String(theme.variant) : state.view;
	const status = el(
		dom,
		'p',
		{ class: variant === 'heart' ? 'ss-wl__sr' : 'ss-wl__status', role: 'status', 'aria-live': 'polite' },
		[state.message ?? ''],
	);

	if (variant === 'heart') {
		const title = state.item?.title ?? t('heart.item');
		const heart = button(dom, state.saved ? '♥' : '♡', () => actions.toggle?.(), {
			class: 'ss-wl__heart',
			'aria-pressed': String(state.saved),
			'aria-label': t(state.saved ? 'heart.remove' : 'heart.save', { title }),
			...(state.busy || state.status === 'loading' ? { 'aria-busy': 'true' } : {}),
		});
		return el(dom, 'span', { class: 'ss-wl ss-wl--heart' }, [heart, status]);
	}

	const section = (/** @type {string} */ label, /** @type {any[]} */ children) =>
		el(
			dom,
			'section',
			{
				class: `ss-wl ss-wl--${variant}`,
				role: 'region',
				'aria-label': label,
				'aria-busy': String(state.status === 'loading'),
			},
			[slots.before ?? null, ...children, status, slots.after ?? null],
		);
	const layout = String(state.settings?.layout ?? 'grid');
	const empty = () => slots.empty ?? el(dom, 'p', { class: 'ss-wl__muted' }, [t('page.empty')]);

	if (variant === 'share') {
		const list = state.shared;
		return section(list?.name ?? t('share.title'), [
			el(dom, 'h2', {}, [list?.name ?? t('share.title')]),
			list ? (list.items.length > 0 ? itemList(dom, t, list.items, layout, null) : empty()) : null,
		]);
	}

	if (state.status === 'ready' && !state.canSave) return section(t('page.title'), [el(dom, 'p', {}, [t('page.sign_in')])]);
	const active = state.active;
	const children = [el(dom, 'h2', {}, [t('page.title')])];
	if (state.lists.length > 1)
		children.push(
			el(
				dom,
				'div',
				{ class: 'ss-wl__tabs', role: 'group', 'aria-label': t('page.lists') },
				state.lists.map((l) =>
					button(dom, t('page.list_label', { name: l.name, count: l.itemCount }), () => actions.select?.(l.id), {
						'aria-current': String(l.id === active?.id),
					}),
				),
			),
		);
	if (active) {
		children.push(el(dom, 'h3', {}, [active.name]));
		children.push(
			active.items.length > 0
				? itemList(dom, t, active.items, layout, (item) =>
						button(dom, t('page.remove'), () => actions.remove?.(active.id, item.id), {
							'aria-label': t('page.remove_item', { title: item.title ?? t('heart.item') }),
						}),
					)
				: empty(),
		);
		const tools = [];
		if (state.settings?.notify) {
			const box = el(dom, 'input', { type: 'checkbox', name: 'notify' });
			if (active.notify) box.setAttribute('checked', '');
			box.addEventListener('change', (/** @type {any} */ event) =>
				actions.setNotify?.(active.id, event?.target?.checked === true),
			);
			tools.push(el(dom, 'label', {}, [box, t('page.notify')]));
		}
		if (state.settings?.share) {
			tools.push(button(dom, t('page.share'), () => actions.share?.(active.id), { class: 'ss-wl__btn' }));
			if (active.shared) tools.push(button(dom, t('page.share.revoke'), () => actions.revoke?.(active.id)));
		}
		if (state.settings?.manageLists && state.lists.length > 0)
			tools.push(
				button(dom, t('page.delete_list'), () => actions.deleteList?.(active.id), {
					'aria-label': t('page.delete_list_named', { name: active.name }),
				}),
			);
		if (tools.length > 0) children.push(el(dom, 'div', { class: 'ss-wl__row' }, tools));
		if (state.share && state.share.listId === active.id)
			children.push(
				el(dom, 'label', { class: 'ss-wl__row' }, [
					t('page.share.link'),
					el(dom, 'input', { class: 'ss-wl__input', readonly: '', value: state.share.url ?? state.share.token }),
				]),
			);
	} else if (state.status === 'ready') children.push(empty());
	if (state.settings?.manageLists && state.lists.length < Number(state.settings?.maxLists ?? 0)) {
		const input = el(dom, 'input', { class: 'ss-wl__input', name: 'name', required: '', autocomplete: 'off' });
		let name = '';
		input.addEventListener('input', (/** @type {any} */ event) => {
			name = String(event?.target?.value ?? '');
		});
		const form = el(dom, 'form', { class: 'ss-wl__row', 'aria-label': t('page.new_list') }, [
			el(dom, 'label', {}, [t('page.new_list'), input]),
			el(dom, 'button', { type: 'submit', class: 'ss-wl__btn' }, [t('page.create')]),
		]);
		form.addEventListener('submit', (/** @type {any} */ event) => {
			event?.preventDefault?.();
			actions.createList?.(name);
		});
		children.push(form);
	}
	return section(t('page.title'), children);
};
