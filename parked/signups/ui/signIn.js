/**
 * Mode A default renderer of the `widget` element (sign-in): a pure function of (state, actions, strings, theme, slots)
 * that returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; design tokens
 * only; keyboard operable (a real form, labelled inputs, `aria-live` errors); one-time-code autofill. Variants: `modal`
 * (dialog) and `inline`.
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/signIn.js').SignInState} SignInState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-signin { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-4); min-height: var(--ss-signin-min-height, 12rem); max-width: 28rem; }
.ss-signin--modal { box-shadow: var(--ss-shadow-lg); }
.ss-signin__form { display: grid; gap: var(--ss-space-2); }
.ss-signin__input { font: inherit; padding: var(--ss-space-2); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); }
.ss-signin__button { font: inherit; padding: var(--ss-space-2) var(--ss-space-3); border: 0; border-radius: var(--ss-radius-sm);
  background: var(--ss-color-primary); color: var(--ss-color-on-primary); cursor: pointer; }
.ss-signin__link { background: none; border: 0; padding: 0; color: var(--ss-color-primary); text-decoration: underline; cursor: pointer; font: inherit; }
.ss-signin__channels { display: flex; gap: var(--ss-space-2); }
.ss-signin__channel[aria-pressed="true"] { outline: 2px solid var(--ss-color-primary); }
.ss-signin button:focus-visible, .ss-signin input:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-signin__meta { color: var(--ss-color-text-muted); }
.ss-signin__error { color: var(--ss-color-danger); min-height: 1.25em; }
@media (prefers-reduced-motion: reduce) { .ss-signin * { transition: none; } }
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
	for (const child of children) if (child !== null) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * @param {DomLike} dom
 * @param {string} label
 * @param {() => unknown} onClick
 * @param {Record<string, string>} [attributes]
 */
const button = (dom, label, onClick, attributes = {}) => {
	const node = el(dom, 'button', { type: 'button', class: 'ss-signin__button', ...attributes }, [label]);
	node.addEventListener('click', () => onClick());
	return node;
};

/**
 * A form whose submit runs `onSubmit` (Enter in the input submits too).
 * @param {DomLike} dom
 * @param {Array<any>} children
 * @param {() => unknown} onSubmit
 */
const form = (dom, children, onSubmit) => {
	const node = el(dom, 'form', { class: 'ss-signin__form', novalidate: '' }, children);
	node.addEventListener('submit', (/** @type {any} */ event) => {
		event?.preventDefault?.();
		onSubmit();
	});
	return node;
};

/**
 * Render the element.
 * @param {{ state: SignInState, actions: Record<string, (...args: any[]) => Promise<unknown>>, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const modal = theme.variant !== 'inline';
	const busy = state.status === 'sending' || state.status === 'verifying';
	/** @type {any[]} */
	const body = [];
	const title = el(dom, 'h2', { class: 'ss-signin__title', id: 'ss-signin-title' }, [t('signin.title')]);

	if (state.status === 'signed_in') {
		body.push(el(dom, 'p', { role: 'status' }, [t('signin.signed_in')]));
		if (slots.signed_in) body.push(slots.signed_in);
		body.push(button(dom, t('signin.sign_out'), () => actions.signOut?.()));
	} else if (state.status === 'consent') {
		body.push(el(dom, 'h3', {}, [t('signin.consent.title')]));
		for (const doc of state.consents) {
			const box = el(dom, 'input', {
				type: 'checkbox',
				id: `ss-consent-${doc.key}`,
				...(doc.accepted ? { checked: '' } : {}),
			});
			box.addEventListener('change', (/** @type {any} */ event) =>
				actions.toggleConsent?.(doc.key, Boolean(event?.target?.checked)),
			);
			const name = doc.url
				? el(dom, 'a', { href: doc.url, target: '_blank', rel: 'noopener' }, [doc.title ?? doc.key])
				: (doc.title ?? doc.key);
			body.push(
				el(dom, 'label', { for: `ss-consent-${doc.key}` }, [box, ' ', t('signin.consent.accept', { document: '' }), name]),
			);
		}
		body.push(button(dom, t('signin.consent.continue'), () => actions.acceptConsents?.(), busy ? { disabled: '' } : {}));
	} else if (state.status === 'link_sent') {
		body.push(el(dom, 'p', { role: 'status' }, [t('signin.link.sent', { destination: state.destination ?? '' })]));
		body.push(button(dom, t('signin.code.change'), () => actions.reset?.(), { class: 'ss-signin__link' }));
	} else if (state.status === 'code_sent' || (state.status === 'verifying' && state.challengeId)) {
		const numeric = !/[A-Z]/.test(state.code) && state.codeLength > 0;
		const input = el(dom, 'input', {
			id: 'ss-signin-code',
			class: 'ss-signin__input',
			name: 'code',
			value: state.code,
			inputmode: numeric ? 'numeric' : 'text',
			maxlength: String(state.codeLength + 4),
			...(state.autofill ? { autocomplete: 'one-time-code' } : { autocomplete: 'off' }),
		});
		input.addEventListener('input', (/** @type {any} */ event) => actions.setCode?.(String(event?.target?.value ?? '')));
		body.push(el(dom, 'p', { role: 'status' }, [t('signin.code.sent', { destination: state.destination ?? '' })]));
		body.push(
			form(
				dom,
				[
					el(dom, 'label', { for: 'ss-signin-code' }, [t('signin.code.label')]),
					input,
					el(dom, 'button', { type: 'submit', class: 'ss-signin__button', ...(busy ? { disabled: '' } : {}) }, [
						t('signin.code.verify'),
					]),
				],
				() => actions.verify?.(),
			),
		);
		body.push(button(dom, t('signin.code.resend'), () => actions.requestCode?.(), { class: 'ss-signin__link' }));
		body.push(button(dom, t('signin.code.change'), () => actions.reset?.(), { class: 'ss-signin__link' }));
	} else {
		const email = state.method === 'magic_link' || state.channel === 'email';
		if (state.method === 'otp' && state.channels.length > 1) {
			body.push(
				el(
					dom,
					'div',
					{ class: 'ss-signin__channels', role: 'group', 'aria-label': t('signin.channel.label') },
					state.channels.map((channel) =>
						button(dom, t(`signin.channel.${channel}`), () => actions.setChannel?.(channel), {
							class: 'ss-signin__channel ss-signin__button',
							'aria-pressed': String(channel === state.channel),
						}),
					),
				),
			);
		}
		const input = el(dom, 'input', {
			id: 'ss-signin-identifier',
			class: 'ss-signin__input',
			name: 'identifier',
			value: state.identifier,
			type: email ? 'email' : 'tel',
			autocomplete: email ? 'email' : 'tel',
			inputmode: email ? 'email' : 'tel',
		});
		input.addEventListener('input', (/** @type {any} */ event) => actions.setIdentifier?.(String(event?.target?.value ?? '')));
		const submit = state.method === 'otp' ? () => actions.requestCode?.() : () => actions.requestLink?.();
		body.push(el(dom, 'p', { class: 'ss-signin__meta' }, [t('signin.intro')]));
		body.push(
			form(
				dom,
				[
					el(dom, 'label', { for: 'ss-signin-identifier' }, [
						t(email ? 'signin.identifier.email' : 'signin.identifier.phone'),
					]),
					input,
					el(dom, 'button', { type: 'submit', class: 'ss-signin__button', ...(busy ? { disabled: '' } : {}) }, [
						t(state.method === 'otp' ? 'signin.send_code' : 'signin.send_link'),
					]),
				],
				submit,
			),
		);
		if (state.method === 'otp' && state.methods.includes('magic_link'))
			body.push(button(dom, t('signin.send_link'), () => actions.setMethod?.('magic_link'), { class: 'ss-signin__link' }));
	}
	if (busy) body.push(el(dom, 'p', { class: 'ss-signin__meta' }, [t('signin.working')]));
	const error = el(
		dom,
		'p',
		{ class: 'ss-signin__error', role: 'alert', 'aria-live': 'assertive' },
		state.error ? [state.error] : [],
	);
	const close = modal
		? [button(dom, t('signin.close'), () => actions.reset?.(), { class: 'ss-signin__link', 'aria-label': t('signin.close') })]
		: [];
	return el(
		dom,
		modal ? 'div' : 'section',
		{
			class: `ss-signin ss-signin--${modal ? 'modal' : 'inline'}`,
			role: modal ? 'dialog' : 'region',
			...(modal ? { 'aria-modal': 'true' } : {}),
			'aria-labelledby': 'ss-signin-title',
			'aria-busy': String(busy),
		},
		[...(slots.before ? [slots.before] : []), ...close, title, ...body, error, ...(slots.after ? [slots.after] : [])],
	);
};
