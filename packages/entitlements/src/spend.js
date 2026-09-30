import { periodBounds } from './quotas.js';
import { isoInstant, toMs } from './time.js';
import { assertMillicredits } from './units.js';

/**
 * Spend caps per website or merchant, per calendar day or month (in the cap's time zone).
 *
 * A cap is **reached** when period spend ≥ limit, and **would be exceeded** when period spend plus
 * the upcoming charge (typically the next hour's burn) is > limit. The decision is to pause when any
 * cap is reached or would be exceeded; the pause lasts until the end of the latest blocking period
 * (auto-resume when the period rolls over, or earlier if the cap is raised).
 */

/** @typedef {import('./time.js').Instant} Instant */

/**
 * @typedef {object} SpendCap
 * @property {'website' | 'merchant'} scope
 * @property {string} scopeId websiteId or merchantId.
 * @property {'day' | 'month'} window
 * @property {number} limit Millicredits per window.
 * @property {string} [timeZone] Default `UTC`.
 */

/**
 * @typedef {object} SpendEntry
 * @property {Instant} at
 * @property {number} amount Millicredits charged.
 * @property {string} [websiteId]
 * @property {string} [merchantId]
 */

/**
 * @typedef {object} SpendCapState
 * @property {SpendCap} cap
 * @property {string} key `${scope}:${scopeId}:${periodKey}`
 * @property {number} spent
 * @property {number} limit
 * @property {number} remaining
 * @property {boolean} reached
 * @property {boolean} wouldExceed
 * @property {string} periodStart
 * @property {string} periodEnd
 */

/**
 * State of one cap at `now`.
 * @param {{ cap: SpendCap, entries: readonly SpendEntry[], now: Instant, upcoming?: number }} input
 * @returns {SpendCapState}
 */
export const spendCapState = ({ cap, entries, now, upcoming = 0 }) => {
	if (cap.window !== 'day' && cap.window !== 'month') throw new RangeError(`unknown spend cap window ${String(cap.window)}`);
	assertMillicredits(cap.limit, 'cap.limit');
	assertMillicredits(upcoming, 'upcoming');
	const period = periodBounds({ unit: cap.window, timeZone: cap.timeZone ?? 'UTC', at: now });
	const field = cap.scope === 'website' ? 'websiteId' : 'merchantId';
	let spent = 0;
	for (const entry of entries) {
		const at = toMs(entry.at, 'entry.at');
		if (entry[field] === cap.scopeId && at >= period.start && at < period.end)
			spent += assertMillicredits(entry.amount, 'entry.amount');
	}
	const reached = spent >= cap.limit;
	return {
		cap,
		key: `${cap.scope}:${cap.scopeId}:${period.key}`,
		spent,
		limit: cap.limit,
		remaining: Math.max(0, cap.limit - spent),
		reached,
		wouldExceed: reached || (upcoming > 0 && spent + upcoming > cap.limit),
		periodStart: isoInstant(period.start),
		periodEnd: isoInstant(period.end),
	};
};

/**
 * Evaluates every cap and decides whether to pause.
 * @param {{ caps: readonly SpendCap[], entries: readonly SpendEntry[], now: Instant, upcoming?: number }} input
 * @returns {{ shouldPause: boolean, blocking: SpendCapState[], resumeAt: string | null, states: SpendCapState[] }}
 */
export const spendCapDecision = ({ caps, entries, now, upcoming = 0 }) => {
	const states = caps
		.map((cap) => spendCapState({ cap, entries, now, upcoming }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const blocking = states.filter((s) => s.wouldExceed);
	const resumeAt = blocking.length === 0 ? null : isoInstant(Math.max(...blocking.map((s) => Date.parse(s.periodEnd))));
	return { shouldPause: blocking.length > 0, blocking, resumeAt, states };
};
