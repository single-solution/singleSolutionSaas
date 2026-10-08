/**
 * Loyalty rules (PLAN 0.8.8 Promotions: earn, redeem, expiry, history), from the `loyalty` settings and ported from
 * ibrahimMobiles (`packages/shared/src/loyalty.ts`): an order earns a percentage of what was paid for the goods back
 * as points (`earnPercent`, on the order total without delivery and tax, worth `pointValue` minor units each); at
 * checkout points are worth `pointValue` each, at least `minRedeem` points are redeemed at once and they pay at most
 * `maxPercent` of the order; earned points expire `expiryDays` after they are earned (0 = never). Checkout and orders
 * call these; the ledger moves the points. No I/O.
 * @module
 */

/** @typedef {import('./model.js').LoyaltyRecord} LoyaltyRecord */

/** Days before expiry when points count as expiring soon (the shopper's loyalty view). */
const EXPIRING_SOON_DAYS = 30;
/** Most history entries shown to the shopper (newest first). */
export const SHOPPER_HISTORY = 50;

const DAY_MS = 86_400_000;

/**
 * @typedef {object} LoyaltyRules
 * @property {number} earnPercent percent of the paid goods total given back as points' value (0–100)
 * @property {number} pointValue what one point is worth, minor units (≥ 1)
 * @property {number} minRedeem fewest points redeemed at once
 * @property {number} maxPercent largest share of an order paid with points (0–100)
 * @property {number} expiryDays days until earned points expire (0 = never)
 */

/** The `loyalty` settings' defaults (also in `schemas/loyalty.settings.json`). @type {LoyaltyRules} */
export const LOYALTY_DEFAULTS = Object.freeze({ earnPercent: 1, pointValue: 100, minRedeem: 100, maxPercent: 20, expiryDays: 0 });

/**
 * @param {unknown} value @param {number} fallback @param {number} min @param {number} max
 */
const numberIn = (value, fallback, min, max) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/**
 * The rules from the settings (missing or broken values fall back to the defaults; numbers are clamped).
 * @param {Record<string, any> | null | undefined} settings
 * @returns {LoyaltyRules}
 */
export const loyaltyRules = (settings) => {
	const s = settings ?? {};
	return {
		earnPercent: numberIn(s.earnPercent, LOYALTY_DEFAULTS.earnPercent, 0, 100),
		pointValue: Math.floor(numberIn(s.pointValue, LOYALTY_DEFAULTS.pointValue, 1, 1_000_000_000)),
		minRedeem: Math.floor(numberIn(s.minRedeem, LOYALTY_DEFAULTS.minRedeem, 1, 1_000_000_000)),
		maxPercent: numberIn(s.maxPercent, LOYALTY_DEFAULTS.maxPercent, 0, 100),
		expiryDays: Math.floor(numberIn(s.expiryDays, LOYALTY_DEFAULTS.expiryDays, 0, 36_500)),
	};
};

/**
 * Points an order earns when it is delivered: `earnPercent` of the goods paid (total without delivery and tax, after
 * discounts and points), in points of `pointValue`, rounded down.
 * @param {{ total: number, delivery: number, tax: number }} totals minor units
 * @param {Record<string, any>} settings the `loyalty` settings
 * @returns {number}
 */
export const pointsToEarn = (totals, settings) => {
	const rules = loyaltyRules(settings);
	const base = Math.max(0, totals.total - totals.delivery - totals.tax);
	return Math.max(0, Math.floor((base * rules.earnPercent) / (100 * rules.pointValue) + 1e-9));
};

/**
 * What `points` take off at checkout, in minor units.
 * @param {number} points
 * @param {Record<string, any>} settings
 * @returns {number}
 */
export const pointsValue = (points, settings) =>
	Number.isFinite(points) && points > 0 ? Math.floor(points) * loyaltyRules(settings).pointValue : 0;

/**
 * The most points a shopper may redeem on an order: the balance, at most `maxPercent` of the order in value, and 0
 * when that is fewer than `minRedeem`.
 * @param {{ balance: number, payable: number }} input `payable`: the order total before points, minor units
 * @param {Record<string, any>} settings
 * @returns {number}
 */
export const maxRedeemable = ({ balance, payable }, settings) => {
	const rules = loyaltyRules(settings);
	const cap = Math.floor((Math.max(0, payable) * rules.maxPercent) / 100 + 1e-9);
	const points = Math.min(Math.max(0, Math.floor(balance)), Math.floor(cap / rules.pointValue));
	return points >= rules.minRedeem ? points : 0;
};

/**
 * When points earned now expire (null = never).
 * @param {number} now epoch ms
 * @param {Record<string, any>} settings
 * @returns {Date | null}
 */
export const expiryFor = (now, settings) => {
	const { expiryDays } = loyaltyRules(settings);
	return expiryDays > 0 ? new Date(now + expiryDays * DAY_MS) : null;
};

/**
 * Points that expire within {@link EXPIRING_SOON_DAYS}, grouped by expiry, soonest first.
 * @param {LoyaltyRecord['lots']} lots
 * @param {number} now
 * @returns {Array<{ points: number, expiresAt: string }>}
 */
export const expiringSoon = (lots, now) => {
	/** @type {Map<number, number>} */
	const byTime = new Map();
	for (const lot of lots) {
		if (lot.left <= 0 || lot.expiresAt === null) continue;
		const at = new Date(lot.expiresAt).getTime();
		if (at <= now || at > now + EXPIRING_SOON_DAYS * DAY_MS) continue;
		byTime.set(at, (byTime.get(at) ?? 0) + lot.left);
	}
	return [...byTime.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([at, points]) => ({ points, expiresAt: new Date(at).toISOString() }));
};

/**
 * History entries for the wire, newest first.
 * @param {LoyaltyRecord['history']} history
 * @param {number} [limit]
 */
export const historyView = (history, limit = history.length) =>
	[...history]
		.reverse()
		.slice(0, limit)
		.map((entry) => ({
			at: new Date(entry.at).toISOString(),
			kind: entry.kind,
			points: entry.points,
			orderId: entry.orderId,
			note: entry.note,
		}));
