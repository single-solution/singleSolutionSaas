/**
 * Delivery zones and their named rates (PLAN 0.8.8: zones by place, free over an amount, store pickup; dynamic model
 * §5; fixed-choices E5, like Shopify's shipping profiles). The merchant keeps the zones as the `delivery_zones` list:
 * `[{ key, name, match: { countries, regions, cities, areas, postcodes }, rates }]`, each rate
 * `{ key, name, kind, price, freeOver, minDays, maxDays, condition: { by, min, max }, locations }`:
 *
 * - `kind`: `delivery` (to the shopper's address) or `pickup` (at the pickup places: the stock locations that take
 *   pickups with Multi-location stock, `locations` naming some of them, [] = every one; else the one pickup point of
 *   the `delivery_zones` settings while it is on);
 * - `condition.by`: `none`, `weight` (the package's grams: the items' package weights, an item without one counts 0)
 *   or `value` (the goods after offers and the role price, minor units); it fits from `min` to `max` (both included;
 *   `max` 0 = no upper end);
 * - `freeOver`: the rate is free when the goods come to at least this much (0 = never); `minDays`/`maxDays`: the days it
 *   takes (null = not said).
 *
 * A zone fits an address when the address is in every kind of place the zone lists (one of its countries, regions,
 * cities and areas; its postcode starts with one of the postcodes); a zone that lists nothing fits every address. The
 * most specific fitting zone wins: the longest postcode start, then a zone listing areas, cities, regions, countries,
 * then the catch-all; between equals, the first in the list. The shopper picks one of the fitting zone's rates whose
 * condition the cart meets, in the zone's order; no fitting zone or rate = no delivery to that place. An address without
 * a country is in the business.json country. Until the merchant saves the list, it is one zone for every place with
 * today's single rate, `Standard` (free), and `Pickup`. Money is minor units. Names compare without letter case and
 * extra spaces, countries by code or English name, postcodes upper-cased without spaces (`core/address.js`). No I/O.
 * @module
 */
import { ADDRESS_LIMITS, countryKey, placeKey, postcodeKey } from './address.js';
import { isAmount } from '@ss/contracts/format';

/**
 * Where a zone delivers ([] = any).
 * @typedef {{ countries: string[], regions: string[], cities: string[], areas: string[], postcodes: string[] }} ZoneMatch
 */
/**
 * When a rate is offered: the package's grams (`weight`) or the goods' value in minor units (`value`) from `min` to
 * `max` (0 = no upper end); `none` = always.
 * @typedef {{ by: 'none' | 'weight' | 'value', min: number, max: number }} RateCondition
 */
/**
 * @typedef {{ key: string, name: string, kind: 'delivery' | 'pickup', price: number, freeOver: number,
 *   minDays: number | null, maxDays: number | null, condition: RateCondition, locations: string[] }} Rate
 */
/** @typedef {{ key: string, name: string, match: ZoneMatch, rates: Rate[] }} Zone */

/** The kinds of rate. */
export const RATE_KINDS = Object.freeze(/** @type {const} */ (['delivery', 'pickup']));
/** What a rate's condition measures. */
export const RATE_CONDITIONS = Object.freeze(/** @type {const} */ (['none', 'weight', 'value']));
/** At most this many rates in a zone, and this many pickup locations named by one rate. */
const MAX_RATES = 20;
const MAX_LOCATIONS = 50;
/** The heaviest package a weight condition names (grams: 1,000 t). */
const MAX_GRAMS = 1_000_000_000;

/** A rate that always fits, free, its days not said. @param {string} key @param {string} name @param {Rate['kind']} kind */
const plainRate = (key, name, kind) => ({
	key,
	name,
	kind,
	price: 0,
	freeOver: 0,
	minDays: null,
	maxDays: null,
	condition: { by: /** @type {const} */ ('none'), min: 0, max: 0 },
	locations: [],
});

/**
 * The zones until the merchant saves the list: every place, with today's one rate (`Standard`, free) and pickup at the
 * pickup places there are.
 * @returns {Zone[]}
 */
export const defaultZones = () => [
	{
		key: 'everywhere',
		name: 'Everywhere',
		match: { countries: [], regions: [], cities: [], areas: [], postcodes: [] },
		rates: [plainRate('standard', 'Standard', 'delivery'), plainRate('pickup', 'Pickup', 'pickup')],
	},
];

/** At most this many zones, and this many places of one kind in one zone. */
const MAX_ZONES = 100;
const MAX_PLACES = 500;
/** A zone or rate key. */
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** A stock location id. */
const LOCATION = /^[A-Za-z0-9_-]{1,64}$/;
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

/** @param {unknown} n */
const isDays = (n) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 365;

/**
 * Check a zone's rates.
 * @param {unknown} value @param {string} label @param {string[]} errors
 * @returns {Rate[]}
 */
const checkRates = (value, label, errors) => {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RATES) {
		errors.push(`${label}: rates is a list of 1–${MAX_RATES} rates.`);
		return [];
	}
	/** @type {Rate[]} */
	const rates = [];
	const keys = new Set();
	for (const raw of value) {
		const rate = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
		const key = typeof rate.key === 'string' ? rate.key : '';
		if (!KEY.test(key)) {
			errors.push(`${label}: rate key '${key}' must be 2–40 lowercase letters, digits or _ starting with a letter.`);
			continue;
		}
		const at = `${label} rate '${key}'`;
		if (keys.has(key)) errors.push(`${at} is listed twice.`);
		keys.add(key);
		const name = typeof rate.name === 'string' ? rate.name.trim() : '';
		if (!name || name.length > 60) errors.push(`${at} needs a name of at most 60 characters.`);
		const kind = rate.kind ?? 'delivery';
		if (!RATE_KINDS.includes(/** @type {any} */ (kind))) errors.push(`${at}: the kind is ${RATE_KINDS.join(' or ')}.`);
		const price = rate.price ?? 0;
		const freeOver = rate.freeOver ?? 0;
		if (!isAmount(price)) errors.push(`${at}: the price is a whole amount in minor units.`);
		if (!isAmount(freeOver)) errors.push(`${at}: free over is a whole amount in minor units (0 = never free).`);
		const minDays = rate.minDays ?? null;
		const maxDays = rate.maxDays ?? minDays;
		const said = minDays !== null || maxDays !== null;
		if (said && (!isDays(minDays) || !isDays(maxDays) || Number(minDays) > Number(maxDays)))
			errors.push(`${at}: its days are 0–365, the least first (or none).`);
		const given = isObject(rate.condition) ? /** @type {Record<string, unknown>} */ (rate.condition) : {};
		if (rate.condition !== undefined && !isObject(rate.condition)) errors.push(`${at}: the condition is { by, min, max }.`);
		const by = given.by ?? 'none';
		const min = given.min ?? 0;
		const max = given.max ?? 0;
		const most = by === 'weight' ? MAX_GRAMS : Number.MAX_SAFE_INTEGER;
		if (!RATE_CONDITIONS.includes(/** @type {any} */ (by)))
			errors.push(`${at}: the condition is by ${RATE_CONDITIONS.join(', ')}.`);
		else if (
			!isAmount(min) ||
			!isAmount(max) ||
			Number(min) > most ||
			Number(max) > most ||
			(Number(max) > 0 && Number(max) < Number(min))
		)
			errors.push(`${at}: the condition runs from a whole min to a whole max at least as large (max 0 = no upper end).`);
		const locations = rate.locations ?? [];
		const ids = Array.isArray(locations) ? locations.filter((id) => typeof id === 'string' && LOCATION.test(id)) : [];
		if (!Array.isArray(locations) || ids.length !== locations.length || ids.length > MAX_LOCATIONS)
			errors.push(`${at}: locations is a list of at most ${MAX_LOCATIONS} pickup location ids.`);
		else if (kind !== 'pickup' && ids.length > 0) errors.push(`${at}: only a pickup rate names locations.`);
		rates.push({
			key,
			name,
			kind: /** @type {Rate['kind']} */ (kind),
			price: Number(price),
			freeOver: Number(freeOver),
			minDays: said ? Number(minDays) : null,
			maxDays: said ? Number(maxDays) : null,
			condition:
				by === 'none' ? { by: 'none', min: 0, max: 0 } : { by: /** @type {any} */ (by), min: Number(min), max: Number(max) },
			locations: [...new Set(ids)],
		});
	}
	return rates;
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
		zones.push({ key, name, match: clean, rates: checkRates(zone.rates, `Zone '${key}'`, errors) });
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
 * Whether a cart meets a rate's condition.
 * @param {Rate} rate
 * @param {{ weightG: number, value: number }} cart the package's grams and the goods' value (minor units)
 */
export const rateFits = (rate, cart) => {
	const { by, min, max } = rate.condition;
	if (by === 'none') return true;
	const measured = by === 'weight' ? cart.weightG : cart.value;
	return measured >= min && (max === 0 || measured <= max);
};

/**
 * The fee of a rate for goods worth `value` (after offers): free at or over `freeOver` (0 = never).
 * @param {{ price: number, freeOver: number }} rate
 * @param {number} value minor units
 */
export const rateFee = (rate, value) => (rate.freeOver > 0 && value >= rate.freeOver ? 0 : rate.price);

/**
 * The rate search engines and feeds are told about: the first delivery rate without a condition of the zone of the
 * business's country (an address with nothing but that country); null when there is none.
 * @param {Zone[]} zones
 * @param {string} country
 * @returns {Rate | null}
 */
export const homeRate = (zones, country) => {
	const zone = matchZone(zones, { country, region: '', city: '', area: '', postalCode: '' });
	return zone?.rates.find((rate) => rate.kind === 'delivery' && rate.condition.by === 'none') ?? null;
};

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
