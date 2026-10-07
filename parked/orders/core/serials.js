/**
 * Serials (pure): one serial per unit, validated by rules kept as data. Ported from the store's IMEI rules — a value
 * shaped like a check-digit id must pass the Luhn check, anything else is a free-form serial — but nothing is
 * device-specific: the merchant's rules say which characters, which lengths and which check digit. No regular
 * expression comes from settings (no ReDoS): character classes are fixed and lengths are numbers.
 * @module
 */
import { isObject, issue } from './text.js';

const CLASSES = Object.freeze({
	digits: /^[0-9]+$/,
	alphanumeric: /^[\p{L}\p{N}]+$/u,
	text: /^[\p{L}\p{N}][\p{L}\p{N} ./:_-]*$/u,
});

/**
 * @typedef {object} SerialRule
 * @property {string} key
 * @property {'digits' | 'alphanumeric' | 'text'} chars
 * @property {number} minLength
 * @property {number} maxLength
 * @property {'none' | 'luhn'} checksum
 * @property {string} strip
 * @property {boolean} uppercase
 */

/**
 * Luhn (mod 10) check over a digit string.
 * @param {string} digits
 */
export const isLuhnValid = (digits) => {
	if (!/^\d+$/.test(digits)) return false;
	let sum = 0;
	let double = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let digit = Number(digits[index]);
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return sum % 10 === 0;
};

/**
 * Rules from the `serials` settings.
 * @param {unknown} raw
 * @returns {SerialRule[]}
 */
export const rulesOf = (raw) =>
	(Array.isArray(raw) ? raw : [])
		.filter((r) => isObject(r) && typeof r.key === 'string' && Object.hasOwn(CLASSES, r.chars))
		.map((r) => ({
			key: r.key,
			chars: r.chars,
			minLength: Math.max(1, Number(r.min_length) || 1),
			maxLength: Math.max(1, Number(r.max_length) || 64),
			checksum: r.checksum === 'luhn' ? 'luhn' : 'none',
			strip: typeof r.strip === 'string' ? r.strip : '',
			uppercase: r.uppercase === true,
		}));

/**
 * @param {string} value
 * @param {string} strip characters to remove
 */
const stripped = (value, strip) => [...value].filter((char) => !strip.includes(char)).join('');

/**
 * Normalise and validate one serial with the first rule whose shape it has.
 * @param {unknown} raw
 * @param {SerialRule[]} rules
 * @returns {{ ok: true, value: string, rule: string } | { ok: false, code: string }}
 */
export const validateSerial = (raw, rules) => {
	if (typeof raw !== 'string') return { ok: false, code: 'serial_invalid' };
	const trimmed = raw.trim().replace(/\s{2,}/g, ' ');
	if (trimmed === '') return { ok: false, code: 'serial_empty' };
	if (trimmed.length > 256) return { ok: false, code: 'serial_invalid' };
	for (const rule of rules) {
		const base = stripped(trimmed, rule.strip);
		const value = rule.uppercase ? base.toUpperCase() : base;
		if (value.length < rule.minLength || value.length > rule.maxLength || !CLASSES[rule.chars].test(value)) continue;
		if (rule.checksum === 'luhn' && !isLuhnValid(value)) return { ok: false, code: 'serial_checksum' };
		return { ok: true, value, rule: rule.key };
	}
	return { ok: false, code: 'serial_invalid' };
};

/**
 * Validate the serials entered for one line: blanks dropped, each valid, at most one per unit, no duplicates.
 * @param {unknown} raw
 * @param {number} quantity
 * @param {SerialRule[]} rules
 * @returns {{ ok: true, serials: string[] } | { ok: false, code: string, index?: number }}
 */
export const validateLineSerials = (raw, quantity, rules) => {
	if (!Array.isArray(raw)) return { ok: false, code: 'serials_invalid' };
	/** @type {string[]} */
	const serials = [];
	for (const [index, entry] of raw.entries()) {
		if (typeof entry === 'string' && entry.trim() === '') continue;
		const result = validateSerial(entry, rules);
		if (!result.ok) return { ok: false, code: result.code, index };
		if (serials.includes(result.value)) return { ok: false, code: 'serial_duplicate', index };
		serials.push(result.value);
	}
	if (serials.length > quantity) return { ok: false, code: 'too_many_serials' };
	return { ok: true, serials };
};

/**
 * Whether a line needs a serial per unit before dispatch.
 * @param {{ serialRequired?: boolean, attributes?: Record<string, unknown> }} line
 * @param {Record<string, any>} settings `serials` settings (`required_for`, `required_attributes`)
 */
export const lineNeedsSerials = (line, settings) => {
	if (settings.required_for === 'all') return true;
	if (settings.required_for !== 'flagged') return false;
	if (line.serialRequired === true) return true;
	return settings.required_attributes.some((/** @type {{ key: string, values: string[] }} */ rule) => {
		const value = line.attributes?.[rule.key];
		return value !== undefined && rule.values.includes(String(value));
	});
};

/**
 * Titles of the lines still missing serials (empty when nothing is missing).
 * @param {ReadonlyArray<{ title: string, quantity: number, serials?: string[], serialRequired?: boolean, attributes?: Record<string, unknown> }>} lines
 * @param {Record<string, any>} settings `serials` settings (`required_for`, `required_attributes`)
 */
export const missingSerials = (lines, settings) =>
	lines.filter((line) => lineNeedsSerials(line, settings) && (line.serials ?? []).length < line.quantity).map((l) => l.title);

/**
 * Validate a serials patch `{ lines: [{ lineId, serials }] }` against an order: each line known, values valid, no
 * serial twice in the order.
 * @param {unknown} patch
 * @param {ReadonlyArray<{ id: string, quantity: number, serials?: string[] }>} lines
 * @param {SerialRule[]} rules
 * @returns {{ ok: true, serials: Record<string, string[]> } | { ok: false, errors: Array<{ path: string, code: string }> }}
 */
export const applySerials = (patch, lines, rules) => {
	if (!isObject(patch) || !Array.isArray(patch.lines) || patch.lines.length === 0 || patch.lines.length > 500)
		return { ok: false, errors: [issue('/lines', 'required')] };
	/** @type {Record<string, string[]>} */
	const out = Object.fromEntries(lines.map((line) => [line.id, [...(line.serials ?? [])]]));
	/** @type {Array<{ path: string, code: string }>} */
	const errors = [];
	for (const [index, entry] of patch.lines.entries()) {
		const line = lines.find((l) => l.id === entry?.lineId);
		if (!line) {
			errors.push(issue(`/lines/${index}/lineId`, 'line_unknown'));
			continue;
		}
		const result = validateLineSerials(entry.serials, line.quantity, rules);
		if (!result.ok)
			errors.push(issue(`/lines/${index}/serials${result.index === undefined ? '' : `/${result.index}`}`, result.code));
		else out[line.id] = result.serials;
	}
	const all = Object.values(out).flat();
	const duplicate = all.find((serial, index) => all.indexOf(serial) !== index);
	if (duplicate) errors.push(issue('/lines', 'serial_duplicate'));
	return errors.length > 0 ? { ok: false, errors } : { ok: true, serials: out };
};
