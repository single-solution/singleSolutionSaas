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

const CODE = /^[a-z][a-z0-9_.:-]{0,199}$/;
const PLAN = /^[a-z][a-z0-9_-]{0,39}$/;
const ELEMENT = /^[a-z][a-z0-9_]{0,63}$/;
const UNIT = /^[a-z][a-z0-9_]{0,39}$/;
const KEY = /^[\x21-\x7e]{1,255}$/;
export const MAX_USAGE_RECORDS = 1000;
export const MAX_QUANTITY = 1_000_000_000;

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

/**
 * @param {unknown} input
 * @returns {Checked<{ appId: string, planCode: string | null }>}
 */
export const checkSubscribe = (input) => {
	if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['appId', 'planCode'], errors);
	if (!isId(input.appId)) errors.push({ path: '/appId', message: 'appId must be an id' });
	if (
		input.planCode !== undefined &&
		input.planCode !== null &&
		(typeof input.planCode !== 'string' || !PLAN.test(input.planCode))
	)
		errors.push({ path: '/planCode', message: 'planCode is invalid' });
	return result(errors, () => ({
		appId: /** @type {string} */ (input.appId),
		planCode: typeof input.planCode === 'string' ? input.planCode : null,
	}));
};

/**
 * @param {unknown} input
 * @returns {Checked<{ planCode: string | null }>}
 */
export const checkPlanChange = (input) => {
	if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['planCode'], errors);
	if (!('planCode' in input)) errors.push({ path: '/planCode', message: 'planCode is required (null for no plan)' });
	else if (input.planCode !== null && (typeof input.planCode !== 'string' || !PLAN.test(input.planCode)))
		errors.push({ path: '/planCode', message: 'planCode is invalid' });
	return result(errors, () => ({ planCode: typeof input.planCode === 'string' ? input.planCode : null }));
};

/**
 * @param {string} key
 * @param {unknown} input
 * @returns {Checked<{ elementKey: string, enabled: boolean }>}
 */
export const checkElementSwitch = (key, input) => {
	/** @type {FieldError[]} */
	const errors = [];
	if (!ELEMENT.test(key)) errors.push({ path: '/elementKey', message: 'elementKey is invalid' });
	if (!isObject(input)) errors.push({ path: '', message: 'body must be an object { enabled }' });
	else {
		noExtra(input, ['enabled'], errors);
		if (typeof input.enabled !== 'boolean') errors.push({ path: '/enabled', message: 'enabled must be a boolean' });
	}
	return result(errors, () => ({ elementKey: key, enabled: /** @type {any} */ (input).enabled }));
};

/**
 * Optional `{ reason }` (a lower-case code, default `fallback`).
 * @param {unknown} input
 * @param {string} fallback
 * @returns {Checked<{ reason: string }>}
 */
export const checkReason = (input, fallback) => {
	if (input === undefined || input === null) return { ok: true, value: { reason: fallback } };
	if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['reason'], errors);
	if (input.reason !== undefined && (typeof input.reason !== 'string' || !CODE.test(input.reason)))
		errors.push({ path: '/reason', message: 'reason must be a lower-case code' });
	return result(errors, () => ({ reason: typeof input.reason === 'string' ? input.reason : fallback }));
};

/** Largest receipt, in credits (keeps every amount an exact integer of millicredits). */
export const MAX_RECEIPT_CREDITS = 1_000_000_000;

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

/**
 * @typedef {object} UsageRecord
 * @property {string} websiteId
 * @property {string} subscriptionId
 * @property {string} unit
 * @property {number} quantity
 * @property {string} idempotencyKey
 * @property {Date} occurredAt
 */

/**
 * The usage batch envelope (F.9). Individual records are checked by {@link checkUsageRecord}.
 * @param {unknown} input
 * @returns {Checked<unknown[]>}
 */
export const checkUsageBatch = (input) => {
	if (!isObject(input) || !Array.isArray(input.records))
		return { ok: false, errors: [{ path: '/records', message: 'body must be { records: [...] }' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['records'], errors);
	if (input.records.length === 0 || input.records.length > MAX_USAGE_RECORDS)
		errors.push({ path: '/records', message: `1..${MAX_USAGE_RECORDS} records` });
	return result(errors, () => /** @type {unknown[]} */ (input.records));
};

/**
 * One usage record: `{ ok: true, value }` or `{ ok: false, reason, idempotencyKey }`.
 * @param {unknown} record
 * @returns {{ ok: true, value: UsageRecord } | { ok: false, reason: string, idempotencyKey: string | null }}
 */
export const checkUsageRecord = (record) => {
	if (!isObject(record)) return { ok: false, reason: 'invalid_record', idempotencyKey: null };
	const key = typeof record.idempotencyKey === 'string' && KEY.test(record.idempotencyKey) ? record.idempotencyKey : null;
	if (key === null) return { ok: false, reason: 'invalid_idempotency_key', idempotencyKey: null };
	const fail = (/** @type {string} */ reason) => ({ ok: /** @type {const} */ (false), reason, idempotencyKey: key });
	const allowed = ['websiteId', 'subscriptionId', 'unit', 'quantity', 'idempotencyKey', 'occurredAt'];
	if (Object.keys(record).some((k) => !allowed.includes(k))) return fail('invalid_record');
	if (!isId(record.websiteId, 'web') || !isId(record.subscriptionId, 'sub')) return fail('invalid_record');
	if (typeof record.unit !== 'string' || !UNIT.test(record.unit)) return fail('unknown_unit');
	if (
		!Number.isSafeInteger(record.quantity) ||
		/** @type {number} */ (record.quantity) < 0 ||
		/** @type {number} */ (record.quantity) > MAX_QUANTITY
	)
		return fail('invalid_quantity');
	const occurredAt =
		typeof record.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(record.occurredAt)
			? Date.parse(record.occurredAt)
			: Number.NaN;
	if (Number.isNaN(occurredAt)) return fail('invalid_occurred_at');
	return {
		ok: true,
		value: {
			websiteId: /** @type {string} */ (record.websiteId),
			subscriptionId: /** @type {string} */ (record.subscriptionId),
			unit: record.unit,
			quantity: /** @type {number} */ (record.quantity),
			idempotencyKey: key,
			occurredAt: new Date(occurredAt),
		},
	};
};
