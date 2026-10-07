/**
 * Request validation (pure): every Mode C body is checked here before anything is evaluated or stored, returning field
 * problems `{ path, code }` (JSON Pointer paths) that the API turns into RFC 9457 `errors[]`. Bounds come from the
 * website's effective feature values (passed in as `rules`), never from constants in handlers.
 * @module
 */
import { ACTION_TYPES, TARGETS, actionUsesMoney } from './actions.js';
import { CART_TYPES, CONDITION_TYPES, ITEM_TYPES, NUMERIC_TYPES, countConditions, usesMoney } from './conditions.js';
import { compileCondition } from './rules.js';
import { parseClock } from './schedule.js';
import { isTimeZone, WEEKDAYS } from './time.js';

/** Opaque ids (customers, orders, carts, items, references). */
export const ID_PATTERN = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const MAX_AMOUNT = 1_000_000_000_000;
const MAX_GROUP_DEPTH = 3;

/** @typedef {{ path: string, code: string }} FieldProblem */

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check an object's fields: unknown fields, required fields, then each present field's check.
 * @param {unknown} body
 * @param {Record<string, (value: unknown, path: string) => string | FieldProblem[] | null>} fields
 * @param {readonly string[]} required
 * @param {string} [base] JSON Pointer of the object
 * @returns {FieldProblem[]}
 */
export const checkFields = (body, fields, required, base = '') => {
	if (!isObject(body)) return [{ path: base, code: base ? 'object_invalid' : 'body_invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const key of Object.keys(body))
		if (!Object.hasOwn(fields, key)) problems.push({ path: `${base}/${key}`, code: 'unknown_field' });
	for (const [key, test] of Object.entries(fields)) {
		const path = `${base}/${key}`;
		if (body[key] === undefined) {
			if (required.includes(key)) problems.push({ path, code: 'required' });
			continue;
		}
		const outcome = test(body[key], path);
		if (typeof outcome === 'string') problems.push({ path, code: outcome });
		else if (Array.isArray(outcome)) problems.push(...outcome);
	}
	return problems;
};

/** @param {unknown} v */
export const idCheck = (v) => (typeof v === 'string' && ID_PATTERN.test(v) ? null : 'id_invalid');
/** @param {unknown} v */
const tokenCheck = (v) => (typeof v === 'string' && TOKEN.test(v) ? null : 'token_invalid');
/** @param {number} max */
const textCheck = (max) => (/** @type {unknown} */ v) =>
	typeof v === 'string' && v.trim().length > 0 && v.length <= max ? null : 'text_invalid';
/** @param {{ min?: number, max?: number, nullable?: boolean }} [range] */
const intCheck =
	({ min = 0, max = MAX_AMOUNT, nullable = false } = {}) =>
	(/** @type {unknown} */ v) =>
		(nullable && v === null) || (Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max)
			? null
			: 'integer_invalid';
/** @param {unknown} v */
const boolCheck = (v) => (typeof v === 'boolean' ? null : 'boolean_invalid');
/** @param {unknown} v */
const currencyCheck = (v) => (typeof v === 'string' && CURRENCY.test(v) ? null : 'currency_invalid');
/** @param {readonly string[]} values */
const enumCheck = (values) => (/** @type {unknown} */ v) => (typeof v === 'string' && values.includes(v) ? null : 'enum_invalid');
/** @param {number} max @param {(v: unknown) => boolean} item @param {number} [min] */
const listCheck =
	(max, item, min = 0) =>
	(/** @type {unknown} */ v) =>
		Array.isArray(v) && v.length >= min && v.length <= max && v.every(item) && new Set(v).size === v.length
			? null
			: 'list_invalid';
/** @param {unknown} v */
const isLabel = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
/** @param {unknown} v */
const isoCheck = (v) =>
	v === null || (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))) ? null : 'date_invalid';
/** @param {unknown} v */
const customCheck = (v) =>
	isObject(v) && Object.keys(v).length <= 50 && JSON.stringify(v).length <= 4096 ? null : 'object_invalid';

// ── cart ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} v
 * @param {string} path
 * @returns {FieldProblem[]}
 */
const attributesCheck = (v, path) => {
	if (!isObject(v) || Object.keys(v).length > 50) return [{ path, code: 'object_invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const [key, value] of Object.entries(v)) {
		const ok =
			key.length <= 64 &&
			((typeof value === 'string' && value.length <= 200) ||
				(Array.isArray(value) &&
					value.length <= 50 &&
					value.every((entry) => typeof entry === 'string' && entry.length <= 200)));
		if (!ok) problems.push({ path: `${path}/${key}`, code: 'attribute_invalid' });
	}
	return problems;
};

/**
 * A generic cart.
 * @param {unknown} cart
 * @param {{ maxLines: number }} rules
 * @param {string} [base]
 * @returns {FieldProblem[]}
 */
export const validateCart = (cart, { maxLines }, base = '/cart') => {
	const problems = checkFields(
		cart,
		{
			currency: currencyCheck,
			lines: (v, path) => {
				if (!Array.isArray(v) || v.length > maxLines) return 'lines_invalid';
				return v.flatMap((line, index) =>
					checkFields(
						line,
						{
							lineId: idCheck,
							itemId: idCheck,
							variantId: idCheck,
							quantity: intCheck({ min: 1, max: 1_000_000 }),
							unitAmount: intCheck(),
							attributes: attributesCheck,
							collections: listCheck(50, isLabel),
						},
						['itemId', 'quantity', 'unitAmount'],
						`${path}/${index}`,
					),
				);
			},
			shipping: intCheck(),
			customer: (v, path) =>
				checkFields(
					v,
					{
						id: idCheck,
						orderCount: intCheck({ max: 10_000_000 }),
						segments: listCheck(50, isLabel),
						email: (e) => (typeof e === 'string' && e.length <= 320 && EMAIL.test(e.trim()) ? null : 'email_invalid'),
						country: (c) => (typeof c === 'string' && COUNTRY.test(c) ? null : 'country_invalid'),
					},
					[],
					path,
				),
			paymentMethod: tokenCheck,
			deliveryMethod: tokenCheck,
			context: (v, path) =>
				checkFields(
					v,
					{
						country: (c) => (typeof c === 'string' && COUNTRY.test(c) ? null : 'country_invalid'),
						device: tokenCheck,
						source: textCheck(200),
						deviceId: idCheck,
					},
					[],
					path,
				),
		},
		['currency', 'lines'],
		base,
	);
	if (problems.length === 0 && isObject(cart) && Array.isArray(cart.lines)) {
		const ids = cart.lines.map((/** @type {any} */ line, /** @type {number} */ index) => line.lineId ?? String(index + 1));
		if (new Set(ids).size !== ids.length) problems.push({ path: `${base}/lines`, code: 'duplicate_line_id' });
	}
	return problems;
};

// ── coupons ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} CouponRules bounds from the website's feature values
 * @property {{ minLength: number, maxLength: number }} code
 * @property {number} minRandom
 * @property {number} maxCodesPerBatch
 * @property {readonly string[]} allowedTypes
 * @property {number} maxPercent
 * @property {number} maxFixedAmount 0 = none
 * @property {number} maxTiers
 * @property {number} maxConditions
 * @property {boolean} allowRules
 * @property {number} maxRuleLength
 * @property {readonly string[]} classes stacking class keys (empty = stacking off: any class string)
 */

/**
 * @param {unknown} v
 * @param {string} path
 * @param {number} depth
 * @returns {FieldProblem[]}
 */
export const validateCondition = (v, path, depth = 1) => {
	if (!isObject(v)) return [{ path, code: 'condition_invalid' }];
	const shape = checkFields(
		v,
		{ type: enumCheck(CONDITION_TYPES), operator: () => null, value: () => null },
		['type', 'operator', 'value'],
		path,
	);
	if (shape.length > 0) return shape;
	const { type, operator, value } = v;
	const bad = (/** @type {string} */ code, /** @type {string} */ field = 'value') => [{ path: `${path}/${field}`, code }];
	if (type === 'group') {
		if (operator !== 'and' && operator !== 'or') return bad('operator_invalid', 'operator');
		if (depth >= MAX_GROUP_DEPTH) return bad('group_too_deep');
		if (!Array.isArray(value) || value.length === 0 || value.length > 20) return bad('group_invalid');
		return value.flatMap((member, index) => validateCondition(member, `${path}/value/${index}`, depth + 1));
	}
	if (type === 'first_order') {
		if (operator !== 'eq') return bad('operator_invalid', 'operator');
		return typeof value === 'boolean' ? [] : bad('boolean_invalid');
	}
	if (NUMERIC_TYPES.includes(type)) {
		if (!['gte', 'lte', 'between'].includes(operator)) return bad('operator_invalid', 'operator');
		const amount = (/** @type {unknown} */ n) =>
			Number.isInteger(n) && /** @type {number} */ (n) >= 0 && /** @type {number} */ (n) <= MAX_AMOUNT;
		if (operator === 'between')
			return Array.isArray(value) && value.length === 2 && amount(value[0]) && amount(value[1]) && value[0] <= value[1]
				? []
				: bad('range_invalid');
		return amount(value) ? [] : bad('integer_invalid');
	}
	if (operator !== 'in' && operator !== 'not_in') return bad('operator_invalid', 'operator');
	if (type === 'attributes') {
		if (!isObject(value) || typeof value.key !== 'string' || value.key.length === 0 || value.key.length > 64)
			return bad('attribute_invalid');
		const values = value.values;
		return Array.isArray(values) &&
			values.length > 0 &&
			values.length <= 100 &&
			values.every(isLabel) &&
			Object.keys(value).length === 2
			? []
			: bad('attribute_invalid');
	}
	if (ITEM_TYPES.includes(type) || CART_TYPES.includes(type))
		return Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every(isLabel) ? [] : bad('list_invalid');
	return bad('condition_invalid', 'type');
};

/**
 * @param {unknown} v
 * @param {string} path
 * @param {CouponRules} rules
 * @returns {FieldProblem[]}
 */
export const validateAction = (v, path, rules) => {
	if (!isObject(v)) return [{ path, code: 'object_invalid' }];
	if (!ACTION_TYPES.includes(v.type)) return [{ path: `${path}/type`, code: 'enum_invalid' }];
	if (!rules.allowedTypes.includes(v.type)) return [{ path: `${path}/type`, code: 'type_not_allowed' }];
	const percent = (/** @type {unknown} */ p) =>
		typeof p === 'number' && Number.isFinite(p) && p > 0 && p <= rules.maxPercent ? null : 'percent_invalid';
	const amount = (/** @type {unknown} */ a) =>
		!Number.isInteger(a) || /** @type {number} */ (a) < 1 || /** @type {number} */ (a) > MAX_AMOUNT
			? 'integer_invalid'
			: rules.maxFixedAmount > 0 && /** @type {number} */ (a) > rules.maxFixedAmount
				? 'above_maximum'
				: null;
	const target = enumCheck(TARGETS);
	const type = { type: () => null };
	switch (v.type) {
		case 'percent':
			return checkFields(v, { ...type, percent, target, max_discount: intCheck() }, ['type', 'percent'], path);
		case 'fixed':
			return checkFields(v, { ...type, amount, target, per_unit: boolCheck }, ['type', 'amount'], path);
		case 'free_shipping':
			return checkFields(v, { ...type, max_amount: intCheck() }, ['type'], path);
		case 'bxgy':
			return checkFields(
				v,
				{
					...type,
					buy: intCheck({ min: 1, max: 100 }),
					get: intCheck({ min: 1, max: 100 }),
					percent,
					max_applications: intCheck({ max: 1000 }),
				},
				['type', 'buy', 'get'],
				path,
			);
		case 'tiered':
			return checkFields(
				v,
				{
					...type,
					basis: enumCheck(['quantity', 'subtotal']),
					target,
					tiers: (tiers, tiersPath) => {
						if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > rules.maxTiers) return 'tiers_invalid';
						const problems = tiers.flatMap((tier, index) => {
							const tierPath = `${tiersPath}/${index}`;
							const shape = checkFields(tier, { min: intCheck(), percent, amount }, ['min'], tierPath);
							if (shape.length > 0) return shape;
							return (tier.percent === undefined) === (tier.amount === undefined)
								? [{ path: tierPath, code: 'percent_or_amount' }]
								: [];
						});
						const mins = tiers.map((tier) => tier?.min);
						if (problems.length === 0 && new Set(mins).size !== mins.length)
							problems.push({ path: tiersPath, code: 'duplicate_min' });
						return problems;
					},
				},
				['type', 'basis', 'tiers'],
				path,
			);
		default:
			return checkFields(
				v,
				{
					...type,
					item_id: idCheck,
					variant_id: idCheck,
					quantity: intCheck({ min: 1, max: 100 }),
					discount_in_cart: boolCheck,
				},
				['type', 'item_id'],
				path,
			);
	}
};

/**
 * @param {unknown} v
 * @param {string} path
 * @param {CouponRules} rules
 * @returns {FieldProblem[]}
 */
const eligibilityCheck = (v, path, rules) =>
	checkFields(
		v,
		{
			when: (when, whenPath) => {
				if (typeof when !== 'string' || when.length > rules.maxRuleLength) return 'text_invalid';
				if (when.trim() === '') return null;
				if (!rules.allowRules) return 'rules_not_allowed';
				const compiled = compileCondition(when);
				return compiled.ok ? null : [{ path: whenPath, code: `rule_${compiled.error.code}` }];
			},
			conditions: (conditions, conditionsPath) => {
				if (!Array.isArray(conditions)) return 'list_invalid';
				const problems = conditions.flatMap((condition, index) => validateCondition(condition, `${conditionsPath}/${index}`));
				if (problems.length === 0 && countConditions(conditions) > rules.maxConditions) return 'too_many_conditions';
				return problems;
			},
		},
		[],
		path,
	);

/**
 * @param {unknown} v
 * @param {string} path
 * @returns {FieldProblem[]}
 */
const validityCheck = (v, path) => {
	const problems = checkFields(
		v,
		{
			starts_at: isoCheck,
			ends_at: isoCheck,
			time_zone: (zone) => (zone === null || isTimeZone(zone) ? null : 'time_zone_invalid'),
			windows: (windows, windowsPath) => {
				if (!Array.isArray(windows) || windows.length > 14) return 'list_invalid';
				return windows.flatMap((slot, index) =>
					checkFields(
						slot,
						{
							days: listCheck(
								7,
								(day) => typeof day === 'string' && /** @type {readonly string[]} */ (WEEKDAYS).includes(day),
								1,
							),
							start: (clock) => (parseClock(clock) !== null && clock !== '24:00' ? null : 'clock_invalid'),
							end: (clock) => (parseClock(clock) !== null ? null : 'clock_invalid'),
						},
						[],
						`${windowsPath}/${index}`,
					),
				);
			},
		},
		[],
		path,
	);
	if (problems.length === 0 && isObject(v) && typeof v.starts_at === 'string' && typeof v.ends_at === 'string')
		if (Date.parse(v.starts_at) > Date.parse(v.ends_at)) problems.push({ path: `${path}/ends_at`, code: 'before_start' });
	return problems;
};

/**
 * `POST /v1/coupons` (mode `create`) or the merged result of `PATCH /v1/coupons/{id}` (mode `update`: no code fields).
 * @param {unknown} body
 * @param {CouponRules} rules
 * @param {{ mode?: 'create' | 'update' }} [options]
 * @returns {FieldProblem[]}
 */
export const validateCoupon = (body, rules, { mode = 'create' } = {}) => {
	const create = mode === 'create';
	/** @type {Record<string, (value: unknown, path: string) => string | FieldProblem[] | null>} */
	const fields = {
		name: textCheck(120),
		description: (v) => (typeof v === 'string' && v.length <= 500 ? null : 'text_invalid'),
		status: enumCheck(create ? ['active', 'paused'] : ['active', 'paused', 'archived']),
		currency: (v) => (v === null || currencyCheck(v) === null ? null : 'currency_invalid'),
		action: (v, path) => validateAction(v, path, rules),
		eligibility: (v, path) => eligibilityCheck(v, path, rules),
		limits: (v, path) =>
			checkFields(
				v,
				{
					total: intCheck({ min: 1, max: 1_000_000_000, nullable: true }),
					per_customer: intCheck({ min: 1, max: 1_000_000, nullable: true }),
					per_device: intCheck({ min: 1, max: 1_000_000, nullable: true }),
					per_code: intCheck({ min: 1, max: 1_000_000_000, nullable: true }),
				},
				[],
				path,
			),
		stacking: (v, path) =>
			checkFields(
				v,
				{
					class: (c) =>
						typeof c === 'string' &&
						/^[a-z][a-z0-9_]{0,31}$/.test(c) &&
						(rules.classes.length === 0 || rules.classes.includes(c))
							? null
							: 'class_invalid',
					exclusive: boolCheck,
					priority: (p) => (Number.isInteger(p) && Math.abs(/** @type {number} */ (p)) <= 1000 ? null : 'integer_invalid'),
					with_loyalty: boolCheck,
					with_deals: boolCheck,
				},
				[],
				path,
			),
		validity: validityCheck,
		custom: customCheck,
	};
	if (create) {
		fields.code = (v) => {
			if (typeof v !== 'string') return 'code_invalid';
			const code = v.trim();
			return code.length >= rules.code.minLength &&
				code.length <= rules.code.maxLength &&
				/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)
				? null
				: 'code_invalid';
		};
		fields.pattern = (v) =>
			typeof v === 'string' && v.length > 0 && v.length <= rules.code.maxLength ? null : 'pattern_invalid';
		fields.count = intCheck({ min: 1, max: rules.maxCodesPerBatch });
	}
	const problems = checkFields(body, fields, ['name', 'action']);
	if (problems.length > 0 || !isObject(body)) return problems;
	if (create && body.code !== undefined && (body.pattern !== undefined || body.count !== undefined))
		problems.push({ path: body.count !== undefined ? '/count' : '/pattern', code: 'conflicts_with_code' });
	const conditions = Array.isArray(body.eligibility?.conditions) ? body.eligibility.conditions : [];
	if ((actionUsesMoney(body.action) || usesMoney(conditions)) && typeof body.currency !== 'string')
		problems.push({ path: '/currency', code: 'required' });
	return problems;
};

/**
 * `POST /v1/coupons/{id}/codes:generate`.
 * @param {unknown} body
 * @param {{ maxCodesPerBatch: number, maxLength: number }} rules
 */
export const validateGenerate = (body, { maxCodesPerBatch, maxLength }) =>
	checkFields(
		body,
		{
			count: intCheck({ min: 1, max: maxCodesPerBatch }),
			pattern: (v) => (typeof v === 'string' && v.length > 0 && v.length <= maxLength ? null : 'pattern_invalid'),
		},
		['count'],
	);

/**
 * `PATCH /v1/codes/{code}`.
 * @param {unknown} body
 */
export const validateCodePatch = (body) => checkFields(body, { status: enumCheck(['active', 'disabled']) }, ['status']);

// ── checkout ────────────────────────────────────────────────────────────────────────────────────────────────

/** @param {number} max */
const codesCheck = (max) => (/** @type {unknown} */ v) =>
	Array.isArray(v) &&
	v.length >= 1 &&
	v.length <= max &&
	v.every((code) => typeof code === 'string' && code.length > 0 && code.length <= 64)
		? null
		: 'codes_invalid';

/**
 * `POST /v1/validations` — one code against a cart.
 * @param {unknown} body
 * @param {{ maxLines: number }} rules
 */
export const validateValidation = (body, rules) =>
	checkFields(
		body,
		{
			code: (v) => (typeof v === 'string' && v.trim().length > 0 && v.length <= 64 ? null : 'code_invalid'),
			cart: (v, path) => validateCart(v, rules, path),
		},
		['code', 'cart'],
	);

/**
 * `POST /v1/quotes` — several codes against a cart (stacking applied).
 * @param {unknown} body
 * @param {{ maxLines: number, maxCodes: number }} rules
 */
export const validateQuote = (body, rules) =>
	checkFields(body, { codes: codesCheck(rules.maxCodes), cart: (v, path) => validateCart(v, rules, path) }, ['codes', 'cart']);

/**
 * `POST /v1/reservations` and `POST /v1/redemptions` (reserve and redeem at once).
 * @param {unknown} body
 * @param {{ maxLines: number, maxCodes: number }} rules
 */
export const validateReservation = (body, rules) =>
	checkFields(
		body,
		{
			codes: codesCheck(rules.maxCodes),
			cart: (v, path) => validateCart(v, rules, path),
			orderId: idCheck,
			reference: idCheck,
		},
		['codes', 'cart'],
	);

/**
 * `POST /v1/reservations/{id}/redeem`.
 * @param {unknown} body
 */
export const validateRedeem = (body) => (body === null || body === undefined ? [] : checkFields(body, { orderId: idCheck }, []));

/**
 * `POST /v1/reservations/{id}/release` and `POST /v1/redemptions/{id}/release`.
 * @param {unknown} body
 */
export const validateRelease = (body) =>
	body === null || body === undefined ? [] : checkFields(body, { reason: textCheck(200) }, []);

/**
 * `POST /v1/blocks`.
 * @param {unknown} body
 */
export const validateBlock = (body) =>
	checkFields(
		body,
		{
			kind: enumCheck(['customer', 'email', 'device', 'code']),
			value: (v) => (typeof v === 'string' && v.trim().length > 0 && v.length <= 320 ? null : 'text_invalid'),
			note: textCheck(500),
		},
		['kind', 'value'],
	);

/**
 * `POST /v1/share-links`.
 * @param {unknown} body
 */
export const validateShareLink = (body) =>
	checkFields(
		body,
		{
			code: (v) => (typeof v === 'string' && v.trim().length > 0 && v.length <= 64 ? null : 'code_invalid'),
			path: (v) =>
				typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v.length <= 500 ? null : 'path_invalid',
			campaign: (v) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? null : 'token_invalid'),
		},
		['code'],
	);

/**
 * `POST /v1/eligibility:check` — diagnostics for a rules@1 condition and structured conditions, optionally run on a cart.
 * @param {unknown} body
 * @param {{ maxLines: number, maxConditions: number, maxRuleLength: number }} rules
 */
export const validateEligibilityCheck = (body, rules) =>
	checkFields(
		body,
		{
			when: (v) => (typeof v === 'string' && v.length <= rules.maxRuleLength ? null : 'text_invalid'),
			conditions: (v, path) => {
				if (!Array.isArray(v)) return 'list_invalid';
				const problems = v.flatMap((condition, index) => validateCondition(condition, `${path}/${index}`));
				return problems.length === 0 && countConditions(v) > rules.maxConditions ? 'too_many_conditions' : problems;
			},
			cart: (v, path) => validateCart(v, rules, path),
		},
		[],
	);
