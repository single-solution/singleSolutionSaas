/**
 * Request validation (pure): every Mode C body is checked here before anything is stored, returning field problems
 * `{ path, code }` (JSON Pointer paths) that the API turns into RFC 9457 `errors[]`.
 * @module
 */

/** Opaque ids of customers, orders, carts and references. */
export const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
/** Custom event types accepted by `POST /v1/activities` and manual earns. */
export const CUSTOM_TYPE_PATTERN = /^custom\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*@[1-9][0-9]*$/;
const CURRENCY = /^[A-Z]{3}$/;

/** @typedef {{ path: string, code: string }} FieldProblem */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} body
 * @param {Record<string, (value: unknown) => string | null>} fields field → check returning a code (null = ok)
 * @param {string[]} required
 * @returns {FieldProblem[]}
 */
export const checkFields = (body, fields, required) => {
	if (!isObject(body)) return [{ path: '', code: 'body_invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const key of Object.keys(body))
		if (!Object.hasOwn(fields, key)) problems.push({ path: `/${key}`, code: 'unknown_field' });
	for (const [key, test] of Object.entries(fields)) {
		if (body[key] === undefined) {
			if (required.includes(key)) problems.push({ path: `/${key}`, code: 'required' });
			continue;
		}
		const code = test(body[key]);
		if (code) problems.push({ path: `/${key}`, code });
	}
	return problems;
};

/** @param {unknown} v */
export const idCheck = (v) => (typeof v === 'string' && ID_PATTERN.test(v) ? null : 'id_invalid');
/** @param {number} [max] */
const textCheck =
	(max = 500) =>
	(/** @type {unknown} */ v) =>
		typeof v === 'string' && v.trim().length > 0 && v.length <= max ? null : 'text_invalid';
/** @param {{ min?: number, max?: number }} [range] */
const intCheck =
	({ min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
	(/** @type {unknown} */ v) =>
		Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max ? null : 'integer_invalid';
/** @param {unknown} v */
const currencyCheck = (v) => (typeof v === 'string' && CURRENCY.test(v) ? null : 'currency_invalid');
/** @param {unknown} v */
const objectCheck = (v) => (isObject(v) && Object.keys(v).length <= 200 ? null : 'object_invalid');
/** @param {unknown} v */
const customTypeCheck = (v) => (typeof v === 'string' && CUSTOM_TYPE_PATTERN.test(v) ? null : 'type_invalid');

/**
 * `POST /v1/earnings` — a manual / API credit of `points`.
 * @param {unknown} body
 * @param {{ maxPoints: number }} limits
 */
export const validateEarn = (body, { maxPoints }) =>
	checkFields(
		body,
		{ customerId: idCheck, points: intCheck({ min: 1, max: maxPoints }), reason: textCheck(200), reference: idCheck },
		['customerId', 'points'],
	);

/**
 * `POST /v1/activities` — a custom event evaluated against the earn rules.
 * @param {unknown} body
 */
export const validateActivity = (body) =>
	checkFields(body, { id: idCheck, type: customTypeCheck, customerId: idCheck, data: objectCheck }, ['type', 'customerId']);

/**
 * `POST /v1/redemptions:quote`.
 * @param {unknown} body
 */
export const validateQuote = (body) =>
	checkFields(body, { customerId: idCheck, amount: intCheck(), currency: currencyCheck, discount: intCheck() }, [
		'customerId',
		'amount',
		'currency',
	]);

/**
 * `POST /v1/redemptions`.
 * @param {unknown} body
 */
export const validateRedeem = (body) =>
	checkFields(
		body,
		{
			customerId: idCheck,
			points: intCheck({ min: 1 }),
			amount: intCheck(),
			currency: currencyCheck,
			discount: intCheck(),
			orderId: idCheck,
			reference: idCheck,
		},
		['customerId', 'points', 'amount', 'currency'],
	);

/**
 * `POST /v1/redemptions/{id}/confirm`.
 * @param {unknown} body
 */
export const validateConfirm = (body) => checkFields(body, { orderId: idCheck }, ['orderId']);

/**
 * `POST /v1/adjustments`.
 * @param {unknown} body
 * @param {{ maxPoints: number, reasons: readonly string[], requireNote: boolean }} rules
 */
export const validateAdjustment = (body, { maxPoints, reasons, requireNote }) =>
	checkFields(
		body,
		{
			customerId: idCheck,
			points: (v) =>
				Number.isInteger(v) && v !== 0 && Math.abs(/** @type {number} */ (v)) <= maxPoints ? null : 'points_invalid',
			reason: (v) => (typeof v === 'string' && reasons.includes(v) ? null : 'reason_invalid'),
			note: textCheck(500),
		},
		requireNote ? ['customerId', 'points', 'reason', 'note'] : ['customerId', 'points', 'reason'],
	);

/**
 * Bodies with only a customer id (`POST /v1/referral-codes`, `POST /v1/wallet-tokens`).
 * @param {unknown} body
 */
export const validateCustomer = (body) => checkFields(body, { customerId: idCheck }, ['customerId']);

/**
 * `POST /v1/referrals`.
 * @param {unknown} body
 */
export const validateReferral = (body) =>
	checkFields(
		body,
		{ code: (v) => (typeof v === 'string' && /^[A-Za-z0-9 -]{4,40}$/.test(v) ? null : 'code_invalid'), customerId: idCheck },
		['code', 'customerId'],
	);
