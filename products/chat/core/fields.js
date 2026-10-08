/**
 * Fields (pure): the merchant's custom fields for conversations and leads (label, key, type text, number, yes/no or a
 * choice list), the standard contact fields (name, e-mail, phone) shared by lead capture, guest contact capture and
 * flows, leads with their optional consent, and proactive page rules.
 * @module
 */
/** Most custom fields a website has. */
const MAX_CUSTOM_FIELDS = 30;
/** Most proactive page rules a website has. */
const MAX_PAGE_RULES = 20;
const FIELD_TYPES = Object.freeze(/** @type {const} */ (['text', 'number', 'yes_no', 'choice']));
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/u;
const PHONE = /^\+?[0-9 ()./-]{6,24}$/;
const RESERVED = Object.freeze(['name', 'email', 'phone', 'message', 'text']);

/** @typedef {{ key: string, label: string, type: 'text' | 'number' | 'yes_no' | 'choice' | 'name' | 'email' | 'phone', options: string[] }} CustomField */
/** @typedef {{ path: string, delay: number, message: string }} PageRule */

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the custom field definitions a merchant saves.
 * @param {unknown} items
 * @returns {{ ok: true, value: CustomField[] } | { ok: false, errors: string[] }}
 */
export const checkCustomFields = (items) => {
	if (!Array.isArray(items) || items.length > MAX_CUSTOM_FIELDS)
		return { ok: false, errors: [`Up to ${MAX_CUSTOM_FIELDS} custom fields.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {CustomField[]} */
	const value = [];
	const keys = new Set();
	items.forEach((item, index) => {
		const at = `Field ${index + 1}`;
		const ok =
			isObject(item) &&
			typeof item.key === 'string' &&
			KEY.test(item.key) &&
			!RESERVED.includes(item.key) &&
			!keys.has(item.key) &&
			typeof item.label === 'string' &&
			item.label.trim().length > 0 &&
			item.label.length <= 80 &&
			FIELD_TYPES.includes(/** @type {any} */ (item.type));
		if (!ok)
			return void errors.push(
				`${at}: a unique key (lower-case letters, digits, _), a label and a type (text, number, yes_no, choice).`,
			);
		keys.add(item.key);
		const options = Array.isArray(item.options)
			? item.options
					.filter((/** @type {unknown} */ o) => typeof o === 'string' && o.trim())
					.map((/** @type {unknown} */ o) => String(o).trim().slice(0, 60))
			: [];
		if (item.type === 'choice' && (options.length < 1 || options.length > 30))
			return void errors.push(`${at}: a choice list has 1–30 options.`);
		value.push({
			key: String(item.key),
			label: String(item.label).trim(),
			type: /** @type {CustomField['type']} */ (item.type),
			options: item.type === 'choice' ? options : [],
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Check one value of a field (custom or standard).
 * @param {CustomField} field
 * @param {unknown} raw
 * @returns {{ ok: true, value: string | number | boolean } | { ok: false }}
 */
export const checkFieldValue = (field, raw) => {
	const value = typeof raw === 'string' ? raw.trim() : raw;
	switch (field.type) {
		case 'number': {
			const n = typeof value === 'number' ? value : Number(value);
			return value !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
		}
		case 'yes_no':
			if (typeof value === 'boolean') return { ok: true, value };
			return value === 'yes' || value === 'no' ? { ok: true, value: value === 'yes' } : { ok: false };
		case 'choice':
			return typeof value === 'string' && field.options.includes(value) ? { ok: true, value } : { ok: false };
		case 'email':
			return typeof value === 'string' && EMAIL.test(value) ? { ok: true, value: value.toLowerCase() } : { ok: false };
		case 'phone':
			return typeof value === 'string' && PHONE.test(value) ? { ok: true, value } : { ok: false };
		default:
			return typeof value === 'string' && value.length > 0 && value.length <= 2000 ? { ok: true, value } : { ok: false };
	}
};

/**
 * Check a lead: the merchant's chosen fields (at least one contact: e-mail or phone, when asked), custom fields and
 * consent.
 * @param {unknown} body `{ fields: { … }, consent? }`
 * @param {{ fields: string[], customKeys: string[], customFields: readonly CustomField[], consentRequired: boolean }} rules
 * @returns {{ ok: true, value: { name: string | null, email: string | null, phone: string | null, message: string | null, custom: Record<string, string | number | boolean> } }
 *   | { ok: false, errors: string[] }}
 */
export const checkLead = (body, rules) => {
	const input = isObject(body) && isObject(/** @type {any} */ (body).fields) ? /** @type {any} */ (body).fields : {};
	/** @type {string[]} */
	const errors = [];
	/** @type {{ name: string | null, email: string | null, phone: string | null, message: string | null }} */
	const standard = { name: null, email: null, phone: null, message: null };
	for (const name of /** @type {const} */ (['name', 'email', 'phone', 'message'])) {
		const raw = input[name];
		if (raw === undefined || raw === null || raw === '') continue;
		const type = name === 'message' ? 'text' : name === 'name' ? 'text' : name;
		const checked = checkFieldValue({ key: name, label: name, type: /** @type {any} */ (type), options: [] }, raw);
		if (checked.ok) standard[name] = String(checked.value).slice(0, name === 'message' ? 2000 : 200);
		else errors.push(`${name} is not valid.`);
	}
	for (const name of rules.fields)
		if (name !== 'message' && standard[/** @type {'name' | 'email' | 'phone'} */ (name)] === null)
			errors.push(`${name} is required.`);
	if (rules.fields.some((f) => f === 'email' || f === 'phone') && !standard.email && !standard.phone)
		errors.push('Leave an e-mail address or a phone number.');
	/** @type {Record<string, string | number | boolean>} */
	const custom = {};
	for (const key of rules.customKeys) {
		const field = rules.customFields.find((f) => f.key === key);
		if (!field || input[key] === undefined || input[key] === '') continue;
		const checked = checkFieldValue(field, input[key]);
		if (checked.ok) custom[key] = checked.value;
		else errors.push(`${field.label} is not valid.`);
	}
	if (rules.consentRequired && /** @type {any} */ (body)?.consent !== true) errors.push('Tick the consent box.');
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { name: standard.name, email: standard.email, phone: standard.phone, message: standard.message, custom },
	};
};

/**
 * Check the proactive page rules a merchant saves.
 * @param {unknown} items
 * @returns {{ ok: true, value: PageRule[] } | { ok: false, errors: string[] }}
 */
export const checkPageRules = (items) => {
	if (!Array.isArray(items) || items.length > MAX_PAGE_RULES) return { ok: false, errors: [`Up to ${MAX_PAGE_RULES} rules.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {PageRule[]} */
	const value = [];
	items.forEach((item, index) => {
		const ok =
			isObject(item) &&
			typeof item.path === 'string' &&
			item.path.startsWith('/') &&
			item.path.length <= 200 &&
			Number.isInteger(item.delay) &&
			Number(item.delay) >= 0 &&
			Number(item.delay) <= 3600 &&
			typeof item.message === 'string' &&
			item.message.trim().length > 0 &&
			item.message.length <= 500;
		if (!ok) errors.push(`Rule ${index + 1}: a path from /, a delay of 0–3600 seconds and a message (up to 500 characters).`);
		else value.push({ path: String(item.path), delay: Number(item.delay), message: String(item.message).trim() });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};
