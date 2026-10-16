/**
 * Helpers the Accounts widgets share: the widget texts, dates in the website's Format and business time zone, the
 * problem answers of the API turned into widget texts (never the server's English detail), and labeled fields (custom
 * fields and the consent boxes included). Text is always set as text, never as HTML.
 * @module
 */
import { element, formatDate, formatMoney, formatText, viewerOf } from '@ss/app-kit/widget';

/** @typedef {import('@ss/app-kit/widget').Answer} Answer status 0 when signed out or unreachable */
/** @typedef {(key: string) => string} Texts */
/** @typedef {Parameters<typeof formatDate>[1]} Format how money and dates look (the widget config's `format`) */
/**
 * A date or time as text (`''` for a value that is not one): `datetime` by default, or `date`.
 * @typedef {(value: unknown, style?: 'date' | 'datetime') => string} Dates
 */
/**
 * What the widgets need of the widget config to show dates and money: the website's Format and its business.json
 * time zone (PLAN 0.8.10 K7, K8).
 * @typedef {{ format?: Format, timeZone?: string }} Looks
 */
/** The browser whose language and time zone a Format with an empty locale or `viewer` times follows. @typedef {{ navigator?: { language?: string } } | null | undefined} Viewer */

/**
 * @typedef {object} CustomField
 * @property {string} key
 * @property {string} label
 * @property {'text' | 'textarea' | 'number' | 'date' | 'choice' | 'multi_choice' | 'boolean' | 'email' | 'url'} type
 * @property {string[]} options
 * @property {boolean} required
 * @property {'edit' | 'view' | 'staff'} visibility who sees and changes it (A6)
 * @property {string} help
 */

/** Problem codes with a widget text of their own (`error.<code>`). */
export const OWN_TEXT = new Set([
	'sign_in_failed',
	'blocked',
	'pending_approval',
	'sign_up_closed',
	'consent_required',
	'risk_refused',
	'already_exists',
	'contact_unverified',
	'code_invalid',
	'notifications_not_connected',
	'not_sent',
	'signed_out',
	'rate_limited',
	'canceled',
	'provider_failed',
	'code_cooldown',
	'code_limit',
	'country_not_allowed',
	'method_refused',
	'self_reset_off',
	'forbidden',
	'feature_off',
	'conflict',
	'not_found',
	'two_step_required',
	'product_not_connected',
]);

/**
 * Fields a refused form may name (422 `validation_failed`, the first segment of its first error's path) with a widget
 * text of their own (`error.field.<field>`); any other field shows `error.validation_failed`.
 */
export const FIELD_TEXT = new Set([
	'name',
	'email',
	'phone',
	'returnTo',
	'custom',
	'addresses',
	'consents',
	'tags',
	'role',
	'note',
	'notes',
	'setupPageUrl',
	'invitePageUrl',
	'key',
	'description',
	'permissions',
	'sessionHours',
	'rememberDays',
	'rank',
	'phoneDigits',
	'createdAfter',
	'action',
	'actor',
	'from',
	'to',
]);

/** The rules a refused new password breaks (422 `weak_password`), each with a widget text (`error.weak_password.<rule>`). */
export const PASSWORD_RULES = new Set(['too_short', 'too_long', 'letter_and_digit', 'personal', 'breached']);

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
 * Dates as text with the website's Format and business time zone, for this browser (PLAN 0.8.10 K7).
 * @param {Looks} config the widget config
 * @param {Viewer} win the browser window
 * @returns {Dates}
 */
export const datesOf = (config, win) => {
	const viewer = viewerOf(win);
	return (value, style = 'datetime') =>
		formatDate(typeof value === 'string' || typeof value === 'number' ? value : null, config.format, {
			timeZone: config.timeZone ?? 'UTC',
			style,
			viewer,
		});
};

/**
 * An amount of money as text with the website's Format, for this browser (PLAN 0.8.10 K7); null when the amount is
 * not integer minor units of a currency code.
 * @param {Looks} config the widget config
 * @param {Viewer} win the browser window
 * @param {unknown} amount minor units
 * @param {unknown} currency ISO 4217 code
 * @returns {string | null}
 */
export const moneyText = (config, win, amount, currency) =>
	Number.isSafeInteger(amount) && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
		? formatMoney(/** @type {number} */ (amount), currency, config.format, viewerOf(win))
		: null;

/**
 * The widget text for a failed answer (PLAN 0.4.10: every word is the website's, so a problem's English `detail` never
 * shows): the text of the field a refused form names, of the rule a refused password breaks, or of the problem code,
 * else a general one.
 * @param {Texts} t
 * @param {Answer} answer
 * @param {Dates} when dates as text (the lock's end)
 */
export const errorText = (t, answer, when) => {
	const data = answer.data ?? {};
	const code = problemCode(data);
	if (code === 'validation_failed') {
		const path = data.errors?.[0]?.path;
		const field = typeof path === 'string' ? path.split('/')[1] : undefined;
		return field !== undefined && FIELD_TEXT.has(field) ? t(`error.field.${field}`) : t('error.validation_failed');
	}
	if (code === 'weak_password')
		return PASSWORD_RULES.has(data.rule)
			? formatText(t(`error.weak_password.${data.rule}`), { min: data.minLength ?? '', max: data.maxLength ?? '' })
			: t('error.weak_password');
	if (code === 'sign_in_paused') return t('signIn.paused');
	if (code === 'locked')
		return typeof data.lockedUntil === 'string' && when(data.lockedUntil) !== ''
			? formatText(t('error.locked'), { time: when(data.lockedUntil) })
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
 * Builders of labeled fields with ids unique inside one widget.
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

/** Input attributes per custom field type (A6). @type {Record<string, Record<string, string>>} */
const INPUT_TYPES = {
	number: { type: 'number', step: 'any' },
	date: { type: 'date' },
	email: { type: 'email', autocomplete: 'off' },
	url: { type: 'url', inputmode: 'url' },
};

/**
 * The inputs of the merchant's custom fields (A6): one control per type, the help text under it, and for the user
 * (`by: 'user'`) the fields they only see shown read-only (left out at sign-up, `required`), never read back.
 * @param {Document} doc
 * @param {FieldMaker} make
 * @param {Texts} t
 * @param {ReadonlyArray<CustomField>} fields
 * @param {{ values?: Record<string, unknown>, required?: boolean, signUp?: boolean, by?: 'user' | 'staff' }} [options]
 *   `signUp`: a sign-up (fields the user only sees are left out); `required`: a sign-up that marks required fields
 */
export const customInputs = (doc, make, t, fields, { values = {}, required = false, signUp = required, by = 'user' } = {}) => {
	const shown = fields.filter(
		(field) => by === 'staff' || (field.visibility !== 'staff' && !(signUp && field.visibility === 'view')),
	);
	const inputs = shown.map((definition) => {
		const readOnly = by === 'user' && definition.visibility === 'view';
		const value = values[definition.key];
		/** @type {{ wrap: HTMLElement, input: HTMLInputElement, boxes?: HTMLInputElement[] }} */
		let made;
		if (definition.type === 'boolean') {
			const box = make.check(definition.label);
			box.input.checked = value === true;
			const wrap = element(doc, 'div', { class: 'field' });
			wrap.append(box.wrap);
			made = { wrap, input: box.input };
		} else if (definition.type === 'multi_choice') {
			const wrap = element(doc, 'fieldset', { class: 'choices' });
			wrap.append(element(doc, 'legend', {}, definition.label));
			const chosen = Array.isArray(value) ? value : [];
			const boxes = definition.options.map((option) => {
				const box = make.check(option);
				box.input.value = option;
				box.input.checked = chosen.includes(option);
				wrap.append(box.wrap);
				return box.input;
			});
			made = { wrap, input: /** @type {HTMLInputElement} */ (boxes[0]), boxes };
		} else {
			const attributes = { ...(INPUT_TYPES[definition.type] ?? {}) };
			if (definition.type === 'textarea') attributes.rows = '3';
			if (required && definition.required) attributes.required = '';
			const tag = definition.type === 'choice' ? 'select' : definition.type === 'textarea' ? 'textarea' : 'input';
			made = make.field(tag, definition.label, attributes);
			if (definition.type === 'choice')
				made.input.append(
					element(doc, 'option', { value: '' }, t('fields.choose')),
					...definition.options.map((option) => element(doc, 'option', { value: option }, option)),
				);
			made.input.value = value === undefined || value === null ? '' : String(value);
		}
		if (readOnly) for (const input of made.boxes ?? [made.input]) input.setAttribute('disabled', '');
		if (definition.help) {
			const hint = element(doc, 'p', { class: 'meta', id: `${made.input?.id || definition.key}-help` }, definition.help);
			made.wrap.append(hint);
			if (made.input?.id) made.input.setAttribute('aria-describedby', hint.id);
		}
		return { definition, readOnly, ...made };
	});
	return {
		nodes: inputs.map((made) => made.wrap),
		/**
		 * The values the user may change: numbers as numbers, yes/no as true or false, several choices as a list;
		 * `keepEmpty` sends '' (or []) for an emptied field (an update clears it).
		 * @param {boolean} [keepEmpty]
		 * @returns {Record<string, string | number | boolean | string[]>}
		 */
		read: (keepEmpty = false) => {
			/** @type {Record<string, string | number | boolean | string[]>} */
			const out = {};
			for (const { definition, input, boxes, readOnly } of inputs) {
				if (readOnly) continue;
				if (definition.type === 'boolean') out[definition.key] = input.checked;
				else if (boxes) {
					const chosen = boxes.filter((box) => box.checked).map((box) => box.value);
					if (chosen.length > 0 || keepEmpty) out[definition.key] = chosen;
				} else {
					const raw = input.value.trim();
					if (raw === '') {
						if (keepEmpty) out[definition.key] = '';
					} else out[definition.key] = definition.type === 'number' ? Number(raw) : raw;
				}
			}
			return out;
		},
	};
};

/**
 * @typedef {object} ConsentView
 * @property {string} key
 * @property {string} label the merchant's words next to the box
 * @property {string} url the page to read ('' for none)
 * @property {string} version
 * @property {boolean} [required]
 * @property {'agreement' | 'marketing'} [purpose]
 */

/**
 * The consent boxes (A2): one checkbox per consent with the merchant's words and a link to its page; a required one
 * must be checked. `show` limits them to the consents a refusal lists (consent_required), `read` gives the checked ones.
 * @param {Document} doc
 * @param {Texts} t
 * @param {ReadonlyArray<ConsentView> | null | undefined} consents
 */
export const consentBoxes = (doc, t, consents) => {
	const wrap = element(doc, 'div', { class: 'consents' });
	/** @type {Map<string, { row: HTMLElement, input: HTMLInputElement, required: boolean }>} */
	const boxes = new Map();
	/** @param {ConsentView} consent */
	const add = (consent) => {
		const input = /** @type {HTMLInputElement} */ (element(doc, 'input', { type: 'checkbox', value: consent.key }));
		const row = element(doc, 'label', { class: 'check' });
		row.append(input, doc.createTextNode(consent.label));
		const address = webAddress(consent.url);
		if (address) {
			row.append(doc.createTextNode(' '));
			row.append(element(doc, 'a', { target: '_blank', rel: 'noopener noreferrer', href: address }, t('consent.read')));
		}
		boxes.set(consent.key, { row, input, required: consent.required === true });
		wrap.append(row);
	};
	for (const consent of consents ?? []) add(consent);
	return {
		wrap,
		/** Whether there is any box. */
		any: () => boxes.size > 0,
		/** Mark the required boxes required (a sign-up form). */
		require: () => {
			for (const { input, required } of boxes.values()) if (required) input.setAttribute('required', '');
		},
		/**
		 * Show only the consents a refusal lists, as required (added when the widget did not know them yet).
		 * @param {unknown} asked `consents` of a consent_required problem
		 */
		show: (asked) => {
			const list = Array.isArray(asked) ? /** @type {ConsentView[]} */ (asked) : [];
			for (const consent of list) if (!boxes.has(consent.key)) add(consent);
			const keys = new Set(list.map((consent) => consent.key));
			for (const [key, box] of boxes) {
				setHidden(box.row, keys.size > 0 && !keys.has(key));
				if (keys.has(key)) {
					box.required = true;
					box.input.setAttribute('required', '');
				}
			}
		},
		/** Whether a required box shown is unchecked. */
		missing: () => [...boxes.values()].some(({ row, input, required }) => required && !row.hidden && !input.checked),
		/** The consents checked, as the API takes them. @returns {Record<string, boolean>} */
		read: () => Object.fromEntries([...boxes].filter(([, { input }]) => input.checked).map(([key]) => [key, true])),
	};
};
