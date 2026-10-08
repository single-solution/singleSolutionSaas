/**
 * Tax rules (PLAN 0.8.8: simple rules, a percentage per category or region; prices shown with or without tax). The
 * merchant keeps them as the `tax_rules` list: `[{ name, percent, categoryIds, regions: [{ country, city }] }]`.
 * A rule applies to a line when it names none of the categories or one of the line's categories (with their
 * ancestors), and when it names no regions or one that fits the delivery address (country, and the city when the
 * region names one). The percents of every applying rule add up. With prices that include tax (the `taxes` setting
 * `pricesIncludeTax`) the tax is the part of the price it already holds; otherwise it is added on top. No I/O.
 * @module
 */
import { placeKey } from './delivery.js';

/** @typedef {{ name: string, percent: number, categoryIds: string[], regions: Array<{ country: string, city: string }> }} TaxRule */

/** At most this many rules. */
const MAX_RULES = 50;

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: TaxRule[] } | { ok: false, errors: string[] }}
 */
export const checkTaxRules = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list of tax rules is expected.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_RULES) errors.push(`At most ${MAX_RULES} tax rules.`);
	/** @type {TaxRule[]} */
	const rules = [];
	for (const [index, raw] of value.slice(0, MAX_RULES).entries()) {
		const rule = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
		const label = `Tax rule ${index + 1}`;
		const name = typeof rule.name === 'string' ? rule.name.trim() : '';
		if (!name || name.length > 60) errors.push(`${label} needs a name of at most 60 characters.`);
		const percent = rule.percent;
		if (
			typeof percent !== 'number' ||
			!Number.isFinite(percent) ||
			percent < 0 ||
			percent > 100 ||
			Math.round(percent * 1000) !== percent * 1000
		)
			errors.push(`${label}: the percent is 0–100 with at most 3 decimals.`);
		const categoryIds = rule.categoryIds ?? [];
		if (
			!Array.isArray(categoryIds) ||
			categoryIds.length > 200 ||
			!categoryIds.every((id) => typeof id === 'string' && id.length <= 64)
		)
			errors.push(`${label}: categories are a list of category ids.`);
		const regions = rule.regions ?? [];
		/** @type {TaxRule['regions']} */
		const cleanRegions = [];
		if (!Array.isArray(regions) || regions.length > 200) errors.push(`${label}: regions are a list of at most 200.`);
		else
			for (const region of regions) {
				const r = isObject(region) ? /** @type {Record<string, unknown>} */ (region) : {};
				const country = typeof r.country === 'string' ? r.country.trim() : '';
				const city = typeof r.city === 'string' ? r.city.trim() : '';
				if (!country || country.length > 60 || city.length > 80) {
					errors.push(`${label}: every region names a country (and may name a city).`);
					break;
				}
				cleanRegions.push({ country, city });
			}
		rules.push({
			name,
			percent: Number(percent),
			categoryIds: Array.isArray(categoryIds) ? [...new Set(/** @type {string[]} */ (categoryIds))] : [],
			regions: cleanRegions,
		});
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: rules };
};

/**
 * The percent that applies to a line (the applying rules added up, at most 100).
 * @param {TaxRule[]} rules
 * @param {{ categoryIds: string[], region: { country: string, city: string } | null }} line `region`: the delivery
 *   address (null: no address, then only rules without regions apply)
 */
export const taxPercent = (rules, { categoryIds, region }) => {
	const country = placeKey(region?.country);
	const city = placeKey(region?.city);
	let total = 0;
	for (const rule of rules) {
		if (rule.categoryIds.length > 0 && !rule.categoryIds.some((id) => categoryIds.includes(id))) continue;
		if (
			rule.regions.length > 0 &&
			!rule.regions.some(
				(r) => country !== '' && placeKey(r.country) === country && (r.city === '' || placeKey(r.city) === city),
			)
		)
			continue;
		total += rule.percent;
	}
	return Math.min(100, total);
};

/**
 * The tax of an amount at `percent`: the part it holds when prices include tax, else what is added on top. Minor units.
 * @param {number} amount minor units
 * @param {number} percent
 * @param {boolean} included
 */
export const taxOf = (amount, percent, included) => {
	if (amount <= 0 || percent <= 0) return 0;
	return included ? amount - Math.round((amount * 100) / (100 + percent)) : Math.round((amount * percent) / 100);
};
