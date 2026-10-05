/**
 * Mode A default renderer of the `apply_box` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; design tokens
 * only; keyboard operable (a real form: Enter applies); errors and confirmations are announced politely; reserves its
 * minimum height (no layout shift). Variants: `inline` (always open) and `collapsible` (a disclosure button).
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/applyBox.js').ApplyBoxState} ApplyBoxState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-apply { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-3); min-height: var(--ss-apply-min-height, 3rem); }
.ss-apply__form { display: flex; gap: var(--ss-space-2); flex-wrap: wrap; }
.ss-apply__input { flex: 1 1 10rem; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm);
  padding: var(--ss-space-2); font: inherit; color: inherit; background: var(--ss-color-surface); }
.ss-apply__button { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border: 0;
  border-radius: var(--ss-radius-sm); padding: var(--ss-space-2) var(--ss-space-3); font: inherit; cursor: pointer; }
.ss-apply__button:focus-visible, .ss-apply__input:focus-visible, .ss-apply__toggle:focus-visible,
.ss-apply__remove:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-apply__toggle, .ss-apply__remove { background: none; border: 0; color: var(--ss-color-primary); font: inherit;
  cursor: pointer; text-decoration: underline; padding: 0; }
.ss-apply__list { list-style: none; margin: var(--ss-space-2) 0 0; padding: 0; }
.ss-apply__item { display: flex; justify-content: space-between; gap: var(--ss-space-2); padding: var(--ss-space-1) 0; }
.ss-apply__savings { color: var(--ss-color-success, var(--ss-color-primary)); font-weight: var(--ss-font-weight-bold, 700); }
.ss-apply__error { color: var(--ss-color-danger); }
@media (prefers-reduced-motion: reduce) { .ss-apply * { transition: none; } }
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
	for (const child of children) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * Render the element.
 * @param {{ state: ApplyBoxState, actions: { setCode: (code: string) => unknown, apply: () => unknown,
 *   remove: (code: string) => unknown, toggle: () => unknown }, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'collapsible' || state.variant === 'collapsible' ? 'collapsible' : 'inline';
	const inputId = 'ss-apply-code';
	const status = el(
		dom,
		'p',
		{ class: state.error ? 'ss-apply__error' : 'ss-apply__message', role: 'status', 'aria-live': 'polite' },
		state.error ? [state.error] : state.message ? [state.message] : [],
	);
	/** @type {any[]} */
	const body = [];
	if (variant === 'collapsible') {
		const toggle = el(
			dom,
			'button',
			{
				type: 'button',
				class: 'ss-apply__toggle',
				'aria-expanded': String(state.expanded),
				'aria-controls': 'ss-apply-panel',
			},
			[t('apply_box.toggle')],
		);
		toggle.addEventListener('click', () => actions.toggle());
		body.push(toggle);
	}
	if (variant === 'inline' || state.expanded) {
		const input = el(dom, 'input', {
			id: inputId,
			class: 'ss-apply__input',
			type: 'text',
			name: 'coupon',
			autocomplete: 'off',
			autocapitalize: 'characters',
			spellcheck: 'false',
			maxlength: '64',
			value: state.code,
			placeholder: t('apply_box.placeholder'),
			...(state.errorCode ? { 'aria-invalid': 'true' } : {}),
		});
		input.addEventListener('input', (/** @type {{ target?: { value?: string } }} */ event) =>
			actions.setCode(event.target?.value ?? ''),
		);
		const button = el(dom, 'button', { type: 'submit', class: 'ss-apply__button' }, [
			state.status === 'loading' ? t('apply_box.applying') : t('apply_box.apply'),
		]);
		if (state.status === 'loading' || state.applied.length >= state.maxCodes) button.setAttribute('disabled', '');
		const form = el(
			dom,
			'form',
			{ class: 'ss-apply__form', role: 'form', 'aria-label': t('apply_box.title'), novalidate: '' },
			[el(dom, 'label', { for: inputId, class: 'ss-apply__label' }, [t('apply_box.label')]), input, button],
		);
		form.addEventListener('submit', (/** @type {{ preventDefault?: () => void }} */ event) => {
			event.preventDefault?.();
			actions.apply();
		});
		const panel = el(dom, 'div', { id: 'ss-apply-panel' }, [form]);
		if (state.applied.length > 0)
			panel.append(
				el(
					dom,
					'ul',
					{ class: 'ss-apply__list', 'aria-label': t('apply_box.applied_list') },
					state.applied.map((entry) => {
						const remove = el(
							dom,
							'button',
							{
								type: 'button',
								class: 'ss-apply__remove',
								'aria-label': t('apply_box.remove_code', { code: entry.code }),
							},
							[t('apply_box.remove')],
						);
						remove.addEventListener('click', () => actions.remove(entry.code));
						return el(dom, 'li', { class: 'ss-apply__item' }, [
							el(dom, 'span', {}, [entry.code]),
							el(dom, 'span', {}, [entry.savingsText]),
							remove,
						]);
					}),
				),
			);
		if (state.showSavings && state.savingsText) panel.append(el(dom, 'p', { class: 'ss-apply__savings' }, [state.savingsText]));
		if (slots.success && state.applied.length > 0) panel.append(slots.success);
		body.push(panel);
	}
	return el(
		dom,
		'section',
		{
			class: `ss-apply ss-apply--${variant}`,
			role: 'region',
			'aria-label': t('apply_box.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[...(slots.before ? [slots.before] : []), ...body, status, ...(slots.after ? [slots.after] : [])],
	);
};
