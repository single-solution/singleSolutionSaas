/**
 * Merchant-defined custom fields (pure): definitions come from `items.custom_fields` in the website's settings (Portal),
 * values live in each item's `custom` object. Every write is validated against the definitions; readers with a `pk_`
 * key only see the fields marked public.
 * @module
 */
import { cleanText, isObject, issue } from './text.js';

/**
 * @typedef {object} FieldDefinition
 * @property {string} key
 * @property {string} label
 * @property {'text' | 'long_text' | 'number' | 'integer' | 'boolean' | 'date' | 'url' | 'select' | 'multi_select'} type
 * @property {string[]} [options]
 * @property {boolean} [required]
 * @property {boolean} [public]
 * @property {number} [max_length]
 */

const DEFAULT_MAX = Object.freeze({ text: 500, long_text: 20000, url: 2048 });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One value against its definition: the stored value, or an error code.
 * @param {FieldDefinition} field
 * @param {unknown} value
 * @returns {{ value: unknown } | { code: string }}
 */
export const fieldValue = (field, value) => {
	switch (field.type) {
		case 'text':
		case 'long_text': {
			const max = field.max_length ?? DEFAULT_MAX[field.type];
			const text = cleanText(value, max, { multiline: field.type === 'long_text' });
			return text === null
				? { code: typeof value === 'string' && value.length > max ? 'too_long' : 'text_invalid' }
				: { value: text };
		}
		case 'url': {
			const text = cleanText(value, field.max_length ?? DEFAULT_MAX.url);
			return text !== null && /^https?:\/\/[^\s]+$/.test(text) ? { value: text } : { code: 'url_invalid' };
		}
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? { value } : { code: 'number_invalid' };
		case 'integer':
			return Number.isSafeInteger(value) ? { value } : { code: 'integer_invalid' };
		case 'boolean':
			return typeof value === 'boolean' ? { value } : { code: 'boolean_invalid' };
		case 'date':
			return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
				? { value }
				: { code: 'date_invalid' };
		case 'select':
			return typeof value === 'string' && (field.options ?? []).includes(value) ? { value } : { code: 'option_invalid' };
		case 'multi_select': {
			const options = field.options ?? [];
			return Array.isArray(value) && value.length <= options.length && value.every((v) => options.includes(v))
				? { value: [...new Set(value)] }
				: { code: 'option_invalid' };
		}
		default:
			return { code: 'type_unknown' };
	}
};

/**
 * Validate a `custom` object (create: required fields must be present; patch: `null` removes a field).
 * @param {readonly FieldDefinition[]} definitions fields allowed for the item's type
 * @param {unknown} input
 * @param {{ current?: Record<string, unknown>, partial?: boolean, path?: string }} [options]
 * @returns {{ problems: Array<{ path: string, code: string }>, value: Record<string, unknown> }}
 */
export const validateCustom = (definitions, input, { current = {}, partial = false, path = '/custom' } = {}) => {
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	if (input !== undefined && !isObject(input)) return { problems: [issue(path, 'object_required')], value: current };
	const given = /** @type {Record<string, unknown>} */ (input ?? {});
	const byKey = new Map(definitions.map((field) => [field.key, field]));
	/** @type {Record<string, unknown>} */
	const value = partial ? { ...current } : {};
	for (const [key, raw] of Object.entries(given)) {
		const field = byKey.get(key);
		if (!field) {
			problems.push(issue(`${path}/${key}`, 'field_unknown'));
			continue;
		}
		if (raw === null) {
			delete value[key];
			continue;
		}
		const result = fieldValue(field, raw);
		if ('code' in result) problems.push(issue(`${path}/${key}`, result.code));
		else value[key] = result.value;
	}
	for (const field of definitions)
		if (field.required && value[field.key] === undefined) problems.push(issue(`${path}/${field.key}`, 'required'));
	return { problems, value };
};

/**
 * The definitions an item type uses (`custom_fields` of the type; empty = every field).
 * @param {readonly FieldDefinition[]} definitions
 * @param {{ custom_fields?: string[] } | undefined} type
 */
export const fieldsForType = (definitions, type) => {
	const keys = type?.custom_fields ?? [];
	return keys.length === 0 ? [...definitions] : definitions.filter((field) => keys.includes(field.key));
};

/**
 * Only the public fields of a `custom` object.
 * @param {readonly FieldDefinition[]} definitions
 * @param {Record<string, unknown> | undefined} custom
 */
export const publicCustom = (definitions, custom) => {
	const visible = new Set(definitions.filter((field) => field.public).map((field) => field.key));
	return Object.fromEntries(Object.entries(custom ?? {}).filter(([key]) => visible.has(key)));
};
