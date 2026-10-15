/**
 * Delivery zones and fees (PLAN 0.8.8: zones and fees by place, free over an amount, store pickup; dynamic model §5).
 * The merchant keeps the zones as the `delivery_zones` list:
 * `[{ key, name, match: { countries, regions, cities, areas, postcodes }, fee, freeOver, minDays, maxDays }]`.
 * A zone fits an address when the address is in every kind of place the zone lists (one of its countries, regions,
 * cities and areas; its postcode starts with one of the postcodes); a zone that lists nothing fits every address. The
 * most specific fitting zone wins: the longest postcode start, then a zone listing areas, cities, regions, countries,
 * then the catch-all; between equals, the first in the list. No match: the `delivery_zones` settings `defaultFee` and
 * `defaultFreeOver`. An address without a country is in the business.json country. Money is minor units; `freeOver`
 * 0 = never free. Names compare without letter case and extra spaces, countries by code or English name, postcodes
 * upper-cased without spaces (`core/address.js`). No I/O.
 * @module
 */
import { ADDRESS_LIMITS, countryKey, placeKey, postcodeKey } from './address.js';
import { isPrice } from './money.js';

/**
 * Where a zone delivers ([] = any).
 * @typedef {{ countries: string[], regions: string[], cities: string[], areas: string[], postcodes: string[] }} ZoneMatch
 */
/**
 * @typedef {{ key: string, name: string, match: ZoneMatch, fee: number, freeOver: number, minDays: number,
 *   maxDays: number }} Zone
 */

/** At most this many zones, and this many places of one kind in one zone. */
const MAX_ZONES = 100;
const MAX_PLACES = 500;
/** A zone key. */
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** The kinds of place a zone may list, with the longest name of each. */
const PLACE_KINDS = Object.freeze(
	/** @type {Array<[keyof ZoneMatch, number, (value: unknown) => string]>} */ ([
		['countries', ADDRESS_LIMITS.country, countryKey],
		['regions', ADDRESS_LIMITS.region, placeKey],
		['cities', ADDRESS_LIMITS.city, placeKey],
		['areas', ADDRESS_LIMITS.area, placeKey],
		['postcodes', ADDRESS_LIMITS.postalCode, postcodeKey],
	]),
);

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value @param {string} label @param {number} max @param {(value: unknown) => string} keyOf
 * @param {boolean} postcode postcodes are kept upper-cased without spaces
 * @param {string[]} errors
 * @returns {string[]}
 */
const places = (value, label, max, keyOf, postcode, errors) => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_PLACES) {
		errors.push(`${label} is a list of at most ${MAX_PLACES}.`);
		return [];
	}
	/** @type {string[]} */
	const out = [];
	for (const item of value) {
		const name = typeof item !== 'string' ? '' : postcode ? postcodeKey(item) : item.trim().replace(/\s+/g, ' ');
		if (!name || name.length > max) {
			errors.push(`${label}: every entry has 1–${max} characters.`);
			return [];
		}
		if (!out.some((known) => keyOf(known) === keyOf(name))) out.push(name);
	}
	return out;
};

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: Zone[] } | { ok: false, errors: string[] }}
 */
export const checkZones = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list of zones is expected.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_ZONES) errors.push(`At most ${MAX_ZONES} zones.`);
	/** @type {Zone[]} */
	const zones = [];
	const keys = new Set();
	for (const raw of value.slice(0, MAX_ZONES)) {
		const zone = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
		const key = typeof zone.key === 'string' ? zone.key : '';
		if (!KEY.test(key)) {
			errors.push(`Zone key '${key}' must be 2–40 lowercase letters, digits or _ starting with a letter.`);
			continue;
		}
		if (keys.has(key)) errors.push(`Zone '${key}' is listed twice.`);
		keys.add(key);
		const name = typeof zone.name === 'string' ? zone.name.trim() : '';
		if (!name || name.length > 60) errors.push(`Zone '${key}' needs a name of at most 60 characters.`);
		const given = zone.match ?? {};
		if (!isObject(given)) errors.push(`Zone '${key}': match lists countries, regions, cities, areas and postcodes.`);
		const match = /** @type {Record<string, unknown>} */ (isObject(given) ? given : {});
		const unknown = Object.keys(match).filter((kind) => !PLACE_KINDS.some(([known]) => known === kind));
		if (unknown.length > 0) errors.push(`Zone '${key}': match takes countries, regions, cities, areas and postcodes.`);
		/** @type {ZoneMatch} */
		const clean = { countries: [], regions: [], cities: [], areas: [], postcodes: [] };
		for (const [kind, max, keyOf] of PLACE_KINDS)
			clean[kind] = places(match[kind], `Zone '${key}' ${kind}`, max, keyOf, kind === 'postcodes', errors);
		const fee = zone.fee ?? 0;
		const freeOver = zone.freeOver ?? 0;
		if (!isPrice(fee)) errors.push(`Zone '${key}': the fee is a whole amount in minor units.`);
		if (!isPrice(freeOver)) errors.push(`Zone '${key}': free over is a whole amount in minor units (0 = never free).`);
		const minDays = zone.minDays ?? 0;
		const maxDays = zone.maxDays ?? minDays;
		const days = (/** @type {unknown} */ n) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 365;
		if (!days(minDays) || !days(maxDays) || Number(minDays) > Number(maxDays))
			errors.push(`Zone '${key}': delivery days are 0–365, the least first.`);
		zones.push({
			key,
			name,
			match: clean,
			fee: Number(fee),
			freeOver: Number(freeOver),
			minDays: Number(minDays),
			maxDays: Number(maxDays),
		});
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: zones };
};

/**
 * How specific a zone is for a place, or null when it does not fit: the length of its longest postcode start the
 * postcode has, then whether it lists areas, cities, regions and countries (compared in that order).
 * @param {Zone} zone @param {import('./address.js').Place} place
 * @returns {number[] | null}
 */
const specificity = (zone, place) => {
	const { match } = zone;
	/** @param {string[]} names @param {string} value @param {(value: unknown) => string} keyOf */
	const listed = (names, value, keyOf) =>
		names.length === 0 || (keyOf(value) !== '' && names.some((name) => keyOf(name) === keyOf(value)));
	if (!listed(match.countries, place.country, countryKey)) return null;
	if (!listed(match.regions, place.region, placeKey)) return null;
	if (!listed(match.cities, place.city, placeKey)) return null;
	if (!listed(match.areas, place.area, placeKey)) return null;
	const postcode = postcodeKey(place.postalCode);
	const starts = match.postcodes.filter((start) => postcode !== '' && postcode.startsWith(start));
	if (match.postcodes.length > 0 && starts.length === 0) return null;
	return [
		Math.max(0, ...starts.map((start) => start.length)),
		match.areas.length > 0 ? 1 : 0,
		match.cities.length > 0 ? 1 : 0,
		match.regions.length > 0 ? 1 : 0,
		match.countries.length > 0 ? 1 : 0,
	];
};

/** @param {number[]} a @param {number[]} b a positive number when `a` is more specific */
const compare = (a, b) => {
	for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return Number(a[index]) - Number(b[index]);
	return 0;
};

/**
 * The zone of a place: the most specific fitting zone, the first of equals; null when none fits.
 * @param {Zone[]} zones
 * @param {import('./address.js').Place} place
 * @returns {Zone | null}
 */
export const matchZone = (zones, place) => {
	/** @type {{ zone: Zone, rank: number[] } | null} */
	let best = null;
	for (const zone of zones) {
		const rank = specificity(zone, place);
		if (rank && (!best || compare(rank, best.rank) > 0)) best = { zone, rank };
	}
	return best?.zone ?? null;
};

/**
 * The fee for an order's items worth `merchandise` (after promotions): free at or over `freeOver` (0 = never).
 * @param {{ fee: number, freeOver: number }} zone
 * @param {number} merchandise minor units
 */
export const zoneFee = (zone, merchandise) => (zone.freeOver > 0 && merchandise >= zone.freeOver ? 0 : zone.fee);

/**
 * The cities the zones name (for the checkout form's suggestions), in their order, without repeats.
 * @param {Zone[]} zones
 */
export const zoneCities = (zones) => {
	/** @type {Map<string, string>} */
	const seen = new Map();
	for (const zone of zones) for (const city of zone.match.cities) if (!seen.has(placeKey(city))) seen.set(placeKey(city), city);
	return [...seen.values()];
};
