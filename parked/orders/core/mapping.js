/**
 * Inbound schema mapping (pure): turns another checkout's order JSON into our canonical order with the merchant's
 * mapping from settings — our field paths ← dot paths in the payload (`items.0.price`, `items[0].price`). Money can
 * arrive as minor units or as decimals in the order's currency. Paths never reach prototype properties.
 * @module
 */
import { ADDRESS_FIELDS } from './orders.js';
import { isObject, issue } from './text.js';
import { exponentOf, parseMajor } from './money.js';

/** Order fields a mapping may target. */
export const ORDER_TARGETS = Object.freeze([
	'externalId',
	'number',
	'placedAt',
	'currency',
	'customer.customerId',
	'customer.subject',
	'customer.email',
	'customer.phone',
	'customer.name',
	...ADDRESS_FIELDS.map((field) => `shipping.${field}`),
	...ADDRESS_FIELDS.map((field) => `billing.${field}`),
	'delivery.method',
	'delivery.label',
	'payment.method',
	'payment.status',
	'payment.paidAmount',
	'payment.reference',
	'payment.cod',
	'amounts.subtotal',
	'amounts.discount',
	'amounts.shipping',
	'amounts.tax',
	'amounts.total',
	'notes.customer',
]);
/** Line fields a mapping may target (plus `attributes.<name>`). */
export const LINE_TARGETS = Object.freeze([
	'itemId',
	'variantId',
	'sku',
	'title',
	'variantTitle',
	'quantity',
	'unitAmount',
	'totalAmount',
	'taxAmount',
	'warranty.label',
	'warranty.days',
	'serialRequired',
	'imageUrl',
]);
const MONEY = new Set([
	'payment.paidAmount',
	'amounts.subtotal',
	'amounts.discount',
	'amounts.shipping',
	'amounts.tax',
	'amounts.total',
	'unitAmount',
	'totalAmount',
	'taxAmount',
]);
const INTEGER = new Set(['quantity', 'warranty.days']);
const BOOLEAN = new Set(['payment.cod', 'serialRequired']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const ATTRIBUTE = /^attributes\.[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * @typedef {object} Mapping
 * @property {string} key
 * @property {Array<{ target: string, source: string }>} fields
 * @property {string} linesPath
 * @property {Array<{ target: string, source: string }>} lineFields
 * @property {'minor' | 'decimal'} amounts
 * @property {string | null} sourceLabel
 */

/**
 * Split a payload path (`a.b[0].c` or `a.b.0.c`) into segments; null when it reaches a forbidden key.
 * @param {string} path
 * @returns {string[] | null}
 */
export const segments = (path) => {
	const parts = path
		.replace(/\[(\d+)\]/g, '.$1')
		.split('.')
		.filter((part) => part !== '');
	return parts.length === 0 || parts.length > 20 || parts.some((part) => FORBIDDEN.has(part)) ? null : parts;
};

/**
 * Read a path from a JSON value (own properties only).
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 */
export const getPath = (value, path) => {
	const parts = segments(path);
	if (!parts) return undefined;
	let current = value;
	for (const part of parts) {
		if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
		else if (isObject(current) && Object.hasOwn(current, part)) current = current[part];
		else return undefined;
	}
	return current;
};

/**
 * Write a two-level target path (`customer.email`) into a plain object (new objects, inputs untouched).
 * @param {Record<string, any>} target
 * @param {string} path
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
const setPath = (target, path, value) => {
	const [head = '', ...rest] = path.split('.');
	if (rest.length === 0) return { ...target, [head]: value };
	return { ...target, [head]: setPath(isObject(target[head]) ? target[head] : {}, rest.join('.'), value) };
};

/**
 * Mappings from the `inbound_api` settings (entries with unknown targets are dropped).
 * @param {unknown} raw
 * @returns {Mapping[]}
 */
export const mappingsOf = (raw) =>
	(Array.isArray(raw) ? raw : [])
		.filter((m) => isObject(m) && typeof m.key === 'string' && typeof m.lines_path === 'string')
		.map((m) => ({
			key: m.key,
			fields: (Array.isArray(m.fields) ? m.fields : []).filter(
				(/** @type {any} */ f) => ORDER_TARGETS.includes(f?.target) && typeof f?.source === 'string',
			),
			linesPath: m.lines_path,
			lineFields: (Array.isArray(m.line_fields) ? m.line_fields : []).filter(
				(/** @type {any} */ f) =>
					(LINE_TARGETS.includes(f?.target) || ATTRIBUTE.test(String(f?.target))) && typeof f?.source === 'string',
			),
			amounts: m.amounts === 'decimal' ? 'decimal' : 'minor',
			sourceLabel: typeof m.source_label === 'string' && m.source_label.trim() ? m.source_label.trim() : null,
		}));

/**
 * Convert one mapped value to the type its target needs.
 * @param {string} target
 * @param {unknown} value
 * @param {{ decimal: boolean, exponent: number }} money
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
const convert = (target, value, money) => {
	if (MONEY.has(target)) {
		if (!money.decimal) {
			const number = typeof value === 'string' && /^\d{1,16}$/.test(value.trim()) ? Number(value) : value;
			return Number.isSafeInteger(number) && /** @type {number} */ (number) >= 0 ? { ok: true, value: number } : { ok: false };
		}
		const parsed = parseMajor(value, money.exponent);
		return parsed === null ? { ok: false } : { ok: true, value: parsed };
	}
	if (INTEGER.has(target)) {
		const number = typeof value === 'string' && /^\d{1,9}$/.test(value.trim()) ? Number(value) : value;
		return Number.isSafeInteger(number) ? { ok: true, value: number } : { ok: false };
	}
	if (BOOLEAN.has(target)) return { ok: true, value: value === true || value === 'true' || value === 1 || value === '1' };
	if (target === 'payment.status') {
		const paid = value === true || value === 'paid' || value === 'PAID' || value === 'completed' || value === 'captured';
		return { ok: true, value: paid ? 'paid' : 'unpaid' };
	}
	if (typeof value === 'string' || typeof value === 'number') return { ok: true, value };
	return { ok: false };
};

/**
 * Apply a mapping to a payload. Missing payload values are left out (the order validation then reports what is
 * required); values of the wrong shape are reported here with the payload path.
 * @param {unknown} payload
 * @param {Mapping} mapping
 * @returns {{ ok: true, input: Record<string, any> } | { ok: false, errors: Array<{ path: string, code: string }> }}
 */
export const applyMapping = (payload, mapping) => {
	if (!isObject(payload)) return { ok: false, errors: [issue('', 'object_required')] };
	/** @type {Array<{ path: string, code: string }>} */
	const errors = [];
	const currencyField = mapping.fields.find((f) => f.target === 'currency');
	const currency = currencyField ? getPath(payload, currencyField.source) : undefined;
	const money = {
		decimal: mapping.amounts === 'decimal',
		exponent: exponentOf(typeof currency === 'string' ? currency.toUpperCase() : null),
	};
	/** @type {Record<string, any>} */
	let input = {};
	for (const { target, source } of mapping.fields) {
		const raw = getPath(payload, source);
		if (raw === undefined || raw === null || raw === '') continue;
		const converted = convert(target, target === 'currency' && typeof raw === 'string' ? raw.toUpperCase() : raw, money);
		if (!converted.ok) errors.push(issue(`/${source}`, 'mapping_invalid'));
		else input = setPath(input, target, converted.value);
	}
	const rawLines = getPath(payload, mapping.linesPath);
	if (!Array.isArray(rawLines)) errors.push(issue(`/${mapping.linesPath}`, 'lines_missing'));
	else
		input.lines = rawLines.slice(0, 1000).map((rawLine, index) => {
			/** @type {Record<string, any>} */
			let line = {};
			for (const { target, source } of mapping.lineFields) {
				const raw = getPath(rawLine, source);
				if (raw === undefined || raw === null || raw === '') continue;
				const converted = convert(target, raw, money);
				if (!converted.ok) errors.push(issue(`/${mapping.linesPath}/${index}/${source}`, 'mapping_invalid'));
				else line = setPath(line, target, converted.value);
			}
			return line;
		});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, input };
};
