/**
 * Mode A default renderer of the `capture` element — the "Notify me" form: a pure function of (state, actions,
 * strings, theme, slots) that returns DOM built with the injected `dom` (the Loader passes `document`). Built only on
 * headless/; design tokens only; labels wrap their inputs; errors and results are announced politely; keyboard
 * operable (native controls); the `button` variant collapses the form into a native disclosure (no script state).
 * Variants: `inline` (the form) and `button` (a "Notify me" disclosure).
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/notifyMe.js').NotifyMeState} NotifyMeState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-notify { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-3); min-height: var(--ss-notify-min-height, 3rem); }
.ss-notify__form { display: grid; gap: var(--ss-space-2); }
.ss-notify__field { display: grid; gap: var(--ss-space-1); }
.ss-notify__input { font: inherit; padding: var(--ss-space-2); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm);
  background: var(--ss-color-surface); color: var(--ss-color-text); }
.ss-notify__choice { display: flex; gap: var(--ss-space-2); align-items: center; }
.ss-notify__submit, .ss-notify__toggle { background: var(--ss-color-primary); color: var(--ss-color-on-primary);
  border-radius: var(--ss-radius-sm); padding: var(--ss-space-2) var(--ss-space-3); border: 0; font: inherit; cursor: pointer; }
.ss-notify__submit:focus-visible, .ss-notify__toggle:focus-visible, .ss-notify__input:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-notify__error { color: var(--ss-color-danger); }
.ss-notify__status { color: var(--ss-color-text-muted); }
@media (prefers-reduced-motion: reduce) { .ss-notify * { transition: none; } }
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
 * @param {{ state: NotifyMeState, actions: Record<string, (value?: any) => Promise<unknown>>, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'button' ? 'button' : 'inline';
	const status = el(
		dom,
		'p',
		{ class: state.status === 'error' ? 'ss-notify__error' : 'ss-notify__status', role: 'status', 'aria-live': 'polite' },
		state.message ? [state.message] : [],
	);
	const root = (/** @type {any[]} */ children) =>
		el(
			dom,
			'section',
			{
				class: `ss-notify ss-notify--${variant}`,
				role: 'region',
				'aria-label': t('capture.title'),
				'aria-busy': String(state.status === 'loading' || state.status === 'submitting'),
			},
			[...(slots.before ? [slots.before] : []), ...children, status, ...(slots.after ? [slots.after] : [])],
		);

	if (state.status === 'subscribed' || state.status === 'unsubscribed') {
		const done = [];
		if (state.status === 'subscribed' && state.identified && state.subscription?.id) {
			const stop = el(dom, 'button', { type: 'button', class: 'ss-notify__toggle' }, [t('capture.unsubscribe')]);
			stop.addEventListener('click', () => actions.unsubscribe?.());
			done.push(stop);
		}
		return root(done);
	}
	if (state.types.length === 0) return root([]);

	/** @param {string} path */
	const errorOf = (path) => state.errors[path] || '';
	/**
	 * @param {string} label
	 * @param {any} control
	 * @param {string} path
	 */
	const field = (label, control, path) => {
		const error = errorOf(path);
		if (error) control.setAttribute('aria-invalid', 'true');
		return el(dom, 'label', { class: 'ss-notify__field' }, [
			el(dom, 'span', {}, [label]),
			control,
			...(error ? [el(dom, 'span', { class: 'ss-notify__error' }, [error])] : []),
		]);
	};
	const body = [];
	if (state.types.length > 1) {
		const group = el(dom, 'fieldset', { class: 'ss-notify__field' }, [el(dom, 'legend', {}, [t('capture.title')])]);
		for (const type of state.types) {
			const radio = el(dom, 'input', { type: 'radio', name: 'ss-notify-type', value: type });
			if (type === state.type) radio.setAttribute('checked', '');
			radio.addEventListener('change', () => actions.setType?.(type));
			const family = type.startsWith('custom:') ? 'custom' : type;
			group.append(el(dom, 'label', { class: 'ss-notify__choice' }, [radio, t(`capture.type.${family}`)]));
		}
		body.push(group);
	} else {
		const family = (state.type ?? '').startsWith('custom:') ? 'custom' : (state.type ?? 'custom');
		body.push(el(dom, 'p', { class: 'ss-notify__status' }, [t(`capture.type.${family}`)]));
	}
	if (state.channels.length > 1) {
		const group = el(dom, 'fieldset', { class: 'ss-notify__field' }, [el(dom, 'legend', {}, [t('capture.channel.label')])]);
		for (const channel of state.channels) {
			const radio = el(dom, 'input', { type: 'radio', name: 'ss-notify-channel', value: channel });
			if (channel === state.channel) radio.setAttribute('checked', '');
			radio.addEventListener('change', () => actions.setChannel?.(channel));
			group.append(el(dom, 'label', { class: 'ss-notify__choice' }, [radio, t(`capture.channel.${channel}`)]));
		}
		body.push(group);
	}
	if (!state.identified || state.allowEntry) {
		const email = state.channel === 'email';
		const input = el(dom, 'input', {
			class: 'ss-notify__input',
			type: email ? 'email' : 'tel',
			name: email ? 'email' : 'phone',
			autocomplete: email ? 'email' : 'tel',
			inputmode: email ? 'email' : 'tel',
			value: email ? state.email : state.phone,
			...(state.identified ? {} : { required: '' }),
		});
		input.addEventListener('input', (/** @type {any} */ event) =>
			email ? actions.setEmail?.(event?.target?.value) : actions.setPhone?.(event?.target?.value),
		);
		body.push(field(email ? t('capture.email.label') : t('capture.phone.label'), input, email ? '/email' : '/phone'));
	}
	if (state.type === 'price_drop' && state.allowTarget) {
		const input = el(dom, 'input', {
			class: 'ss-notify__input',
			type: 'text',
			inputmode: 'numeric',
			name: 'target',
			value: state.targetAmount,
		});
		input.addEventListener('input', (/** @type {any} */ event) => actions.setTarget?.(event?.target?.value));
		body.push(field(t('capture.target.label'), input, '/threshold/targetAmount'));
	}
	if (state.requireConsent) {
		const box = el(dom, 'input', { type: 'checkbox', name: 'consent' });
		if (state.consent) box.setAttribute('checked', '');
		box.addEventListener('change', (/** @type {any} */ event) => actions.setConsent?.(event?.target?.checked === true));
		const error = errorOf('/consent');
		body.push(
			el(dom, 'label', { class: 'ss-notify__choice' }, [box, t('capture.consent')]),
			...(error ? [el(dom, 'span', { class: 'ss-notify__error' }, [error])] : []),
		);
	}
	const submit = el(dom, 'button', { type: 'submit', class: 'ss-notify__submit' }, [
		state.status === 'submitting' ? t('capture.submitting') : t('capture.submit'),
	]);
	if (state.status === 'submitting') submit.setAttribute('disabled', '');
	body.push(submit);
	const form = el(dom, 'form', { class: 'ss-notify__form', novalidate: '', 'aria-label': t('capture.title') }, body);
	form.addEventListener('submit', (/** @type {any} */ event) => {
		event?.preventDefault?.();
		actions.subscribe?.();
	});
	if (variant === 'button')
		return root([el(dom, 'details', {}, [el(dom, 'summary', { class: 'ss-notify__toggle' }, [t('capture.open')]), form])]);
	return root([form]);
};
