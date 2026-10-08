/**
 * AI token caps and cost alerts (pure, PLAN 0.8.3 AI): AI tokens (input + output as the provider reports them; main and
 * backup together) per website, with daily and monthly windows in the business.json time zone. At a cap AI replies stop
 * until the window resets. One cost alert per monthly window when the month crosses the alert share of the monthly cap.
 * @module
 */
import { dayKey, monthKey } from './time.js';

/**
 * The counter keys of the windows an instant falls in.
 * @param {number} now
 * @param {string} timeZone
 */
export const windowKeys = (now, timeZone) => ({ day: `day:${dayKey(now, timeZone)}`, month: `month:${monthKey(now, timeZone)}` });

/**
 * Whether a cap is reached (0 = no cap).
 * @param {{ day: number, month: number }} used
 * @param {{ dailyTokens: number, monthlyTokens: number }} caps
 */
export const capReached = (used, caps) =>
	(caps.dailyTokens > 0 && used.day >= caps.dailyTokens) || (caps.monthlyTokens > 0 && used.month >= caps.monthlyTokens);

/**
 * Whether spending moved the month across the alert share of the monthly cap.
 * @param {{ before: number, after: number, monthlyTokens: number, percent: number }} input
 */
export const alertCrossed = ({ before, after, monthlyTokens, percent }) => {
	if (monthlyTokens <= 0) return false;
	const threshold = (monthlyTokens * percent) / 100;
	return before < threshold && after >= threshold;
};
