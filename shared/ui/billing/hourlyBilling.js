/**
 * AWS-style Pay-Per-Hour Metering Utility
 * Base conversion standard: 720 hours / calendar month (30 days * 24 hours)
 */

export const HOURS_PER_MONTH = 720;

/**
 * Calculates hourly rate from monthly credit price
 * @param {number} monthlyCreditCost
 * @returns {number} hourlyRate rounded to 4 decimals
 */
export function getHourlyRate(monthlyCreditCost = 0) {
	const cost = Number(monthlyCreditCost) || 0;
	return Math.round((cost / HOURS_PER_MONTH) * 10000) / 10000;
}

/**
 * Formats hourly display string e.g. "$0.0417/hr"
 */
export function formatHourlyRate(monthlyCreditCost = 0) {
	const hourly = getHourlyRate(monthlyCreditCost);
	return `$${hourly.toFixed(4)}/hr`;
}

/**
 * Formats monthly approximation e.g. "~$30/mo"
 */
export function formatMonthlyEquivalent(monthlyCreditCost = 0) {
	return `~$${Number(monthlyCreditCost) || 0}/mo`;
}

/**
 * Calculates actual consumption cost for a given time window
 * @param {number} monthlyCreditCost
 * @param {number} hoursActive
 * @returns {number} consumed credits rounded to 2 decimals
 */
export function calculateUsageCost(monthlyCreditCost, hoursActive = 1) {
	const hourly = getHourlyRate(monthlyCreditCost);
	return Math.round(hourly * hoursActive * 100) / 100;
}
