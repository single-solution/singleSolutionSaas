/**
 * Delivery zones and fees (PLAN 0.8.8: zones and fees by city/area, free over an amount, store pickup). The merchant
 * keeps the zones as the `delivery_zones` list: `[{ key, name, cities, areas, fee, freeOver, minDays, maxDays }]`.
 * A zone matches an address by city (no cities = every city) and, when it lists areas, by area; the most specific
 * matching zone wins (area, then city, then a zone for every city). No match: the `delivery_zones` settings
 * `defaultFee` and `defaultFreeOver`. Money is minor units; `freeOver` 0 = never free. Names are compared without
 * case and surrounding spaces. No I/O.
 * @module
 */
import { isPrice } from './money.js';

/**
 * @typedef {{ key: string, name: string, cities: string[], areas: string[], fee: number, freeOver: number,
 *   minDays: number, maxDays: number }} Zone
 */

/** At most this many zones, and this many cities or areas in one zone. */
const MAX_ZONES = 100;
const MAX_PLACES = 500;
/** A zone key. */
const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A place name as compared. @param {unknown} value */
export const placeKey = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '');

/**
 * @param {unknown} value @param {string} label @param {string[]} errors
 * @returns {string[]}
 */
const places = (value, label, errors) => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_PLACES) {
		errors.push(`${label} is a list of at most ${MAX_PLACES} names.`);
		return [];
	}
	/** @type {string[]} */
	const out = [];
	for (const item of value) {
		const name = typeof item === 'string' ? item.trim().replace(/\s+/g, ' ') : '';
		if (!name || name.length > 80) {
			errors.push(`${label}: every name has 1–80 characters.`);
			return [];
		}
		if (!out.some((known) => placeKey(known) === placeKey(name))) out.push(name);
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
		const cities = places(zone.cities, `Zone '${key}' cities`, errors);
		const areas = places(zone.areas, `Zone '${key}' areas`, errors);
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
			cities,
			areas,
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
 * The zone of an address: area match, then city match, then a zone for every city; null when none matches.
 * @param {Zone[]} zones
 * @param {{ city?: string, area?: string }} where
 * @returns {Zone | null}
 */
export const matchZone = (zones, { city = '', area = '' }) => {
	const c = placeKey(city);
	const a = placeKey(area);
	/** @param {Zone} zone */
	const cityFits = (zone) => zone.cities.length === 0 || (c !== '' && zone.cities.some((name) => placeKey(name) === c));
	/** @param {Zone} zone */
	const areaFits = (zone) => zone.areas.length === 0 || (a !== '' && zone.areas.some((name) => placeKey(name) === a));
	const fitting = zones.filter((zone) => cityFits(zone) && areaFits(zone));
	const score = (/** @type {Zone} */ zone) => (zone.areas.length > 0 ? 2 : 0) + (zone.cities.length > 0 ? 1 : 0);
	return fitting.reduce((/** @type {Zone | null} */ best, zone) => (best && score(best) >= score(zone) ? best : zone), null);
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
	for (const zone of zones) for (const city of zone.cities) if (!seen.has(placeKey(city))) seen.set(placeKey(city), city);
	return [...seen.values()];
};
