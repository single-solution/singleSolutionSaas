/**
 * Earning (pure): which rules fire for an event, how many points each gives, multipliers, rounding and caps.
 *
 * - A rule fires when it is enabled, its `trigger` equals the event's `type@v` (a trigger without `@v` matches every
 *   version) and its rules@1 `when` condition matches the context `{ event, order, customer, tier }`.
 * - Formulas: `fixed` → `points`; `percent` → amount × percent / 100 (amount = `field`, default
 *   `order.eligibleAmount`, in minor units); `per_unit` → ⌊units / per⌋ × points (units = `field`, default
 *   `order.eligibleUnits`). ibrahimMobiles' `pointsEarnedFor` is `percent` with floor rounding.
 * - The member's tier multiplier applies when `apply_tier_multiplier`; rounding (`floor` | `round` | `ceil`) is applied
 *   once, after the multiplier; then the per-event cap, the per-customer period cap (`day|week|month|year` in the
 *   website zone) and the global per-transaction maximum.
 * - Exclusions remove order lines (by item id or SKU) from the eligible amount and units; discounts are subtracted
 *   proportionally to the eligible share unless `subtract_discounts` is false; shipping and tax count only when
 *   included.
 * @module
 */
import { conditionMatches } from './rules.js';
import { periodKey } from './time.js';

/**
 * @typedef {object} EarnRule
 * @property {string} id
 * @property {string} [name]
 * @property {string} trigger
 * @property {string} [when]
 * @property {{ kind: 'fixed' | 'percent' | 'per_unit', points?: number, percent?: number, per?: number, field?: string }} formula
 * @property {{ per_event?: number, per_period?: number, period?: 'day' | 'week' | 'month' | 'year' }} [caps]
 * @property {{ item_ids?: string[], skus?: string[], include_shipping?: boolean, include_tax?: boolean, subtract_discounts?: boolean }} [exclusions]
 * @property {boolean} [apply_tier_multiplier]
 * @property {boolean} [enabled]
 */
/**
 * @typedef {object} OrderSnapshot
 * @property {string} orderId
 * @property {string} [number]
 * @property {string} [customerId]
 * @property {string} [currency]
 * @property {Array<{ itemId: string, sku?: string, quantity: number, unitAmount: number, totalAmount?: number }>} [lines]
 * @property {{ subtotal: number, total: number, discount?: number, shipping?: number, tax?: number }} [amounts]
 */
/** @typedef {'floor' | 'round' | 'ceil'} Rounding */
/** @typedef {Record<string, { key: string, points: number }>} RuleUsage per rule: current period key and points earned in it */
/**
 * @typedef {object} Earning
 * @property {string} ruleId
 * @property {number} base points before multiplier and caps
 * @property {number} points awarded
 * @property {boolean} capped
 */

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Line total in minor units (`totalAmount`, else `unitAmount × quantity`).
 * @param {{ quantity: number, unitAmount: number, totalAmount?: number }} line
 */
export const lineTotal = (line) =>
	typeof line.totalAmount === 'number' ? line.totalAmount : num(line.unitAmount) * Math.max(0, num(line.quantity));

/**
 * Order facts used by formulas and conditions, honouring a rule's exclusions.
 * @param {OrderSnapshot} order
 * @param {EarnRule['exclusions']} [exclusions]
 */
export const orderFacts = (order, exclusions = {}) => {
	const lines = order.lines ?? [];
	const itemIds = new Set(exclusions.item_ids ?? []);
	const skus = new Set(exclusions.skus ?? []);
	const excluded = (/** @type {{ itemId: string, sku?: string }} */ line) =>
		itemIds.has(line.itemId) || (line.sku !== undefined && skus.has(line.sku));
	const amounts = order.amounts ?? { subtotal: 0, total: 0 };
	const linesTotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
	const eligibleLines = lines.filter((line) => !excluded(line));
	const eligibleLinesTotal = eligibleLines.reduce((sum, line) => sum + lineTotal(line), 0);
	// orders without lines (or with zero-value lines) fall back to the subtotal
	const share = linesTotal > 0 ? eligibleLinesTotal / linesTotal : lines.length === 0 ? 1 : 0;
	const merchandise = lines.length === 0 || linesTotal <= 0 ? num(amounts.subtotal) * share : eligibleLinesTotal;
	const discount = exclusions.subtract_discounts === false ? 0 : num(amounts.discount) * share;
	const eligibleAmount = Math.max(
		0,
		merchandise -
			discount +
			(exclusions.include_shipping ? num(amounts.shipping) : 0) +
			(exclusions.include_tax ? num(amounts.tax) : 0),
	);
	return {
		id: order.orderId,
		number: order.number ?? null,
		currency: order.currency ?? null,
		total: num(amounts.total),
		subtotal: num(amounts.subtotal),
		discount: num(amounts.discount),
		shipping: num(amounts.shipping),
		tax: num(amounts.tax),
		units: lines.reduce((sum, line) => sum + Math.max(0, num(line.quantity)), 0),
		eligibleAmount: Math.floor(eligibleAmount),
		eligibleUnits: eligibleLines.reduce((sum, line) => sum + Math.max(0, num(line.quantity)), 0),
		lines: lines.map((line) => ({ ...line, total: lineTotal(line), excluded: excluded(line) })),
	};
};

/**
 * Read a dotted path from a plain object (own properties only; anything missing → null).
 * @param {unknown} root
 * @param {string} path
 * @returns {unknown}
 */
export const readPath = (root, path) => {
	let value = root;
	for (const part of path.split('.')) {
		if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return null;
		value = /** @type {Record<string, unknown>} */ (value)[part];
	}
	return value;
};

/**
 * Round points.
 * @param {number} value
 * @param {Rounding} rounding
 */
export const roundPoints = (value, rounding) => {
	const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
	// tolerate binary float noise (0.1 + 0.2) before flooring/ceiling
	const nudged = Math.round(safe * 1e9) / 1e9;
	if (rounding === 'ceil') return Math.ceil(nudged);
	if (rounding === 'round') return Math.round(nudged);
	return Math.floor(nudged);
};

/**
 * Raw points of a formula (before multiplier and rounding).
 * @param {EarnRule['formula']} formula
 * @param {Record<string, unknown>} context
 * @returns {number}
 */
export const formulaPoints = (formula, context) => {
	if (formula.kind === 'fixed') return Math.max(0, num(formula.points));
	if (formula.kind === 'percent') {
		const amount = num(readPath(context, formula.field || 'order.eligibleAmount'));
		return amount > 0 ? (amount * Math.max(0, num(formula.percent))) / 100 : 0;
	}
	const units = Math.floor(num(readPath(context, formula.field || 'order.eligibleUnits')));
	const per = Math.max(1, Math.floor(num(formula.per) || 1));
	return units > 0 ? Math.floor(units / per) * Math.max(0, num(formula.points)) : 0;
};

/**
 * True when a trigger (`type@v` or version-less `type`) matches an event type.
 * @param {string} trigger
 * @param {string} type `type@v`
 */
export const triggerMatches = (trigger, type) => (trigger.includes('@') ? trigger === type : trigger === type.split('@')[0]);

/**
 * Apply a per-period cap given what was already earned in the period.
 * @param {number} points
 * @param {{ cap: number, used: number }} period
 */
export const capToPeriod = (points, { cap, used }) => (cap > 0 ? Math.max(0, Math.min(points, cap - used)) : points);

/**
 * Evaluate every rule for one event.
 * @param {{ rules: readonly EarnRule[], type: string, context: Record<string, unknown>, multiplier?: number,
 *   rounding?: Rounding, usage?: RuleUsage, now: number, timeZone: string, maxPoints?: number, orderFactsFor?: (rule: EarnRule) => Record<string, unknown> | null }} input
 * @returns {{ earnings: Earning[], total: number, usage: RuleUsage, diagnostics: Array<{ ruleId: string, error: string }> }}
 */
export const evaluateEarn = ({
	rules,
	type,
	context,
	multiplier = 1,
	rounding = 'floor',
	usage = {},
	now,
	timeZone,
	maxPoints = Number.MAX_SAFE_INTEGER,
	orderFactsFor,
}) => {
	/** @type {Earning[]} */
	const earnings = [];
	/** @type {Array<{ ruleId: string, error: string }>} */
	const diagnostics = [];
	/** @type {RuleUsage} */
	const next = { ...usage };
	let total = 0;
	for (const rule of rules) {
		if (rule.enabled === false || !triggerMatches(rule.trigger, type)) continue;
		const order = orderFactsFor ? orderFactsFor(rule) : null;
		const ruleContext = order ? { ...context, order } : context;
		const { matched, error } = conditionMatches(rule.when, ruleContext, { now, timeZone });
		if (error) diagnostics.push({ ruleId: rule.id, error });
		if (!matched) continue;
		const base = formulaPoints(rule.formula, ruleContext);
		const factor = rule.apply_tier_multiplier === false ? 1 : Math.max(0, multiplier);
		const raw = roundPoints(base * factor, rounding);
		const perEvent = Math.max(0, num(rule.caps?.per_event));
		let points = perEvent > 0 ? Math.min(raw, perEvent) : raw;
		const cap = Math.max(0, num(rule.caps?.per_period));
		const key = periodKey(now, rule.caps?.period ?? 'month', timeZone);
		const used = next[rule.id]?.key === key ? (next[rule.id]?.points ?? 0) : 0;
		points = capToPeriod(points, { cap, used });
		points = Math.min(points, Math.max(0, maxPoints - total));
		if (points <= 0 && raw <= 0) continue;
		next[rule.id] = { key, points: used + points };
		total += points;
		earnings.push({ ruleId: rule.id, base: roundPoints(base, rounding), points, capped: points < raw });
	}
	return { earnings: earnings.filter((earning) => earning.points > 0 || earning.capped), total, usage: next, diagnostics };
};
