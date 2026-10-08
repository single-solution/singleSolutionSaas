/**
 * Helpers the Accounts widgets share: the widget texts, the problem answers of the API turned into widget texts, and
 * labelled fields (custom fields and the terms checkbox included). Text is always set as text, never as HTML.
 * @module
 */
import { formatText } from '@ss/app-kit/widget';
import { element } from './dom.js';

/** @typedef {{ ok: boolean, status: number, data: any }} Answer status 0 when signed out or unreachable */
/** @typedef {(key: string) => string} Texts */

/**
 * @typedef {object} CustomField
 * @property {string} key
 * @property {string} label
 * @property {'text' | 'number' | 'date' | 'choice'} type
 * @property {string[]} options
 * @property {boolean} required
 */

/** Problem codes with a widget text of their own (`error.<code>`). */
const OWN_TEXT = new Set([
	'sign_in_failed',
	'blocked',
	'pending_approval',
	'sign_up_closed',
	'terms_required',
	'risk_refused',
	'already_exists',
	'code_invalid',
	'too_soon',
	'notifications_not_connected',
	'not_sent',
	'signed_out',
	'rate_limited',
	'cancelled',
	'provider_failed',
]);

/**
 * The widget texts of a config: the website's text, else the key.
 * @param {{ texts: Record<string, string> }} config
 * @returns {Texts}
 */
export const textsOf = (config) => (key) => config.texts[key] ?? key;

/**
 * The code of an RFC 9457 problem (the end of its `type`), or ''.
 * @param {unknown} data
 */
export const problemCode = (data) => {
	const type = /** @type {{ type?: unknown } | null} */ (data)?.type;
	return typeof type === 'string' ? type.slice(type.lastIndexOf('/') + 1) : '';
};

/**
 * The widget text for a failed answer.
 * @param {Texts} t
 * @param {Answer} answer
 */
export const errorText = (t, answer) => {
	const data = answer.data ?? {};
	const code = problemCode(data);
	if (code === 'weak_password' || code === 'validation_failed') {
		const detail = code === 'validation_failed' ? (data.errors?.[0]?.message ?? data.detail) : data.detail;
		return typeof detail === 'string' && detail !== '' ? detail : t('error.generic');
	}
	if (code === 'locked')
		return typeof data.lockedUntil === 'string'
			? formatText(t('error.locked'), { time: new Date(data.lockedUntil).toLocaleString() })
			: t('error.rate_limited');
	return OWN_TEXT.has(code) ? t(`error.${code}`) : t('error.generic');
};

/**
 * An http(s) address, or null (addresses from answers are only ever used as links when they are web pages).
 * @param {unknown} value
 * @returns {string | null}
 */
export const webAddress = (value) => {
	try {
		const url = new URL(String(value));
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
};

/** Set the text of a status line. @param {Element} node @param {string} text */
export const say = (node, text) => node.replaceChildren(text);

/** @param {Element} node @param {boolean} hidden */
export const setHidden = (node, hidden) => {
	if (hidden) node.setAttribute('hidden', '');
	else node.removeAttribute('hidden');
};

/**
 * Builders of labelled fields with ids unique inside one widget.
 * @param {Document} doc
 * @param {string} prefix
 */
export const fieldMaker = (doc, prefix) => {
	let n = 0;
	/**
	 * A label and its input in one wrapper.
	 * @param {string} tag @param {string} label @param {Record<string, string>} [attributes]
	 */
	const field = (tag, label, attributes = {}) => {
		n += 1;
		const id = `${prefix}-${n}`;
		const input = /** @type {HTMLInputElement} */ (element(doc, tag, { id, ...attributes }));
		const wrap = element(doc, 'div', { class: 'field' });
		wrap.append(element(doc, 'label', { for: id }, label), input);
		return { wrap, input };
	};
	/** A checkbox with its text. @param {string} label */
	const check = (label) => {
		const input = /** @type {HTMLInputElement} */ (element(doc, 'input', { type: 'checkbox' }));
		const wrap = element(doc, 'label', { class: 'check' });
		wrap.append(input, doc.createTextNode(label));
		return { wrap, input };
	};
	return { field, check };
};

/** @typedef {ReturnType<typeof fieldMaker>} FieldMaker */

/**
 * The inputs of the merchant's custom fields.
 * @param {Document} doc
 * @param {FieldMaker} make
 * @param {Texts} t
 * @param {ReadonlyArray<CustomField>} fields
 * @param {{ values?: Record<string, unknown>, required?: boolean }} [options] `required`: mark required fields
 */
export const customInputs = (doc, make, t, fields, { values = {}, required = false } = {}) => {
	const inputs = fields.map((definition) => {
		const attributes = /** @type {Record<string, string>} */ (
			definition.type === 'number' ? { type: 'number', step: 'any' } : definition.type === 'date' ? { type: 'date' } : {}
		);
		if (required && definition.required) attributes.required = '';
		const made = make.field(definition.type === 'choice' ? 'select' : 'input', definition.label, attributes);
		if (definition.type === 'choice')
			made.input.append(
				element(doc, 'option', { value: '' }, t('fields.choose')),
				...definition.options.map((option) => element(doc, 'option', { value: option }, option)),
			);
		const value = values[definition.key];
		made.input.value = value === undefined || value === null ? '' : String(value);
		return { definition, ...made };
	});
	return {
		nodes: inputs.map((made) => made.wrap),
		/**
		 * The values: numbers as numbers; `keepEmpty` sends '' for an emptied field (an update clears it).
		 * @param {boolean} [keepEmpty]
		 * @returns {Record<string, string | number>}
		 */
		read: (keepEmpty = false) => {
			/** @type {Record<string, string | number>} */
			const out = {};
			for (const { definition, input } of inputs) {
				const raw = input.value.trim();
				if (raw === '') {
					if (keepEmpty) out[definition.key] = '';
				} else out[definition.key] = definition.type === 'number' ? Number(raw) : raw;
			}
			return out;
		},
	};
};

/**
 * The terms checkbox with a link to the terms.
 * @param {Document} doc
 * @param {Texts} t
 * @param {{ url?: unknown } | null | undefined} terms
 */
export const termsBox = (doc, t, terms) => {
	const input = /** @type {HTMLInputElement} */ (element(doc, 'input', { type: 'checkbox' }));
	const wrap = element(doc, 'label', { class: 'check' });
	wrap.append(input, doc.createTextNode(t('terms.accept')));
	const link = element(doc, 'a', { target: '_blank', rel: 'noopener noreferrer' }, t('terms.read'));
	/** @param {unknown} url */
	const point = (url) => {
		const address = webAddress(url);
		if (address) link.setAttribute('href', address);
		setHidden(link, !address);
	};
	point(terms?.url);
	wrap.append(link);
	return { wrap, input, point };
};

/**
 * A short date and time.
 * @param {unknown} value
 */
export const when = (value) => {
	const time = Date.parse(String(value));
	return Number.isNaN(time) ? '' : new Date(time).toLocaleString();
};
