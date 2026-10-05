import { periodBounds } from './quotas.js';
import { HOUR_MS, ceilHour, floorHour, isoHour, isoInstant, toMs, toMsOr } from './time.js';
import { assertMillicredits, chargeFor, normaliseRate } from './units.js';

/**
 * Hourly settlement math (pure). Produces the ledger entries a settlement job must write; the job
 * writes them with `periodKey` as a unique key, so re-running any range is idempotent.
 *
 * Semantics (normative, see README.md):
 * - Buckets are UTC hours `[h, h+1h)`. A bucket is **billable** when the subscription has at least one
 *   *active* instant in it (inside `[startedAt, endedAt)` and not covered by a pause). Billable buckets
 *   are charged in full ("started hour").
 * - The **sample instant** of a billable bucket is its first active instant. Element states and the
 *   pinned price book are read at the sample instant; changes after it apply from the next bucket.
 * - Buckets with no active instant are **skipped** (never billed) with the reason of the pause
 *   covering the bucket's first in-life instant.
 * - Only complete buckets (`bucketEnd ≤ to`) are settled; the cursor is the start of the first
 *   unsettled bucket.
 */

/** @typedef {import('./time.js').Instant} Instant */
/** @typedef {import('./catalog.js').PriceBook} PriceBook */
/** @typedef {import('./units.js').Rate} Rate */

/**
 * @typedef {object} TimelineEvent
 * @property {Instant} at
 * @property {string} element
 * @property {boolean} enabled Effective billable state from this instant on.
 */

/**
 * @typedef {object} Pause
 * @property {Instant} from
 * @property {Instant | null} [to] `null`/absent = still paused.
 * @property {string} reason `suspended` | `spend_cap` | `balance` | `paused` | …
 */

/**
 * @typedef {object} SettlementSubscription
 * @property {string} id
 * @property {Instant} startedAt
 * @property {Instant | null} [endedAt]
 * @property {string} [priceBookVersion] Version pinned from `startedAt` (shorthand for one pin).
 * @property {readonly { version: string, at: Instant }[]} [pins] Accepted price-book versions over time.
 */

/**
 * @typedef {object} BreakdownLine
 * @property {'base' | 'element'} kind
 * @property {string} [element]
 * @property {number} amount Millicredits.
 */

/**
 * @typedef {object} Bucket
 * @property {string} periodKey `${subscriptionId}:${bucketStart}`
 * @property {string} subscriptionId
 * @property {string} bucketStart `YYYY-MM-DDTHH:00:00Z`
 * @property {string} bucketEnd
 * @property {string} sampledAt First active instant in the bucket.
 * @property {string} priceBookVersion
 * @property {number} amount Millicredits (base + Σ enabled element hourly prices).
 * @property {BreakdownLine[]} breakdown
 */

/**
 * @typedef {object} SkippedBucket
 * @property {string} periodKey
 * @property {string} bucketStart
 * @property {string} reason Pause reason, or `unpriced` when no price book applies.
 */

/** Deterministic priority when several pauses cover the same instant. */
const PAUSE_PRIORITY = ['suspended', 'spend_cap', 'balance', 'paused'];

/**
 * @param {string} reason
 * @param {string} message
 * @returns {Error & { code: string }}
 */
const settlementError = (reason, message) => Object.assign(new Error(message), { code: `settlement/${reason}` });

/**
 * @param {PriceBook | readonly PriceBook[] | { priceBooks: readonly PriceBook[] }} priceBook
 * @returns {readonly PriceBook[]}
 */
const booksOf = (priceBook) => {
	if (Array.isArray(priceBook)) return priceBook;
	const record = /** @type {PriceBook | { priceBooks: readonly PriceBook[] }} */ (priceBook);
	return 'priceBooks' in record ? record.priceBooks : [record];
};

/**
 * Builds `instant → price book` for a subscription. A pin applies from `max(pin.at, book.effectiveFrom)`.
 * Without pins, the latest book effective at the instant applies.
 * @param {SettlementSubscription} subscription
 * @param {readonly PriceBook[]} books
 * @returns {(at: number) => PriceBook | null}
 */
export const priceBookResolver = (subscription, books) => {
	const pins =
		subscription.pins ??
		(subscription.priceBookVersion ? [{ version: subscription.priceBookVersion, at: subscription.startedAt }] : null);
	if (!pins) {
		const sorted = [...books].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
		return (at) => sorted.filter((book) => book.effectiveFrom <= at).at(-1) ?? null;
	}
	const schedule = pins
		.map((pin) => {
			const book = books.find((b) => b.version === pin.version);
			if (!book) throw settlementError('unknown_price_book', `pinned price book ${pin.version} is not available`);
			return { from: Math.max(toMs(pin.at, 'pin.at'), book.effectiveFrom), pinnedAt: toMs(pin.at, 'pin.at'), book };
		})
		.sort((a, b) => a.pinnedAt - b.pinnedAt || a.from - b.from);
	return (at) => {
		/** @type {PriceBook | null} */
		let current = null;
		for (const entry of schedule) if (entry.from <= at) current = entry.book;
		return current;
	};
};

/**
 * Hourly amount for a set of enabled elements under a price book.
 * @param {{ priceBook: PriceBook, elements: readonly string[] }} input
 * @returns {{ amount: number, breakdown: BreakdownLine[] }}
 */
export const hourlyCharge = ({ priceBook, elements }) => {
	/** @type {BreakdownLine[]} */
	const breakdown = [{ kind: 'base', amount: priceBook.baseHourly }];
	for (const element of [...new Set(elements)].sort()) {
		const price = priceBook.elements[element];
		if (price === undefined)
			throw settlementError('unknown_element', `price book ${priceBook.version} has no price for ${element}`);
		breakdown.push({ kind: 'element', element, amount: price });
	}
	return { amount: breakdown.reduce((sum, line) => sum + line.amount, 0), breakdown };
};

/**
 * Burn rate (millicredits per hour) for the given enabled elements.
 * @param {{ priceBook: PriceBook, elements: readonly string[] }} input
 * @returns {number}
 */
export const burnRate = (input) => hourlyCharge(input).amount;

/**
 * Plans the hourly ledger entries for `[from, to)`.
 * @param {object} input
 * @param {SettlementSubscription} input.subscription
 * @param {PriceBook | readonly PriceBook[] | { priceBooks: readonly PriceBook[] }} input.priceBook A book, a list, or a normalised product.
 * @param {readonly TimelineEvent[]} [input.elementTimeline]
 * @param {readonly Pause[]} [input.pauses]
 * @param {Instant} input.from Cursor: start of the first unsettled bucket (rounded up to the hour).
 * @param {Instant} input.to Settle buckets that end at or before this instant.
 * @returns {{ buckets: Bucket[], skipped: SkippedBucket[], cursor: string, total: number }}
 */
export const planSettlement = ({ subscription, priceBook, elementTimeline = [], pauses = [], from, to }) => {
	const startedAt = toMs(subscription.startedAt, 'startedAt');
	const endedAt = toMsOr(subscription.endedAt, Number.POSITIVE_INFINITY, 'endedAt');
	const fromMs = ceilHour(toMs(from, 'from'));
	const toMsValue = toMs(to, 'to');
	const bookAt = priceBookResolver(subscription, booksOf(priceBook));
	const timeline = [...elementTimeline]
		.map((e) => ({ at: toMs(e.at, 'timeline.at'), element: e.element, enabled: e.enabled === true }))
		// Ties at the same instant: `enabled: true` first, so a simultaneous disable wins.
		.sort(
			(a, b) =>
				a.at - b.at || (a.element < b.element ? -1 : a.element > b.element ? 1 : 0) || Number(b.enabled) - Number(a.enabled),
		);
	const normalisedPauses = pauses
		.map((p) => ({
			from: toMs(p.from, 'pause.from'),
			to: toMsOr(p.to, Number.POSITIVE_INFINITY, 'pause.to'),
			reason: p.reason,
		}))
		.filter((p) => p.to > p.from)
		.sort((a, b) => a.from - b.from || a.to - b.to);

	/** @type {Bucket[]} */
	const buckets = [];
	/** @type {SkippedBucket[]} */
	const skipped = [];
	/** @type {Map<string, boolean>} */
	const state = new Map();
	let cursorIndex = 0;
	const firstBucket = Math.max(fromMs, floorHour(startedAt));
	const lastEnd = Math.min(floorHour(toMsValue), ceilHour(endedAt === Number.POSITIVE_INFINITY ? toMsValue : endedAt));
	for (let start = firstBucket; start + HOUR_MS <= lastEnd; start += HOUR_MS) {
		const end = start + HOUR_MS;
		const inLifeStart = Math.max(start, startedAt);
		const inLifeEnd = Math.min(end, endedAt);
		if (inLifeStart >= inLifeEnd) continue;
		const sample = firstActiveInstant(inLifeStart, normalisedPauses);
		const periodKey = `${subscription.id}:${isoHour(start)}`;
		if (sample >= inLifeEnd) {
			skipped.push({ periodKey, bucketStart: isoHour(start), reason: pauseReasonAt(inLifeStart, normalisedPauses) });
			continue;
		}
		for (
			;
			cursorIndex < timeline.length && /** @type {{ at: number }} */ (timeline[cursorIndex]).at <= sample;
			cursorIndex += 1
		) {
			const event = /** @type {{ element: string, enabled: boolean }} */ (timeline[cursorIndex]);
			state.set(event.element, event.enabled);
		}
		const book = bookAt(sample);
		if (!book) {
			skipped.push({ periodKey, bucketStart: isoHour(start), reason: 'unpriced' });
			continue;
		}
		const enabled = [...state.entries()].filter(([, on]) => on).map(([element]) => element);
		const { amount, breakdown } = hourlyCharge({ priceBook: book, elements: enabled });
		buckets.push({
			periodKey,
			subscriptionId: subscription.id,
			bucketStart: isoHour(start),
			bucketEnd: isoHour(end),
			sampledAt: isoInstant(sample),
			priceBookVersion: book.version,
			amount,
			breakdown,
		});
	}
	return {
		buckets,
		skipped,
		cursor: nextCursor({ cursor: fromMs, to: toMsValue }),
		total: buckets.reduce((sum, b) => sum + b.amount, 0),
	};
};

/**
 * First instant ≥ `t` not covered by any pause (pauses sorted by `from`).
 * @param {number} t
 * @param {readonly { from: number, to: number }[]} pauses
 * @returns {number}
 */
const firstActiveInstant = (t, pauses) => {
	let current = t;
	for (const pause of pauses) {
		if (pause.from > current) break;
		if (pause.to > current) current = pause.to;
	}
	return current;
};

/**
 * Highest-priority reason among pauses covering `t`.
 * @param {number} t
 * @param {readonly { from: number, to: number, reason: string }[]} pauses
 * @returns {string}
 */
const pauseReasonAt = (t, pauses) => {
	const reasons = pauses.filter((p) => p.from <= t && t < p.to).map((p) => p.reason);
	const rank = (/** @type {string} */ r) => {
		const i = PAUSE_PRIORITY.indexOf(r);
		return i === -1 ? PAUSE_PRIORITY.length : i;
	};
	return [...reasons].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? 'paused';
};

/**
 * Next settlement cursor: never moves backwards, always hour-aligned.
 * @param {{ cursor: Instant, to: Instant }} input
 * @returns {string}
 */
export const nextCursor = ({ cursor, to }) => isoHour(Math.max(ceilHour(toMs(cursor, 'cursor')), floorHour(toMs(to, 'to'))));

/**
 * @typedef {object} MeteredLine
 * @property {string} unit
 * @property {number} quantity Units used in this bucket.
 * @property {number} billableQuantity Units above the included allowance.
 * @property {number} amount Millicredits.
 */

/**
 * Metered overage for one bucket. `usageByUnit[unit]` is either the bucket's quantity or
 * `{ before, delta }` where `before` is the period-to-date usage prior to this bucket. Charges are
 * computed on cumulative usage (`charge(before + delta) − charge(before)`), so Σ over a period equals
 * the charge of the period total.
 * @param {object} input
 * @param {Readonly<Record<string, number | { before?: number, delta: number }>>} input.usageByUnit
 * @param {Readonly<Record<string, number | null>>} [input.included] Included units per period (`null` = unlimited).
 * @param {Readonly<Record<string, Rate | number>>} input.overageRate
 * @param {{ subscriptionId: string, bucketStart: Instant }} input.bucket
 * @returns {{ periodKey: string, bucketStart: string, lines: MeteredLine[], amount: number }}
 */
export const planMeteredSettlement = ({ usageByUnit, included = {}, overageRate, bucket }) => {
	const start = toMs(bucket.bucketStart, 'bucketStart');
	if (start % HOUR_MS !== 0) throw settlementError('unaligned_bucket', 'bucketStart must be hour-aligned');
	/** @type {MeteredLine[]} */
	const lines = [];
	for (const unit of Object.keys(usageByUnit).sort()) {
		const usage = /** @type {number | { before?: number, delta: number }} */ (usageByUnit[unit]);
		const before = typeof usage === 'number' ? 0 : (usage.before ?? 0);
		const delta = typeof usage === 'number' ? usage : usage.delta;
		for (const n of [before, delta]) {
			if (!Number.isSafeInteger(n) || n < 0) throw settlementError('invalid_usage', `usage for ${unit} must be integers ≥ 0`);
		}
		const allowance = included[unit] === undefined ? 0 : included[unit];
		const rawRate = overageRate[unit];
		if (rawRate === undefined && allowance !== null) throw settlementError('unknown_unit', `no overage rate for ${unit}`);
		const over = (/** @type {number} */ used) => (allowance === null ? 0 : Math.max(0, used - allowance));
		const billableQuantity = over(before + delta) - over(before);
		const rate = rawRate === undefined ? { millicredits: 0, per: 1 } : normaliseRate(rawRate);
		const amount = chargeFor(over(before + delta), rate) - chargeFor(over(before), rate);
		lines.push({ unit, quantity: delta, billableQuantity, amount });
	}
	return {
		periodKey: `${bucket.subscriptionId}:${isoHour(start)}:metered`,
		bucketStart: isoHour(start),
		lines,
		amount: lines.reduce((sum, line) => sum + line.amount, 0),
	};
};

/**
 * @typedef {string | { periodKey: string, amount?: number }} KeyLike
 */

/**
 * Compares expected buckets with what the ledger holds.
 * - `missing`: expected but not in the ledger.
 * - `duplicates`: ledger keys present more than once.
 * - `extra`: ledger keys not expected.
 * - `mismatched`: keys whose amounts differ (only when both sides carry `amount`).
 * @param {{ expectedBuckets: readonly KeyLike[], ledgerKeys: readonly KeyLike[] }} input
 * @returns {{ missing: string[], duplicates: string[], extra: string[], mismatched: { periodKey: string, expected: number, actual: number }[] }}
 */
export const reconcile = ({ expectedBuckets, ledgerKeys }) => {
	/** @param {KeyLike} k */
	const keyOf = (k) => (typeof k === 'string' ? k : k.periodKey);
	/** @type {Map<string, number | undefined>} */
	const expected = new Map(expectedBuckets.map((b) => [keyOf(b), typeof b === 'string' ? undefined : b.amount]));
	/** @type {Map<string, number>} */
	const counts = new Map();
	/** @type {Map<string, number>} */
	const amounts = new Map();
	for (const entry of ledgerKeys) {
		const key = keyOf(entry);
		counts.set(key, (counts.get(key) ?? 0) + 1);
		if (typeof entry !== 'string' && entry.amount !== undefined && !amounts.has(key)) amounts.set(key, entry.amount);
	}
	const mismatched = [...expected.entries()]
		.filter(([key, amount]) => amount !== undefined && amounts.has(key) && amounts.get(key) !== amount)
		.map(([periodKey, amount]) => ({
			periodKey,
			expected: /** @type {number} */ (amount),
			actual: /** @type {number} */ (amounts.get(periodKey)),
		}))
		.sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));
	return {
		missing: [...expected.keys()].filter((key) => !counts.has(key)).sort(),
		duplicates: [...counts.entries()]
			.filter(([, n]) => n > 1)
			.map(([key]) => key)
			.sort(),
		extra: [...counts.keys()].filter((key) => !expected.has(key)).sort(),
		mismatched,
	};
};

/**
 * Balance after applying charges (subtracted) and credits (added). All integer millicredits.
 * @param {{ balance: number, charges?: readonly (number | { amount: number })[], credits?: readonly (number | { amount: number })[] }} input
 * @returns {number}
 */
export const balanceAfter = ({ balance, charges = [], credits = [] }) => {
	if (!Number.isSafeInteger(balance)) throw new RangeError('balance must be an integer (millicredits)');
	/** @param {number | { amount: number }} x */
	const amountOf = (x) => assertMillicredits(typeof x === 'number' ? x : x.amount);
	/** @param {readonly (number | { amount: number })[]} list */
	const sum = (list) => list.map(amountOf).reduce((s, n) => s + n, 0);
	return balance - sum(charges) + sum(credits);
};

/**
 * Whole hours the balance covers at the burn rate (`null` = unlimited because nothing burns).
 * @param {{ balance: number, burnRatePerHour: number }} input
 * @returns {number | null}
 */
export const hoursRemaining = ({ balance, burnRatePerHour }) => {
	assertMillicredits(burnRatePerHour, 'burnRatePerHour');
	if (balance <= 0) return 0;
	if (burnRatePerHour === 0) return null;
	return Math.floor(balance / burnRatePerHour);
};

/**
 * Projection for the calendar month containing `now` (in `timeZone`). Assumes `monthToDate` covers
 * every bucket that started before the current UTC hour; the current and remaining hours are
 * projected at `burnRatePerHour`.
 * @param {{ monthToDate: number, burnRatePerHour: number, now: Instant, timeZone?: string }} input
 * @returns {{ monthToDate: number, remainingHours: number, projectedRemaining: number, projectedTotal: number, periodStart: string, periodEnd: string }}
 */
export const projectedMonth = ({ monthToDate, burnRatePerHour, now, timeZone = 'UTC' }) => {
	assertMillicredits(monthToDate, 'monthToDate');
	assertMillicredits(burnRatePerHour, 'burnRatePerHour');
	const nowMs = toMs(now, 'now');
	const period = periodBounds({ unit: 'month', timeZone, at: nowMs });
	const remainingHours = Math.ceil((period.end - floorHour(nowMs)) / HOUR_MS);
	const projectedRemaining = remainingHours * burnRatePerHour;
	return {
		monthToDate,
		remainingHours,
		projectedRemaining,
		projectedTotal: monthToDate + projectedRemaining,
		periodStart: isoInstant(period.start),
		periodEnd: isoInstant(period.end),
	};
};
