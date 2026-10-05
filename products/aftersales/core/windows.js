/**
 * Claim windows and eligibility (pure). Every window is data: days from the purchase's delivery (the first configured
 * window-start event, or the API's `deliveredAt`), chosen per claim type in this order —
 *
 *   1. the first enabled window rule of the type whose rules@1 condition matches (line, purchase, customer);
 *   2. the line's own `warrantyDays` snapshot, when the type uses snapshot days;
 *   3. the grade's days (Grades tiers, from `grades.tier_assigned@1` or the purchase snapshot), when the type uses
 *      grade windows;
 *   4. the type's default `window_days`.
 *
 * 0 days means "not claimable". Quantities already claimed (in claims that were not released by a rejection) and
 * quantities refunded elsewhere are not claimable again.
 * @module
 */
import { conditionMatches } from './rules.js';
import { DAY_MS, iso } from './time.js';

/**
 * @typedef {object} ClaimType
 * @property {string} key
 * @property {string} label
 * @property {number} window_days
 * @property {boolean} [use_grade_windows]
 * @property {boolean} [use_snapshot_days]
 * @property {boolean} [refundable]
 * @property {boolean} [returns_item]
 * @property {number} [min_photos]
 * @property {boolean} [require_serial]
 * @property {number} [details_min_length]
 * @property {boolean} [enabled]
 */

/** @typedef {{ grade: string, type: string, days: number }} GradeWindow */
/** @typedef {{ id: string, type: string, when?: string, days: number, enabled?: boolean }} WindowRule */
/** @typedef {import('./purchases.js').PurchaseLine} PurchaseLine */

/**
 * @typedef {object} WindowInput
 * @property {ClaimType} type
 * @property {PurchaseLine} line
 * @property {string | null} grade the line's grade (snapshot, else Grades tier)
 * @property {Record<string, unknown>} context rules@1 context (line, purchase, customer)
 * @property {GradeWindow[]} gradeWindows
 * @property {WindowRule[]} rules
 * @property {number} now
 * @property {string} timeZone
 */

/**
 * Days of the window of one claim type for one line, and where they came from.
 * @param {WindowInput} input
 * @returns {{ days: number, source: 'rule' | 'snapshot' | 'grade' | 'type', ruleId?: string }}
 */
export const windowDays = ({ type, line, grade, context, gradeWindows, rules, now, timeZone }) => {
	for (const rule of rules) {
		if (rule.type !== type.key || rule.enabled === false) continue;
		if (conditionMatches(rule.when, context, { now, timeZone })) return { days: rule.days, source: 'rule', ruleId: rule.id };
	}
	if (type.use_snapshot_days && line.warrantyDays !== null) return { days: line.warrantyDays, source: 'snapshot' };
	if (type.use_grade_windows && grade) {
		const match = gradeWindows.find((entry) => entry.grade === grade && entry.type === type.key);
		if (match) return { days: match.days, source: 'grade' };
	}
	return { days: type.window_days, source: 'type' };
};

/**
 * @typedef {{ eligible: true, closesAt: string, days: number, source: string }
 *   | { eligible: false, reason: 'not_delivered' | 'no_window' | 'window_closed' | 'cancelled', closesAt?: string, days: number, source: string }} WindowState
 */

/**
 * Whether a window is open now.
 * @param {{ startedAt: number | null, days: number, source: string, now: number, cancelled?: boolean }} input
 * @returns {WindowState}
 */
export const windowState = ({ startedAt, days, source, now, cancelled = false }) => {
	if (cancelled) return { eligible: false, reason: 'cancelled', days, source };
	if (startedAt === null) return { eligible: false, reason: 'not_delivered', days, source };
	if (!(days > 0)) return { eligible: false, reason: 'no_window', days, source };
	const closesAt = startedAt + Math.floor(days) * DAY_MS;
	if (now > closesAt) return { eligible: false, reason: 'window_closed', closesAt: iso(closesAt), days, source };
	return { eligible: true, closesAt: iso(closesAt), days, source };
};

/**
 * The rules@1 context of a line.
 * @param {{ line: PurchaseLine, grade: string | null, itemType: string, purchase: Record<string, any> }} input
 */
export const ruleContext = ({ line, grade, itemType, purchase }) => ({
	line: {
		itemId: line.itemId,
		variantId: line.variantId,
		sku: line.sku,
		title: line.title,
		quantity: line.quantity,
		unitAmount: line.unitAmount,
		itemType,
		grade,
		warrantyDays: line.warrantyDays,
	},
	purchase: {
		id: purchase.id,
		orderId: purchase.orderId ?? null,
		number: purchase.number ?? null,
		currency: purchase.currency ?? null,
		total: purchase.total ?? null,
		source: purchase.source ?? null,
		placedAt: purchase.placedAt ? new Date(purchase.placedAt) : null,
		deliveredAt: purchase.deliveredAt ? new Date(purchase.deliveredAt) : null,
	},
	customer: { customerId: purchase.customer?.customerId ?? null, subject: purchase.customer?.subject ?? null },
});

/**
 * Units of each line already in claims that count (not released by a rejection).
 * @param {Array<{ released?: boolean, lines: Array<{ lineId: string, quantity: number }> }>} claims
 * @returns {Map<string, number>}
 */
export const claimedUnits = (claims) => {
	/** @type {Map<string, number>} */
	const out = new Map();
	for (const claim of claims) {
		if (claim.released) continue;
		for (const line of claim.lines) out.set(line.lineId, (out.get(line.lineId) ?? 0) + line.quantity);
	}
	return out;
};

/**
 * @typedef {object} LineEligibility
 * @property {PurchaseLine} line
 * @property {string} itemType
 * @property {string | null} grade
 * @property {number} claimable units still claimable
 * @property {Record<string, WindowState>} windows per claim type key
 */

/**
 * Eligibility of every line of a purchase for every enabled claim type.
 * @param {{ purchase: Record<string, any>, claims: Parameters<typeof claimedUnits>[0], types: ClaimType[],
 *   gradeOf: (line: PurchaseLine) => string | null, defaultItemType: string, gradeWindows: GradeWindow[], rules: WindowRule[],
 *   now: number, timeZone: string }} input
 * @returns {{ lines: LineEligibility[], canClaim: boolean }}
 */
export const purchaseEligibility = ({
	purchase,
	claims,
	types,
	gradeOf,
	defaultItemType,
	gradeWindows,
	rules,
	now,
	timeZone,
}) => {
	const claimed = claimedUnits(claims);
	const startedAt = typeof purchase.deliveredAt === 'string' ? Date.parse(purchase.deliveredAt) : null;
	const active = types.filter((type) => type.enabled !== false);
	const lines = /** @type {PurchaseLine[]} */ (purchase.lines ?? []).map((line) => {
		const grade = line.grade ?? gradeOf(line);
		const itemType = line.itemType ?? defaultItemType;
		const context = ruleContext({ line, grade, itemType, purchase });
		const claimable = Math.max(0, line.quantity - line.refundedQuantity - (claimed.get(line.lineId) ?? 0));
		/** @type {Record<string, WindowState>} */
		const windows = {};
		for (const type of active) {
			const chosen = windowDays({ type, line, grade, context, gradeWindows, rules, now, timeZone });
			windows[type.key] = windowState({
				startedAt: Number.isNaN(startedAt) ? null : startedAt,
				days: chosen.days,
				source: chosen.source,
				now,
				cancelled: purchase.status === 'cancelled',
			});
		}
		return { line, itemType, grade, claimable, windows };
	});
	return {
		lines,
		canClaim: lines.some((entry) => entry.claimable > 0 && Object.values(entry.windows).some((state) => state.eligible)),
	};
};
