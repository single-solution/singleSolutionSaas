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

/**
 * Staff credit operations. `kind` decides the sign rule: credits and refunds take a positive amount, adjustments any
 * non-zero amount.
 * @param {'credit' | 'adjustment' | 'refund'} kind
 * @param {unknown} input
 * @returns {Checked<{ amountMillicredits: number, reference: string, note: string }>}
 */
export const checkCreditOperation = (kind, input) => {
	if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['amountMillicredits', 'reference', 'note'], errors);
	const amount = input.amountMillicredits;
	if (!Number.isSafeInteger(amount))
		errors.push({ path: '/amountMillicredits', message: 'amount must be integer millicredits' });
	else if (kind === 'adjustment' ? amount === 0 : /** @type {number} */ (amount) <= 0)
		errors.push({ path: '/amountMillicredits', message: kind === 'adjustment' ? 'amount cannot be 0' : 'amount must be > 0' });
	if (typeof input.reference !== 'string' || !/^[\x21-\x7e]{1,120}$/.test(input.reference))
		errors.push({ path: '/reference', message: 'reference must be 1..120 visible ASCII characters' });
	if (typeof input.note !== 'string' || input.note.trim().length === 0 || input.note.length > 500)
		errors.push({ path: '/note', message: 'note must be 1..500 characters' });
	return result(errors, () => ({
		amountMillicredits: /** @type {number} */ (amount),
		reference: /** @type {string} */ (input.reference),
		note: /** @type {string} */ (input.note).trim(),
	}));
};

/**
 * Body of `PUT /v1/merchants/:merchantId/spend-cap`: `{ limit }`, positive integer millicredits per UTC month.
 * @param {unknown} input
 * @returns {Checked<{ limit: number }>}
 */
export const checkSpendCap = (input) => {
	if (!isObject(input)) return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
	/** @type {FieldError[]} */
	const errors = [];
	noExtra(input, ['limit'], errors);
	if (!Number.isSafeInteger(input.limit) || /** @type {number} */ (input.limit) < 1)
		errors.push({ path: '/limit', message: 'limit must be a positive integer of millicredits' });
	return result(errors, () => ({ limit: /** @type {number} */ (input.limit) }));
};

/**
 * @param {Record<string, string | undefined>} query
 * @param {number} now
 * @returns {Checked<{ from: number, to: number, websiteId: string | null }>}
 */
export const checkStatementQuery = (query, now) => {
	/** @type {FieldError[]} */
	const errors = [];
	/**
	 * @param {string | undefined} value
	 * @param {string} name
	 * @param {number} fallback
	 */
	const instant = (value, name, fallback) => {
		if (value === undefined || value === '') return fallback;
		const ms = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value) ? Date.parse(value) : Number.NaN;
		if (Number.isNaN(ms)) errors.push({ path: `/${name}`, message: `${name} must be an ISO-8601 UTC date or instant` });
		return ms;
	};
	const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
	const from = instant(query.from, 'from', monthStart);
	const to = instant(query.to, 'to', now + 1); // exclusive bound: include entries written at `now`
	if (errors.length === 0 && from >= to) errors.push({ path: '/to', message: 'to must be after from' });
	if (errors.length === 0 && to - from > 400 * 86_400_000) errors.push({ path: '/to', message: 'range is limited to 400 days' });
	if (query.websiteId !== undefined && !isId(query.websiteId, 'web'))
		errors.push({ path: '/websiteId', message: 'invalid websiteId' });
	return result(errors, () => ({ from, to, websiteId: query.websiteId ?? null }));
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
