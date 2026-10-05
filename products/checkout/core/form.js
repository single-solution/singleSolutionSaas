/**
 * The checkout form as data (pure). Which fields exist, in what order, which are required, their autocomplete tokens
 * and limits all come from the `checkout_form` settings: contact fields, a pool of address fields with per-country
 * formats (order, required fields, postal-code template), custom fields and delivery methods. Labels come from the
 * string catalog (`checkout_form.field.<key>`) unless the merchant gave a label. Nothing is tied to a country.
 * @module
 */
import { checkPhone } from './phone.js';
import { COUNTRY, cleanText, isEmail, isKey, isObject, issue } from './text.js';

/**
 * @typedef {object} FieldDef
 * @property {string} key
 * @property {'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox' | 'postal'} kind
 * @property {boolean} required
 * @property {string} autocomplete HTML autocomplete token(s), '' for none
 * @property {number} max_length
 * @property {string[]} [options] for `select`
 * @property {string} [label] merchant label (else the string catalog)
 */
/**
 * @typedef {object} DeliveryMethod
 * @property {string} key
 * @property {'ship' | 'pickup' | 'digital'} kind
 * @property {number} fee integer minor units
 * @property {number} free_over subtotal from which the fee is waived (0 = never)
 * @property {boolean} requires_address
 * @property {string[]} countries empty = all
 * @property {string} [label]
 */
/**
 * @typedef {object} FormSettings the `checkout_form` feature values used here
 * @property {string[]} countries
 * @property {string} default_country
 * @property {FieldDef[]} contact_fields
 * @property {FieldDef[]} address_fields
 * @property {Array<{ country: string, fields: string[], required?: string[], postal_pattern?: string }>} address_formats
 * @property {FieldDef[]} custom_fields
 * @property {DeliveryMethod[]} delivery_methods
 * @property {Array<{ key: string, name: string, address?: string }>} pickup_locations
 * @property {{ mode: 'any' | 'e164' | 'patterns', patterns: string[], rewrites: Array<{ prefix: string, replace: string }>, min_digits: number, max_digits: number }} phone
 */
/**
 * @typedef {FieldDef & { label: string, pattern?: string }} ResolvedField
 */

/**
 * Postal code against a template: `#` digit, `A` letter, `?` digit or letter, other characters literal; letters match
 * case-insensitively. An empty template accepts anything.
 * @param {string} value
 * @param {string | undefined} template
 */
export const matchesPostal = (value, template) => {
	if (!template) return true;
	const upper = value.toUpperCase();
	return template.split('|').some((option) => {
		if (option.length !== upper.length) return false;
		for (let index = 0; index < option.length; index += 1) {
			const want = option[index];
			const got = /** @type {string} */ (upper[index]);
			const digit = got >= '0' && got <= '9';
			const letter = got >= 'A' && got <= 'Z';
			if (want === '#' ? !digit : want === 'A' ? !letter : want === '?' ? !(digit || letter) : want !== got) return false;
		}
		return true;
	});
};

/**
 * The country the form is for: the asked one when allowed, else the default, else the first allowed (or null).
 * @param {FormSettings} settings
 * @param {unknown} asked
 */
export const countryFor = (settings, asked) => {
	const allowed = settings.countries.filter((code) => COUNTRY.test(code));
	const ok = (/** @type {unknown} */ code) =>
		typeof code === 'string' && COUNTRY.test(code) && (allowed.length === 0 || allowed.includes(code));
	if (ok(asked)) return /** @type {string} */ (asked);
	if (ok(settings.default_country)) return settings.default_country;
	return allowed[0] ?? null;
};

/**
 * Resolve the form for a country: field order, required flags, labels and the postal template.
 * @param {FormSettings} settings
 * @param {{ country?: unknown, t: (key: string) => string }} input
 */
export const resolveForm = (settings, { country: asked, t }) => {
	const country = countryFor(settings, asked);
	/** @param {FieldDef} field @returns {ResolvedField} */
	const label = (field) => ({ ...field, label: field.label || t(`checkout_form.field.${field.key}`) });
	const format = settings.address_formats.find((entry) => entry.country === country);
	const pool = new Map(settings.address_fields.map((field) => [field.key, field]));
	/** @type {ResolvedField[]} */
	const address = (
		format ? format.fields.map((key) => pool.get(key)).filter((f) => f !== undefined) : settings.address_fields
	).map((field) => {
		const resolved = label(field);
		const required = format?.required ? format.required.includes(field.key) : field.required;
		return {
			...resolved,
			required,
			...(field.kind === 'postal' && format?.postal_pattern ? { pattern: format.postal_pattern } : {}),
		};
	});
	const deliveryMethods = settings.delivery_methods
		.filter((method) => method.countries.length === 0 || (country !== null && method.countries.includes(country)))
		.map((method) => ({ ...method, label: method.label || t(`checkout_form.delivery.${method.kind}`) }));
	return {
		country,
		countries: settings.countries,
		contact: settings.contact_fields.map(label),
		address,
		custom: settings.custom_fields.map(label),
		deliveryMethods,
		pickupLocations: settings.pickup_locations,
		phone: { mode: settings.phone.mode, patterns: settings.phone.patterns },
	};
};

/** @typedef {ReturnType<typeof resolveForm>} ResolvedForm */

/**
 * Check one value against its field.
 * @param {ResolvedField} field
 * @param {unknown} raw
 * @param {FormSettings['phone']} phone
 * @returns {{ ok: true, value: string | boolean | null } | { ok: false, code: string }}
 */
export const checkField = (field, raw, phone) => {
	if (field.kind === 'checkbox') {
		if (raw !== undefined && raw !== null && typeof raw !== 'boolean') return { ok: false, code: 'type_invalid' };
		if (field.required && raw !== true) return { ok: false, code: 'required' };
		return { ok: true, value: raw === true };
	}
	if (raw !== undefined && raw !== null && typeof raw !== 'string') return { ok: false, code: 'type_invalid' };
	if (typeof raw === 'string' && raw.length > field.max_length * 2) return { ok: false, code: 'too_long' };
	const text = cleanText(raw, field.max_length + 1);
	if (text === null) return field.required ? { ok: false, code: 'required' } : { ok: true, value: null };
	if (text.length > field.max_length) return { ok: false, code: 'too_long' };
	switch (field.kind) {
		case 'email':
			return isEmail(text) ? { ok: true, value: text.toLowerCase() } : { ok: false, code: 'email_invalid' };
		case 'tel': {
			const checked = checkPhone(text, {
				mode: phone.mode,
				patterns: phone.patterns,
				rewrites: phone.rewrites,
				minDigits: phone.min_digits,
				maxDigits: phone.max_digits,
			});
			return checked.ok ? { ok: true, value: checked.value } : { ok: false, code: checked.code };
		}
		case 'select':
			return (field.options ?? []).includes(text) ? { ok: true, value: text } : { ok: false, code: 'option_invalid' };
		case 'postal':
			return matchesPostal(text, field.pattern)
				? { ok: true, value: text.toUpperCase() }
				: { ok: false, code: 'postal_invalid' };
		default:
			return { ok: true, value: text };
	}
};

/**
 * @param {ResolvedField[]} fields
 * @param {unknown} input
 * @param {string} base JSON pointer of the group
 * @param {FormSettings['phone']} phone
 */
const checkGroup = (fields, input, base, phone) => {
	/** @type {Record<string, string | boolean>} */
	const values = {};
	/** @type {import('./text.js').FieldProblem[]} */
	const problems = [];
	const source = isObject(input) ? input : {};
	for (const field of fields) {
		const result = checkField(field, source[field.key], phone);
		if (!result.ok) problems.push(issue(`${base}/${field.key}`, result.code));
		else if (result.value !== null) values[field.key] = result.value;
	}
	return { values, problems };
};

/**
 * Validate a submitted form (`{ country?, contact, address?, custom?, deliveryMethod, pickupLocation? }`). The address is
 * only read when the chosen delivery method needs one; unknown keys are ignored (never stored).
 * @param {FormSettings} settings
 * @param {unknown} input
 * @param {{ t: (key: string) => string, needsShipping: boolean }} options
 */
export const validateForm = (settings, input, { t, needsShipping }) => {
	const body = isObject(input) ? input : {};
	const form = resolveForm(settings, { country: body.country, t });
	/** @type {import('./text.js').FieldProblem[]} */
	const problems = [];
	if (body.country !== undefined && body.country !== form.country) problems.push(issue('/country', 'country_unavailable'));
	const contact = checkGroup(form.contact, body.contact, '/contact', settings.phone);
	const custom = checkGroup(form.custom, body.custom, '/custom', settings.phone);
	problems.push(...contact.problems, ...custom.problems);
	const method = form.deliveryMethods.find((entry) => entry.key === body.deliveryMethod);
	if (!isKey(body.deliveryMethod) || !method) problems.push(issue('/deliveryMethod', 'delivery_unavailable'));
	// a cart without physical items needs no address, whatever the method says
	const wantsAddress = Boolean(method?.requires_address) && needsShipping;
	const address = wantsAddress
		? checkGroup(form.address, body.address, '/address', settings.phone)
		: { values: {}, problems: [] };
	problems.push(...address.problems);
	let pickupLocation = null;
	if (method?.kind === 'pickup' && form.pickupLocations.length > 0) {
		pickupLocation = form.pickupLocations.find((entry) => entry.key === body.pickupLocation) ?? null;
		if (!pickupLocation) problems.push(issue('/pickupLocation', 'pickup_unavailable'));
	}
	return {
		problems,
		form,
		values: {
			country: form.country,
			contact: contact.values,
			address: wantsAddress ? { ...address.values, ...(form.country ? { country: form.country } : {}) } : null,
			custom: custom.values,
			delivery: method ? { key: method.key, kind: method.kind, label: method.label } : null,
			pickupLocation: pickupLocation ? { key: pickupLocation.key, name: pickupLocation.name } : null,
		},
		method: method ?? null,
	};
};

/**
 * The delivery fee of a method for a subtotal (after discounts).
 * @param {DeliveryMethod | null} method
 * @param {number} subtotal
 */
export const deliveryFee = (method, subtotal) => {
	if (!method || method.fee <= 0) return 0;
	return method.free_over > 0 && subtotal >= method.free_over ? 0 : method.fee;
};
