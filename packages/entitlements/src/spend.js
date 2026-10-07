import { isoInstant, toMs } from './time.js';
import { assertMillicredits } from './units.js';

/**
 * The spend cap: one optional limit per merchant, per UTC calendar month.
 *
 * The cap is **reached** when month-to-date spend ≥ limit, and **would be exceeded** when month-to-date
 * spend plus the upcoming charge (typically the next hour's burn) is > limit. Either pauses the
 * merchant's subscriptions until the month rolls over (auto-resume at `periodEnd`, or earlier if the
 * cap is raised or removed).
 */

/** @typedef {import('./time.js').Instant} Instant */

/** @typedef {{ limit: number }} SpendCap millicredits per UTC calendar month, merchant-wide */

/** @typedef {{ at: Instant, amount: number }} SpendEntry millicredits charged at `at` */

/**
 * @typedef {object} SpendCapState
 * @property {number} limit
 * @property {number} spent month-to-date millicredits
 * @property {number} remaining
 * @property {boolean} reached
 * @property {boolean} wouldExceed
 * @property {string} periodKey `YYYY-MM` (UTC)
 * @property {string} periodStart
 * @property {string} periodEnd
 */

/**
 * State of the cap for the UTC calendar month containing `now`.
 * @param {{ cap: SpendCap, entries: readonly SpendEntry[], now: Instant, upcoming?: number }} input
 * @returns {SpendCapState}
 */
export const spendCapState = ({ cap, entries, now, upcoming = 0 }) => {
	assertMillicredits(cap.limit, 'cap.limit');
	assertMillicredits(upcoming, 'upcoming');
	const at = new Date(toMs(now, 'now'));
	const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
	const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
	let spent = 0;
	for (const entry of entries) {
		const ms = toMs(entry.at, 'entry.at');
		if (ms >= start && ms < end) spent += assertMillicredits(entry.amount, 'entry.amount');
	}
	const reached = spent >= cap.limit;
	return {
		limit: cap.limit,
		spent,
		remaining: Math.max(0, cap.limit - spent),
		reached,
		wouldExceed: reached || spent + upcoming > cap.limit,
		periodKey: isoInstant(start).slice(0, 7),
		periodStart: isoInstant(start),
		periodEnd: isoInstant(end),
	};
};

/**
 * Whether to pause for the cap (no cap: never).
 * @param {{ cap: SpendCap | null | undefined, entries: readonly SpendEntry[], now: Instant, upcoming?: number }} input
 * @returns {{ shouldPause: boolean, resumeAt: string | null, state: SpendCapState | null }}
 */
export const spendCapDecision = ({ cap, entries, now, upcoming = 0 }) => {
	if (!cap) return { shouldPause: false, resumeAt: null, state: null };
	const state = spendCapState({ cap, entries, now, upcoming });
	return { shouldPause: state.wouldExceed, resumeAt: state.wouldExceed ? state.periodEnd : null, state };
};
