/**
 * FIFO lot maths of a member's points (pure). Ported from ibrahimMobiles `loyaltyExpiry.ts` and extended:
 *
 * - Every credit opens a dated **lot** (`earnedAt`); debits consume the oldest lots first (FIFO), or the lots a
 *   reversal names first (`prefer`), then FIFO. A lot's expiry is derived from `earnedAt` and the current policy
 *   (`months`, `graceDays`) exactly like ibrahimMobiles derives it from the live store setting, so changing the policy
 *   applies to every lot consistently.
 * - A debit that finds no points left becomes **debt** when negative balances are allowed; later credits repay debt
 *   before they open a lot (ibrahimMobiles' "orphan debit" rule), so `balance = Σ remaining − debt`.
 * - A lot expires once `expiresAt ≤ now`. Expiry consumes exactly the expired lots, so a second run finds nothing
 *   (idempotent), and the amount is naturally capped at the balance.
 * - Redeemed points that come back (release at checkout, refund of a cancelled order) are **restored into their
 *   original lots** with their original expiry — unlike ibrahimMobiles, where they started a fresh lot — so a
 *   redeem-and-release cannot extend the life of points.
 * - `replayLedger` rebuilds the lot state from a ledger of signed entries (the ibrahimMobiles model), which is how the
 *   ported test cases and data rebuilds use it.
 * @module
 */
import { DAY_MS, addMonths, dayKey, iso, toMs } from './time.js';

/**
 * @typedef {object} Lot
 * @property {string} id
 * @property {number} points credited
 * @property {number} remaining
 * @property {string} earnedAt ISO
 * @property {string | null} [noticeFor] expiry day a notice was published for
 */
/** @typedef {{ lots: Lot[], debt: number }} PointState */
/** @typedef {{ lotId: string, points: number, earnedAt: string }} Slice */
/** @typedef {{ months: number, graceDays?: number }} ExpiryPolicy */

/** An empty state. */
export const emptyState = () => /** @type {PointState} */ ({ lots: [], debt: 0 });

/**
 * @param {PointState} state
 * @returns {number}
 */
export const balanceOf = (state) => state.lots.reduce((sum, lot) => sum + lot.remaining, 0) - state.debt;

/** Most days a clamped month addition can shorten a period by (31 → 28). */
const MAX_MONTH_CLAMP_DAYS = 3;

/**
 * Expiry instant of points earned at `at` (null when points never expire).
 * @param {number} at
 * @param {ExpiryPolicy | null | undefined} policy
 * @returns {number | null}
 */
export const expiryOf = (at, policy) => {
	const whole = Math.floor(policy?.months ?? 0);
	if (!(whole > 0)) return null;
	return addMonths(at, whole) + Math.max(0, Math.floor(policy?.graceDays ?? 0)) * DAY_MS;
};

/**
 * Conservative database pre-filter (ibrahimMobiles `loyaltyExpiryScanCutoff`): no lot earned after this instant can
 * have expired at `now`.
 * @param {number} now
 * @param {ExpiryPolicy} policy
 * @returns {number}
 */
export const scanCutoff = (now, policy) =>
	addMonths(now, -Math.floor(policy.months)) -
	Math.max(0, Math.floor(policy.graceDays ?? 0)) * DAY_MS +
	MAX_MONTH_CLAMP_DAYS * DAY_MS;

/** @param {Lot} a @param {Lot} b */
const fifo = (a, b) => (a.earnedAt < b.earnedAt ? -1 : a.earnedAt > b.earnedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Credit points: repay debt first, open a lot with the rest.
 * @param {PointState} state
 * @param {{ id: string, points: number, at: number }} credit
 * @returns {{ state: PointState, lot: Lot | null, repaid: number }}
 */
export const credit = (state, { id, points, at }) => {
	const amount = Math.max(0, Math.floor(points));
	const repaid = Math.min(state.debt, amount);
	const rest = amount - repaid;
	const lot = rest > 0 ? { id, points: rest, remaining: rest, earnedAt: iso(at) } : null;
	return {
		state: { lots: lot ? [...state.lots, lot].sort(fifo) : state.lots, debt: state.debt - repaid },
		lot,
		repaid,
	};
};

/**
 * Debit points: preferred lots first, then the oldest lots. A shortfall becomes debt when `allowNegative`, else the
 * debit is refused (`ok: false`) and the state is unchanged.
 * @param {PointState} state
 * @param {{ points: number, prefer?: readonly string[], allowNegative?: boolean }} debit
 * @returns {{ ok: true, state: PointState, consumed: Slice[], shortfall: number } | { ok: false, reason: 'insufficient_points', available: number }}
 */
export const debit = (state, { points, prefer = [], allowNegative = false }) => {
	let toConsume = Math.max(0, Math.floor(points));
	const available = Math.max(0, balanceOf(state));
	if (toConsume > available && !allowNegative) return { ok: false, reason: 'insufficient_points', available };
	const lots = state.lots.map((lot) => ({ ...lot }));
	const order = [
		...lots.filter((lot) => prefer.includes(lot.id)).sort(fifo),
		...lots.filter((lot) => !prefer.includes(lot.id)).sort(fifo),
	];
	/** @type {Slice[]} */
	const consumed = [];
	for (const lot of order) {
		if (toConsume <= 0) break;
		const taken = Math.min(lot.remaining, toConsume);
		if (taken <= 0) continue;
		lot.remaining -= taken;
		toConsume -= taken;
		consumed.push({ lotId: lot.id, points: taken, earnedAt: lot.earnedAt });
	}
	return {
		ok: true,
		state: { lots: lots.filter((lot) => lot.remaining > 0).sort(fifo), debt: state.debt + toConsume },
		consumed,
		shortfall: toConsume,
	};
};

/**
 * Expire every lot whose expiry has passed.
 * @param {PointState} state
 * @param {number} now
 * @param {ExpiryPolicy | null | undefined} policy
 * @returns {{ state: PointState, expired: number, slices: Slice[], newestEarnedAt: string | null }}
 */
export const expire = (state, now, policy) => {
	/** @type {Slice[]} */
	const slices = [];
	const kept = [];
	for (const lot of state.lots) {
		const expiresAt = expiryOf(toMs(lot.earnedAt), policy);
		if (expiresAt !== null && expiresAt <= now && lot.remaining > 0) {
			slices.push({ lotId: lot.id, points: lot.remaining, earnedAt: lot.earnedAt });
		} else kept.push(lot);
	}
	const expired = slices.reduce((sum, slice) => sum + slice.points, 0);
	return {
		state: { lots: kept, debt: state.debt },
		expired,
		slices,
		newestEarnedAt:
			slices.length > 0
				? (slices
						.map((slice) => slice.earnedAt)
						.sort()
						.at(-1) ?? null)
				: null,
	};
};

/**
 * Put consumed slices back (release / refund of a redemption): debt first, then into their original lots (same id,
 * same dates; merged with a remaining lot of the same id).
 * @param {PointState} state
 * @param {readonly Slice[]} slices
 * @returns {{ state: PointState, restored: number, repaid: number }}
 */
export const restore = (state, slices) => {
	let debt = state.debt;
	let repaid = 0;
	const lots = state.lots.map((lot) => ({ ...lot }));
	let restored = 0;
	for (const slice of slices) {
		const amount = Math.max(0, Math.floor(slice.points));
		const toDebt = Math.min(debt, amount);
		debt -= toDebt;
		repaid += toDebt;
		const rest = amount - toDebt;
		restored += amount;
		if (rest <= 0) continue;
		const existing = lots.find((lot) => lot.id === slice.lotId);
		if (existing) {
			existing.remaining += rest;
			existing.points = Math.max(existing.points, existing.remaining);
		} else lots.push({ id: slice.lotId, points: rest, remaining: rest, earnedAt: slice.earnedAt });
	}
	return { state: { lots: lots.sort(fifo), debt }, restored, repaid };
};

/**
 * The next points to expire after `now` within `windowMs`: every lot expiring on the same local calendar day (website
 * zone) as the earliest upcoming one, summed and capped at what the balance can cover once already-expired (not yet
 * debited) points are taken out. Null when nothing is due.
 * @param {PointState} state
 * @param {{ now: number, windowMs: number, timeZone: string, policy: ExpiryPolicy | null | undefined }} options
 * @returns {{ points: number, expiresAt: string, expiresOn: string, lotIds: string[] } | null}
 */
export const upcomingExpiry = (state, { now, windowMs, timeZone, policy }) => {
	if (!(windowMs > 0)) return null;
	const dated = state.lots.map((lot) => ({ lot, at: expiryOf(toMs(lot.earnedAt), policy) }));
	const overdue = dated.reduce((sum, entry) => sum + (entry.at !== null && entry.at <= now ? entry.lot.remaining : 0), 0);
	const upcoming = dated
		.filter((entry) => entry.at !== null && entry.at > now && entry.at <= now + windowMs)
		.sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at));
	const first = upcoming[0];
	const available = Math.max(0, balanceOf(state) - overdue);
	if (!first || available <= 0) return null;
	const firstAt = /** @type {number} */ (first.at);
	const expiresOn = dayKey(firstAt, timeZone);
	const sameDay = upcoming.filter((entry) => dayKey(/** @type {number} */ (entry.at), timeZone) === expiresOn);
	const points = Math.min(
		sameDay.reduce((sum, entry) => sum + entry.lot.remaining, 0),
		available,
	);
	return points > 0 ? { points, expiresAt: iso(firstAt), expiresOn, lotIds: sameDay.map((entry) => entry.lot.id) } : null;
};

/**
 * Mark lots as notified for an expiry day (one `loyalty.expiring@1` per member and day).
 * @param {PointState} state
 * @param {readonly string[]} lotIds
 * @param {string} expiresOn
 * @returns {PointState}
 */
export const markNoticed = (state, lotIds, expiresOn) => ({
	lots: state.lots.map((lot) => (lotIds.includes(lot.id) ? { ...lot, noticeFor: expiresOn } : lot)),
	debt: state.debt,
});

/** @typedef {{ kind: string, amount: number, occurredAt: string | number | Date, id?: string }} LedgerEntry */

const CREDIT_KINDS = new Set(['earn', 'bonus', 'referral', 'return']);
const DEBIT_KINDS = new Set(['redeem', 'expire', 'reverse']);

/**
 * Effective signed delta of a ledger entry (ibrahimMobiles sign conventions): credits → +|amount|, debits → −|amount|,
 * adjustments (and anything else) → the amount as stored.
 * @param {Pick<LedgerEntry, 'kind' | 'amount'>} entry
 * @returns {number}
 */
export const entryDelta = (entry) => {
	const amount = Number.isFinite(entry.amount) ? entry.amount : 0;
	if (CREDIT_KINDS.has(entry.kind)) return Math.abs(amount);
	if (DEBIT_KINDS.has(entry.kind)) return -Math.abs(amount);
	return amount;
};

/**
 * Rebuild the lot state by replaying a ledger chronologically (ties keep input order).
 * @param {readonly LedgerEntry[]} entries
 * @returns {PointState}
 */
export const replayLedger = (entries) => {
	const ordered = entries
		.map((entry, index) => ({ entry, index, time: Number.isFinite(toMs(entry.occurredAt)) ? toMs(entry.occurredAt) : 0 }))
		.sort((a, b) => a.time - b.time || a.index - b.index);
	let state = emptyState();
	for (const { entry, index, time } of ordered) {
		const delta = entryDelta(entry);
		if (delta > 0) {
			state = credit(state, { id: entry.id ?? `lot_${String(index).padStart(6, '0')}`, points: delta, at: time }).state;
		} else if (delta < 0) {
			const result = debit(state, { points: -delta, allowNegative: true });
			if (result.ok) state = result.state;
		}
	}
	return state;
};

/**
 * Points expired at `now` and still unspent, capped at `balance` (ibrahimMobiles `computeLoyaltyExpiry` over a ledger).
 * @param {readonly LedgerEntry[]} entries
 * @param {ExpiryPolicy} policy
 * @param {number} now
 * @param {number} balance
 * @returns {{ expiredPoints: number, newestExpiredCreditAt: string | null }}
 */
export const ledgerExpiry = (entries, policy, now, balance) => {
	if (!(Math.floor(policy.months) > 0)) return { expiredPoints: 0, newestExpiredCreditAt: null };
	const result = expire(replayLedger(entries), now, policy);
	const cap = Math.max(0, Math.floor(Number.isFinite(balance) ? balance : 0));
	const expiredPoints = Math.max(0, Math.min(result.expired, cap));
	return { expiredPoints, newestExpiredCreditAt: expiredPoints > 0 ? result.newestEarnedAt : null };
};
