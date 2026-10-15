/**
 * Loyalty rules (PLAN 0.8.8 Promotions: earn, redeem, expiry, history; PLAN 0.8.10 E20 options), from the `loyalty`
 * settings: an order earns a percentage of what was paid back as points (`earnPercent`, on the goods — the order total
 * without delivery, fees and tax — or the whole total with `earnBase: total`, worth `pointValue` minor units each),
 * credited on delivery (fixed at placement with `earnAt: placement`); at checkout points are worth `pointValue` each,
 * at least `minRedeem` points are redeemed at once and they pay at most `maxPercent` of the order (the goods after
 * offers) or of the goods' full price (`capBase: goods`); `redeemMode: maximum` redeems the most with one switch.
 * Earned points expire `expiryDays` days (or calendar months in the business time zone, `expiryUnit: months`) after
 * they are earned (0 = never); with `expiryRule: current` the expiry follows today's setting, past points included.
 * Only signed-in shoppers with one of `roles` take part ([] = everyone signed in); guests earn on their contact with
 * `guests: earn` and redeem once signed in. Checkout and orders call these; the ledger moves the points. No I/O.
 * @module
 */
import { zonedDay, zonedDayStart, zonedParts } from '@ss/contracts';
import { roundDown } from './money.js';

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
 * @property {number} expiryDays days (or months) until earned points expire (0 = never)
 * @property {string[]} roles Accounts roles that take part ([] = every signed-in shopper)
 * @property {'none' | 'earn'} guests
 * @property {'goods' | 'total'} earnBase
 * @property {'delivery' | 'placement'} earnAt
 * @property {'order' | 'goods'} capBase
 * @property {'amount' | 'maximum'} redeemMode
 * @property {'days' | 'months'} expiryUnit
 * @property {'at_earn' | 'current'} expiryRule
 * @property {'off' | 'manual' | 'first_order'} memberFlag who is a loyalty member (E47): everyone, or the customers
 *   staff flag, also flagged by their first order
 */

/** The `loyalty` settings' defaults (also in `schemas/loyalty.settings.json`). @type {LoyaltyRules} */
export const LOYALTY_DEFAULTS = Object.freeze({
	earnPercent: 1,
	pointValue: 100,
	minRedeem: 100,
	maxPercent: 20,
	expiryDays: 0,
	roles: /** @type {string[]} */ ([]),
	guests: /** @type {'none'} */ ('none'),
	earnBase: /** @type {'goods'} */ ('goods'),
	earnAt: /** @type {'delivery'} */ ('delivery'),
	capBase: /** @type {'order'} */ ('order'),
	redeemMode: /** @type {'amount'} */ ('amount'),
	expiryUnit: /** @type {'days'} */ ('days'),
	expiryRule: /** @type {'at_earn'} */ ('at_earn'),
	memberFlag: /** @type {'off'} */ ('off'),
});

/**
 * @template {string} T
 * @param {unknown} value @param {ReadonlyArray<T>} allowed @param {T} fallback
 * @returns {T}
 */
const oneOf = (value, allowed, fallback) => (allowed.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback);

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
		roles: Array.isArray(s.roles) ? s.roles.filter((role) => typeof role === 'string' && role !== '') : [],
		guests: oneOf(s.guests, /** @type {const} */ (['none', 'earn']), 'none'),
		earnBase: oneOf(s.earnBase, /** @type {const} */ (['goods', 'total']), 'goods'),
		earnAt: oneOf(s.earnAt, /** @type {const} */ (['delivery', 'placement']), 'delivery'),
		capBase: oneOf(s.capBase, /** @type {const} */ (['order', 'goods']), 'order'),
		redeemMode: oneOf(s.redeemMode, /** @type {const} */ (['amount', 'maximum']), 'amount'),
		expiryUnit: oneOf(s.expiryUnit, /** @type {const} */ (['days', 'months']), 'days'),
		expiryRule: oneOf(s.expiryRule, /** @type {const} */ (['at_earn', 'current']), 'at_earn'),
		memberFlag: oneOf(s.memberFlag, /** @type {const} */ (['off', 'manual', 'first_order']), 'off'),
	};
};

/**
 * Whether a customer is a loyalty member (E47): everyone while the settings' `memberFlag` is off, else only a customer
 * whose record is flagged (by staff, or by their first order with `first_order`). Only members see and redeem points.
 * @param {Record<string, any> | null | undefined} settings the `loyalty` settings
 * @param {{ loyaltyMember?: boolean } | null | undefined} customer their customer record (none yet: not flagged)
 */
export const isLoyaltyMember = (settings, customer) =>
	loyaltyRules(settings).memberFlag === 'off' || customer?.loyaltyMember === true;

/**
 * Whether an order placed now earns for its customer (E47): a member, or anyone with `memberFlag: first_order` (the
 * order flags them).
 * @param {Record<string, any> | null | undefined} settings the `loyalty` settings
 * @param {{ loyaltyMember?: boolean } | null | undefined} customer
 */
export const earnsAsMember = (settings, customer) =>
	isLoyaltyMember(settings, customer) || loyaltyRules(settings).memberFlag === 'first_order';

/**
 * Whether a signed-in shopper takes part (E20 `roles`): every signed-in shopper while no role is listed.
 * @param {Record<string, any>} settings
 * @param {string | undefined} role the shopper's Accounts role
 */
export const takesPart = (settings, role) => {
	const { roles } = loyaltyRules(settings);
	return roles.length === 0 || (typeof role === 'string' && roles.includes(role));
};

/**
 * Points an order earns: `earnPercent` of the goods paid (the total without delivery, fees and tax, after discounts and
 * points) or of the whole total (`earnBase: total`), in points of `pointValue`, rounded down.
 * @param {{ total: number, delivery: number, tax: number, fee?: number }} totals minor units
 * @param {Record<string, any>} settings the `loyalty` settings
 * @returns {number}
 */
export const pointsToEarn = (totals, settings) => {
	const rules = loyaltyRules(settings);
	const base = Math.max(
		0,
		rules.earnBase === 'total' ? totals.total : totals.total - totals.delivery - totals.tax - (totals.fee ?? 0),
	);
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
 * The points a shopper redeems: with `redeemMode: maximum` any request redeems the most allowed (one switch), else
 * the points asked, at most the most allowed; fewer than the least redeemable at once give none. With whole units,
 * points whose value would not be whole are left (E25).
 * @param {number} asked the points sent with the cart
 * @param {number} max the most allowed (`maxRedeemable`)
 * @param {Record<string, any>} settings
 * @param {number} [unit] whole units (E25)
 */
export const pointsToRedeem = (asked, max, settings, unit = 1) => {
	const rules = loyaltyRules(settings);
	let points = asked > 0 ? (rules.redeemMode === 'maximum' ? max : Math.min(asked, max)) : 0;
	if (unit > 1) points = Math.floor(roundDown(points * rules.pointValue, unit) / rules.pointValue);
	return points >= rules.minRedeem ? points : 0;
};

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
 * When points earned at `earnedAt` expire (null = never): `expiryDays` days later, or as many calendar months later at
 * the same time of day in the business time zone (`expiryUnit: months`, the day kept or the month's last).
 * @param {number} earnedAt epoch ms
 * @param {Record<string, any>} settings
 * @param {string} [timeZone] the business time zone (K8)
 * @returns {Date | null}
 */
export const expiryFor = (earnedAt, settings, timeZone = 'UTC') => {
	const { expiryDays, expiryUnit } = loyaltyRules(settings);
	if (expiryDays <= 0) return null;
	if (expiryUnit === 'days') return new Date(earnedAt + expiryDays * DAY_MS);
	const { year, month, day } = zonedParts(earnedAt, timeZone);
	const into = earnedAt - zonedDayStart(zonedDay(earnedAt, timeZone), timeZone);
	const months = month - 1 + expiryDays;
	const targetYear = year + Math.floor(months / 12);
	const targetMonth = (months % 12) + 1;
	const last = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
	const target = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
	return new Date(zonedDayStart(target, timeZone) + into);
};

/**
 * The lots of an account with their expiry by today's setting (`expiryRule: current`, E20): every earned lot expires
 * when today's rule says counting from when it was earned; given-back (`refund`) lots keep theirs.
 * @param {import('./model.js').LoyaltyRecord['lots']} lots
 * @param {Record<string, any>} settings
 * @param {string} [timeZone]
 */
export const lotsByRule = (lots, settings, timeZone = 'UTC') =>
	loyaltyRules(settings).expiryRule === 'current'
		? lots.map((lot) =>
				/** @type {any} */ (lot).kind === 'refund'
					? lot
					: { ...lot, expiresAt: expiryFor(new Date(lot.earnedAt).getTime(), settings, timeZone) },
			)
		: lots;

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
