/**
 * Tax rules (PLAN 0.8.8: simple rules, a percentage per category or region; prices shown with or without tax; dynamic
 * model §5). The merchant keeps them as the `tax_rules` list:
 * `[{ name, percent, categoryIds, regions: [{ country, region, city, postcode }] }]`. A rule applies to a line when it
 * names none of the categories or one of the line's categories (with their ancestors), and when it names no regions or
 * one that fits where the order goes: the same country, and the region, city and postcode start when the entry names
 * them (a delivery's address, without a country in the business.json country; a pickup order is at the business, in
 * its country). The percents of every applying rule add up. With prices that include tax (the `taxes` setting
 * `pricesIncludeTax`) the tax is the part of the price it already holds; otherwise it is added on top. No I/O.
 * @module
 */
import { isObject } from '@ss/contracts/util';
import { ADDRESS_LIMITS, countryKey, placeKey, postcodeKey } from './address.js';

/** @typedef {{ country: string, region: string, city: string, postcode: string }} TaxRegion */
/** @typedef {{ name: string, percent: number, categoryIds: string[], regions: TaxRegion[] }} TaxRule */

/** At most this many rules. */
const MAX_RULES = 50;

/** @param {unknown} value */
const textOf = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');

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
		/** @type {TaxRegion[]} */
		const cleanRegions = [];
		if (!Array.isArray(regions) || regions.length > 200) errors.push(`${label}: regions are a list of at most 200.`);
		else
			for (const region of regions) {
				const r = isObject(region) ? /** @type {Record<string, unknown>} */ (region) : {};
				const entry = {
					country: textOf(r.country),
					region: textOf(r.region),
					city: textOf(r.city),
					postcode: postcodeKey(r.postcode),
				};
				if (
					!entry.country ||
					entry.country.length > ADDRESS_LIMITS.country ||
					entry.region.length > ADDRESS_LIMITS.region ||
					entry.city.length > ADDRESS_LIMITS.city ||
					entry.postcode.length > ADDRESS_LIMITS.postalCode
				) {
					errors.push(`${label}: every region names a country (and may name a region, a city and a postcode start).`);
					break;
				}
				cleanRegions.push(entry);
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
 * Whether a rule's region entry fits a place: the same country, and its region, city and postcode start when it names
 * them.
 * @param {TaxRegion} entry @param {import('./address.js').Place} place
 */
const fits = (entry, place) =>
	countryKey(place.country) !== '' &&
	countryKey(entry.country) === countryKey(place.country) &&
	(entry.region === '' || placeKey(entry.region) === placeKey(place.region)) &&
	(entry.city === '' || placeKey(entry.city) === placeKey(place.city)) &&
	(entry.postcode === '' || postcodeKey(place.postalCode).startsWith(entry.postcode));

/**
 * The percent that applies to a line (the applying rules added up, at most 100).
 * @param {TaxRule[]} rules
 * @param {{ categoryIds: string[], region: import('./address.js').Place | null }} line `region`: where the order goes
 *   (null: no place, then only rules without regions apply)
 */
export const taxPercent = (rules, { categoryIds, region }) => {
	let total = 0;
	for (const rule of rules) {
		if (rule.categoryIds.length > 0 && !rule.categoryIds.some((id) => categoryIds.includes(id))) continue;
		if (rule.regions.length > 0 && (region === null || !rule.regions.some((entry) => fits(entry, region)))) continue;
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
