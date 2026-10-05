/**
 * Warranty per tier (pure): days of cover and text templates from the `warranty` feature, periods written in the
 * catalog's language (days below a month, then months and remaining days — "month" length is a setting).
 * @module
 */
import { cleanText, fill, isKey, isObject } from './text.js';

/**
 * @typedef {object} WarrantyTerm
 * @property {string} tier
 * @property {string} label tier label
 * @property {number} days
 * @property {string} periodText
 * @property {string} text
 * @property {string[]} exclusions
 */

/**
 * A warranty period in words.
 * @param {number} totalDays
 * @param {import('./text.js').Translate} t
 * @param {number} daysPerMonth
 */
export const periodText = (totalDays, t, daysPerMonth) => {
	const days = Math.max(0, Math.floor(totalDays));
	if (days === 0) return t('warranty.period.none');
	const dayText = (/** @type {number} */ n) => (n === 1 ? t('warranty.period.day') : t('warranty.period.days', { count: n }));
	if (days < daysPerMonth) return dayText(days);
	const months = Math.floor(days / daysPerMonth);
	const rest = days % daysPerMonth;
	const monthText = months === 1 ? t('warranty.period.month') : t('warranty.period.months', { count: months });
	return rest === 0 ? monthText : t('warranty.period.months_days', { months: monthText, days: dayText(rest) });
};

/**
 * Terms of every tier (in ladder order).
 * @param {{ tiers: ReadonlyArray<import('./tiers.js').Tier>, config: Record<string, any>, t: import('./text.js').Translate }} input
 * @returns {WarrantyTerm[]}
 */
export const warrantyTerms = ({ tiers, config, t }) => {
	/** @type {Map<string, Record<string, any>>} */
	const byTier = new Map();
	for (const entry of Array.isArray(config.terms) ? config.terms : [])
		if (isObject(entry) && isKey(entry.tier) && !byTier.has(entry.tier)) byTier.set(entry.tier, entry);
	const fallbackDays = Number.isInteger(config.default_days) ? config.default_days : 0;
	const daysPerMonth = Number.isInteger(config.days_per_month) ? config.days_per_month : 30;
	const terms = tiers.map((tier) => {
		const entry = byTier.get(tier.key);
		const days = Number.isInteger(entry?.days) ? Math.max(0, entry?.days) : fallbackDays;
		const period = periodText(days, t, daysPerMonth);
		const template =
			cleanText(entry?.text, 1000) ??
			cleanText(config.default_text, 1000) ??
			(days > 0 ? t('warranty.text.default') : t('warranty.text.none'));
		return {
			tier: tier.key,
			label: tier.label,
			days,
			periodText: period,
			text: fill(template, { days, period, tier: tier.label }),
			exclusions: (Array.isArray(entry?.exclusions) ? entry.exclusions : [])
				.map((/** @type {unknown} */ line) => cleanText(line, 200))
				.filter((/** @type {string | null} */ line) => line !== null),
		};
	});
	return config.hide_without_cover === true ? terms.filter((term) => term.days > 0) : terms;
};

/**
 * Printable plain-text terms.
 * @param {WarrantyTerm[]} terms
 * @param {import('./text.js').Translate} t
 */
export const printableTerms = (terms, t) =>
	[
		t('warranty.print.title'),
		'',
		...terms.flatMap((term) => [
			`${term.label} — ${term.periodText}`,
			term.text,
			...(term.exclusions.length > 0 ? [t('warranty.print.exclusions'), ...term.exclusions.map((line) => `  - ${line}`)] : []),
			'',
		]),
	].join('\n');
