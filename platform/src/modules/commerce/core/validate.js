/**
 * Input validation for commerce (pure). Each validator returns `{ ok: true, value }` or `{ ok: false, errors }` with
 * JSON-pointer paths, so routes can answer `validation_failed` with field errors.
 * @module
 */
import { isId } from '@ss/contracts';

/** @typedef {{ path: string, message: string }} FieldError */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, errors: FieldError[] }} Checked
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {Record<string, unknown>} body
 * @param {readonly string[]} allowed
 * @param {FieldError[]} errors
 * @param {string} [base]
 */
const noExtra = (body, allowed, errors, base = '') => {
	for (const key of Object.keys(body))
		if (!allowed.includes(key)) errors.push({ path: `${base}/${key}`, message: 'unknown property' });
};

/**
 * @template T
 * @param {FieldError[]} errors
 * @param {() => T} value
 * @returns {Checked<T>}
 */
const result = (errors, value) => (errors.length > 0 ? { ok: false, errors } : { ok: true, value: value() });

const PRODUCT_ID = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Add product to a website: `{ productId }`.
 * @param {unknown} input
 * @returns {Checked<{ productId: string }>}
 */
export const checkAddProduct = (input) => {
	if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['productId'], errors);
	if (typeof input.productId !== 'string' || !PRODUCT_ID.test(input.productId))
		errors.push({ path: '/productId', message: 'must be a product id' });
	return result(errors, () => ({ productId: String(input.productId) }));
};

/** Largest receipt, in credits (keeps every amount an exact integer of millicredits). */
const MAX_RECEIPT_CREDITS = 1_000_000_000;

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null} trimmed text of 1..max characters, or null
 */
const text = (value, max) => {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
};

/**
 * The receipt form (PLAN 0.5.8): `credits` (whole, ≥ 1), `amountPaid` (free text ≤ 60, shown exactly as typed),
 * `method` (free text ≤ 60), optional `reference` (≤ 120).
 * @param {unknown} input
 * @returns {Checked<{ amount: number, amountPaid: string, method: string, reference: string | null }>}
 */
export const checkReceipt = (input) => {
	if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['credits', 'amountPaid', 'method', 'reference'], errors);
	const credits = input.credits;
	if (
		!Number.isSafeInteger(credits) ||
		/** @type {number} */ (credits) < 1 ||
		/** @type {number} */ (credits) > MAX_RECEIPT_CREDITS
	)
		errors.push({ path: '/credits', message: 'credits must be a whole number of 1 or more' });
	const amountPaid = text(input.amountPaid, 60);
	if (!amountPaid) errors.push({ path: '/amountPaid', message: 'amount paid is required (up to 60 characters)' });
	const method = text(input.method, 60);
	if (!method) errors.push({ path: '/method', message: 'payment method is required (up to 60 characters)' });
	const reference =
		input.reference === undefined || input.reference === null || input.reference === '' ? null : text(input.reference, 120);
	if (reference === null && !(input.reference === undefined || input.reference === null || input.reference === ''))
		errors.push({ path: '/reference', message: 'reference is up to 120 characters' });
	return result(errors, () => ({
		amount: /** @type {number} */ (credits) * 1000,
		amountPaid: /** @type {string} */ (amountPaid),
		method: /** @type {string} */ (method),
		reference,
	}));
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A range of UTC days (`from`, `to` inclusive, `YYYY-MM-DD`; default the last 30 days) with optional filters
 * (`websiteId`, `merchantId`, `method`).
 * @param {Record<string, string | undefined>} query
 * @param {number} now
 * @returns {Checked<{ from: string, to: string, websiteId: string | null, merchantId: string | null, method: string | null }>}
 */
export const checkDayRange = (query, now) => {
	/** @type {FieldError[]} */
	const errors = [];
	const today = new Date(now).toISOString().slice(0, 10);
	const monthAgo = new Date(now - 29 * 86_400_000).toISOString().slice(0, 10);
	/** @param {string | undefined} value @param {string} name @param {string} fallback */
	const day = (value, name, fallback) => {
		if (value === undefined || value === '') return fallback;
		if (!DAY.test(value) || Number.isNaN(Date.parse(value)))
			errors.push({ path: `/${name}`, message: `${name} must be a UTC day YYYY-MM-DD` });
		return value;
	};
	const from = day(query.from, 'from', monthAgo);
	const to = day(query.to, 'to', today);
	if (errors.length === 0 && from > to) errors.push({ path: '/to', message: 'to must not be before from' });
	if (errors.length === 0 && Date.parse(to) - Date.parse(from) > 400 * 86_400_000)
		errors.push({ path: '/to', message: 'range is limited to 400 days' });
	if (query.websiteId !== undefined && !isId(query.websiteId, 'web'))
		errors.push({ path: '/websiteId', message: 'invalid websiteId' });
	if (query.merchantId !== undefined && !isId(query.merchantId, 'mer'))
		errors.push({ path: '/merchantId', message: 'invalid merchantId' });
	const method = query.method === undefined || query.method === '' ? null : text(query.method, 60);
	if (query.method !== undefined && query.method !== '' && method === null)
		errors.push({ path: '/method', message: 'method is up to 60 characters' });
	return result(errors, () => ({
		from,
		to,
		websiteId: query.websiteId ?? null,
		merchantId: query.merchantId ?? null,
		method,
	}));
};
