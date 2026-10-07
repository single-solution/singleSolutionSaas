import { DAY_MS, HOUR_MS, toMs } from './time.js';
import { chargeFor, normaliseRate } from './units.js';

/**
 * Quota periods and quota state.
 *
 * Periods are calendar periods in an IANA time zone (default `UTC`), computed with `Intl` only:
 * - `hour`  — from an instant whose local minutes/seconds are 0 to the next such instant; a UTC-offset
 *            change also starts a new period (so a 30-minute DST shift yields a 30-minute period).
 *            The repeated local hour on a DST fall-back is therefore two distinct periods.
 * - `day`   — local midnight to the next local midnight (23 h / 25 h on DST days).
 * - `week`  — ISO week: Monday 00:00 local to the next Monday 00:00 local.
 * - `month` — the 1st 00:00 local to the next 1st 00:00 local.
 * When a local boundary falls in a DST gap (e.g. midnight skipped), the period starts at the first
 * instant after the gap. Periods are half-open `[start, end)`.
 */

/** @typedef {import('./catalog.js').PeriodUnit} PeriodUnit */
/** @typedef {import('./time.js').Instant} Instant */

/**
 * @typedef {object} PeriodBounds
 * @property {PeriodUnit} unit
 * @property {string} timeZone
 * @property {number} start Epoch ms (inclusive).
 * @property {number} end Epoch ms (exclusive).
 * @property {string} key Stable label, e.g. `month:2026-10`, `day:2026-03-08`, `week:2026-09-28`, `hour:2026-11-01T01:00-04:00`.
 */

/** Memoised formatters (observationally pure: same input → same output). */
const formatters = new Map();

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
const formatterFor = (timeZone) => {
	const cached = formatters.get(timeZone);
	if (cached) return cached;
	const created = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric',
	});
	formatters.set(timeZone, created);
	return created;
};

/**
 * Local wall-clock time of `ms` in `timeZone`, encoded as a UTC epoch number
 * (i.e. `Date.UTC(localYear, localMonth, …)`).
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
const wallOf = (ms, timeZone) => {
	/** @type {Record<string, number>} */
	const parts = {};
	for (const part of formatterFor(timeZone).formatToParts(ms)) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	const millis = ((ms % 1000) + 1000) % 1000;
	return (
		Date.UTC(
			parts.year ?? 1970,
			(parts.month ?? 1) - 1,
			parts.day ?? 1,
			parts.hour ?? 0,
			parts.minute ?? 0,
			parts.second ?? 0,
		) + millis
	);
};

/**
 * UTC offset (ms) of `timeZone` at instant `ms`.
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
export const zoneOffset = (ms, timeZone) => wallOf(ms, timeZone) - ms;

/**
 * Earliest instant whose local wall time is `wall`; if `wall` does not exist (DST gap), the first
 * instant after the gap.
 * @param {number} wall Local wall time encoded as UTC epoch ms.
 * @param {string} timeZone
 * @returns {number}
 */
export const wallToInstant = (wall, timeZone) => {
	const before = zoneOffset(wall - DAY_MS, timeZone);
	const after = zoneOffset(wall + DAY_MS, timeZone);
	const exact = [wall - before, wall - after].filter((t) => wallOf(t, timeZone) === wall).sort((a, b) => a - b);
	if (exact[0] !== undefined) return exact[0];
	// Gap: binary search the first instant whose wall time is ≥ `wall`.
	let lo = Math.min(wall - before, wall - after);
	let hi = Math.max(wall - before, wall - after);
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (wallOf(mid, timeZone) >= wall) hi = mid;
		else lo = mid;
	}
	return hi;
};

/**
 * @param {number} n
 * @returns {string}
 */
const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {number} offsetMs
 * @returns {string}
 */
const offsetLabel = (offsetMs) => {
	const sign = offsetMs < 0 ? '-' : '+';
	const minutes = Math.round(Math.abs(offsetMs) / 60_000);
	return `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

/**
 * Smallest instant in `(lo, hi]` whose offset equals `offset` (offset(lo) ≠ offset, offset(hi) = offset).
 * @param {number} lo
 * @param {number} hi
 * @param {number} offset
 * @param {string} timeZone
 * @returns {number}
 */
const firstWithOffset = (lo, hi, offset, timeZone) => {
	let a = lo;
	let b = hi;
	while (b - a > 1) {
		const mid = Math.floor((a + b) / 2);
		if (zoneOffset(mid, timeZone) === offset) b = mid;
		else a = mid;
	}
	return b;
};

/**
 * Smallest instant in `(lo, hi]` whose offset differs from `offset` (offset(lo) = offset, offset(hi) ≠ offset).
 * @param {number} lo
 * @param {number} hi
 * @param {number} offset
 * @param {string} timeZone
 * @returns {number}
 */
const firstChange = (lo, hi, offset, timeZone) => {
	let a = lo;
	let b = hi;
	while (b - a > 1) {
		const mid = Math.floor((a + b) / 2);
		if (zoneOffset(mid, timeZone) !== offset) b = mid;
		else a = mid;
	}
	return b;
};

/**
 * Start of the period containing `ms` (as an instant) plus its local wall start.
 * @param {PeriodUnit} unit
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{ start: number, wall: number }}
 */
const periodStart = (unit, ms, timeZone) => {
	const wall = wallOf(ms, timeZone);
	if (unit === 'hour') {
		const offset = wall - ms;
		const candidate = ms - (((wall % HOUR_MS) + HOUR_MS) % HOUR_MS);
		// An offset change inside the local hour starts a new period at the transition instant.
		const start = zoneOffset(candidate, timeZone) === offset ? candidate : firstWithOffset(candidate, ms, offset, timeZone);
		return { start, wall: start + offset };
	}
	const d = new Date(wall);
	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	const day = d.getUTCDate();
	const startWall =
		unit === 'day'
			? Date.UTC(y, m, day)
			: unit === 'week'
				? Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7))
				: Date.UTC(y, m, 1);
	return { start: wallToInstant(startWall, timeZone), wall: startWall };
};

/**
 * Local wall start of the period following the one that starts at `wall`.
 * @param {PeriodUnit} unit
 * @param {number} wall
 * @returns {number}
 */
const nextWall = (unit, wall) => {
	const d = new Date(wall);
	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	const day = d.getUTCDate();
	return unit === 'day' ? Date.UTC(y, m, day + 1) : unit === 'week' ? Date.UTC(y, m, day + 7) : Date.UTC(y, m + 1, 1);
};

/**
 * Bounds of the quota period containing `at`.
 * @param {{ unit: PeriodUnit, timeZone?: string, at: Instant }} input
 * @returns {PeriodBounds}
 */
export const periodBounds = ({ unit, timeZone = 'UTC', at }) => {
	if (!['hour', 'day', 'week', 'month'].includes(unit)) throw new RangeError(`unknown period unit ${String(unit)}`);
	const ms = toMs(at, 'at');
	const { start, wall } = periodStart(unit, ms, timeZone);
	/** @type {number} */
	let end;
	if (unit === 'hour') {
		const offset = zoneOffset(start, timeZone);
		const topOfNextHour = start - ((((start + offset) % HOUR_MS) + HOUR_MS) % HOUR_MS) + HOUR_MS;
		end =
			zoneOffset(topOfNextHour - 1, timeZone) === offset
				? topOfNextHour
				: firstChange(start, topOfNextHour - 1, offset, timeZone);
	} else {
		end = wallToInstant(nextWall(unit, wall), timeZone);
	}
	const w = new Date(wall);
	const date = `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
	const key =
		unit === 'hour'
			? `hour:${date}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}${offsetLabel(zoneOffset(start, timeZone))}`
			: unit === 'month'
				? `month:${date.slice(0, 7)}`
				: `${unit}:${date}`;
	return { unit, timeZone, start, end, key };
};

/**
 * @typedef {object} UsageCounter
 * @property {Instant} at When the usage happened.
 * @property {number} quantity Non-negative integer.
 */

/**
 * @typedef {object} QuotaFeature
 * @property {number | null} [value] Effective included amount per period (`null` = unlimited).
 * @property {number | null} [included] Alias of `value`.
 * @property {boolean} [hardStop] Default `true`.
 * @property {PeriodUnit | null} [period] Default `month`.
 */

/**
 * @typedef {object} QuotaState
 * @property {number} used
 * @property {number | null} included `null` = unlimited.
 * @property {number | null} remaining `null` = unlimited.
 * @property {number} overage Units above `included` (always 0 when unlimited).
 * @property {boolean} exhausted `used ≥ included`.
 * @property {boolean} blocked Hard stop in effect (`hardStop && exhausted`).
 * @property {boolean} hardStop
 * @property {PeriodBounds} period
 */

/**
 * Sums counters that fall within `[start, end)`.
 * @param {readonly UsageCounter[] | number} counters
 * @param {PeriodBounds} period
 * @returns {number}
 */
const usedIn = (counters, period) => {
	if (typeof counters === 'number') return counters;
	let total = 0;
	for (const counter of counters) {
		const at = toMs(counter.at, 'counter.at');
		if (!Number.isSafeInteger(counter.quantity) || counter.quantity < 0)
			throw new RangeError('counter quantity must be an integer ≥ 0');
		if (at >= period.start && at < period.end) total += counter.quantity;
	}
	return total;
};

/**
 * State of a quota feature for the period containing `now`.
 * `counters` is either a list of usage records (summed within the period) or the period-to-date total.
 * @param {{ feature: QuotaFeature, counters: readonly UsageCounter[] | number, period?: { unit?: PeriodUnit, timeZone?: string }, now: Instant }} input
 * @returns {QuotaState}
 */
export const quotaState = ({ feature, counters, period = {}, now }) => {
	const bounds = periodBounds({ unit: period.unit ?? feature.period ?? 'month', timeZone: period.timeZone ?? 'UTC', at: now });
	const included = feature.value !== undefined ? feature.value : (feature.included ?? null);
	const hardStop = feature.hardStop !== false;
	const used = usedIn(counters, bounds);
	const exhausted = included !== null && used >= included;
	return {
		used,
		included,
		remaining: included === null ? null : Math.max(0, included - used),
		overage: included === null ? 0 : Math.max(0, used - included),
		exhausted,
		blocked: hardStop && exhausted,
		hardStop,
		period: bounds,
	};
};

/**
 * Whether consuming `quantity` more units is allowed under `state` (soft quotas always allow).
 * @param {Pick<QuotaState, 'hardStop' | 'included' | 'used'>} state
 * @param {number} quantity
 * @returns {boolean}
 */
export const quotaAllows = (state, quantity) =>
	!state.hardStop || state.included === null || state.used + quantity <= state.included;

/**
 * Overage charge (millicredits, rounded down) for a period-to-date usage.
 * @param {{ used: number, included: number | null, rate: import('./units.js').Rate | number }} input
 * @returns {number}
 */
export const overageCharge = ({ used, included, rate }) =>
	included === null ? 0 : chargeFor(Math.max(0, used - included), normaliseRate(rate));
