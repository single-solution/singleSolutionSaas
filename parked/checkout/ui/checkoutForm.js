/**
 * Mode A default renderer of the `checkout_form` element: contact, delivery method, address (when the method needs
 * one) and custom fields, built from the form schema — labels, required marks, autocomplete tokens, input types and
 * limits all come from the website's settings. Errors are tied to their inputs (`aria-invalid`, `aria-describedby`;
 * review lesson A20). Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-form { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-3); min-height: var(--ss-form-min-height, 12rem); }
.ss-form fieldset { border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-md); padding: var(--ss-space-3); display: grid; gap: var(--ss-space-2); }
.ss-form label { display: grid; gap: var(--ss-space-1); }
.ss-form input, .ss-form select, .ss-form textarea { font: inherit; color: inherit; background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-2); }
.ss-form [aria-invalid="true"] { border-color: var(--ss-color-danger); }
.ss-form :focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-form__error { color: var(--ss-color-danger); }
.ss-form__status { color: var(--ss-color-text-muted); }
`;

const TYPES = Object.freeze({ email: 'email', tel: 'tel', postal: 'text', text: 'text' });

/**
 * @param {{ state: import('../headless/checkoutForm.js').FormState, actions: { setField: (g: any, k: string, v: unknown) => unknown, setDelivery: (k: string) => unknown, setCountry: (c: string) => unknown, check: () => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const form = state.form;
	if (!form) return el(dom, 'section', { class: 'ss-form', 'aria-busy': 'true' }, [statusLine(dom, 'ss-form', state.error)]);
	/** @param {'contact' | 'address' | 'custom'} group @param {any} field */
	const input = (group, field) => {
		const id = `ss-form-${group}-${field.key}`;
		const path = `/${group}/${field.key}`;
		const error = state.errors[path] ?? null;
		const value = state.values[group]?.[field.key];
		const common = {
			id,
			name: `${group}.${field.key}`,
			autocomplete: field.autocomplete || 'off',
			...(field.required ? { required: '', 'aria-required': 'true' } : {}),
			...(error ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-error` } : {}),
		};
		const control =
			field.kind === 'select'
				? el(dom, 'select', common, [
						el(dom, 'option', { value: '' }, ['']),
						...(field.options ?? []).map((/** @type {string} */ o) =>
							el(dom, 'option', { value: o, ...(o === value ? { selected: '' } : {}) }, [o]),
						),
					])
				: field.kind === 'textarea'
					? el(dom, 'textarea', { ...common, maxlength: String(field.max_length) }, [typeof value === 'string' ? value : ''])
					: field.kind === 'checkbox'
						? el(dom, 'input', { ...common, type: 'checkbox', ...(value === true ? { checked: '' } : {}) })
						: el(dom, 'input', {
								...common,
								type: /** @type {any} */ (TYPES)[field.kind] ?? 'text',
								maxlength: String(field.max_length),
								value: typeof value === 'string' ? value : '',
							});
		on(control, field.kind === 'checkbox' ? 'change' : 'input', (event) =>
			actions.setField(
				group,
				field.key,
				field.kind === 'checkbox' ? Boolean(event.target?.checked) : (event.target?.value ?? ''),
			),
		);
		return el(dom, 'label', { for: id }, [
			el(dom, 'span', {}, [field.required ? t('checkout_form.required_label', { label: field.label }) : field.label]),
			control,
			error ? el(dom, 'span', { id: `${id}-error`, class: 'ss-form__error' }, [error]) : null,
		]);
	};
	const methods = el(dom, 'fieldset', {}, [
		el(dom, 'legend', {}, [t('checkout_form.delivery')]),
		...form.deliveryMethods.map((/** @type {any} */ method) =>
			el(dom, 'label', {}, [
				on(
					el(dom, 'input', {
						type: 'radio',
						name: 'deliveryMethod',
						value: method.key,
						...(method.key === state.values.deliveryMethod ? { checked: '' } : {}),
					}),
					'change',
					() => actions.setDelivery(method.key),
				),
				el(dom, 'span', {}, [method.label]),
			]),
		),
	]);
	const countries =
		form.countries.length > 1
			? on(
					el(
						dom,
						'select',
						{ 'aria-label': t('checkout_form.country'), autocomplete: 'country' },
						form.countries.map((/** @type {string} */ c) =>
							el(dom, 'option', { value: c, ...(c === form.country ? { selected: '' } : {}) }, [c]),
						),
					),
					'change',
					(event) => actions.setCountry(event.target?.value),
				)
			: null;
	return on(
		el(dom, 'form', { class: 'ss-form', novalidate: '', 'aria-label': t('checkout_form.title') }, [
			slots.before ?? null,
			el(dom, 'fieldset', {}, [
				el(dom, 'legend', {}, [t('checkout_form.contact')]),
				...form.contact.map((/** @type {any} */ f) => input('contact', f)),
			]),
			methods,
			state.needsAddress
				? el(dom, 'fieldset', {}, [
						el(dom, 'legend', {}, [t('checkout_form.address')]),
						countries,
						...form.address.map((/** @type {any} */ f) => input('address', f)),
					])
				: null,
			form.custom.length > 0
				? el(
						dom,
						'fieldset',
						{},
						form.custom.map((/** @type {any} */ f) => input('custom', f)),
					)
				: null,
			statusLine(dom, 'ss-form', state.error),
			slots.after ?? null,
		]),
		'submit',
		(event) => {
			event.preventDefault?.();
			actions.check();
		},
	);
};
