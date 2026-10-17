/**
 * Addresses (dynamic model §5): the fields of a delivery address with the longest value each takes — one table for
 * checkout, the cart widget, staff edits and imports, its place parts and their order, labels, required parts and
 * postal code shapes per country from the one address-format table (`@ss/contracts/address`, shared with Accounts) —
 * and how places compare: names without letter case and extra spaces, postcodes upper-cased without spaces (zones and
 * tax rules match their starts), countries by ISO 3166-1 alpha-2 code (an address keeps the code; zones and rules may
 * name a country by code or English name). An address without a country is in the business country.
 * No I/O (the widgets use it too).
 * @module
 */
import { PLACE_LIMITS, countryCodeOf } from '@ss/contracts/address';

// the address-format table the widgets use too (they import packages only through core/)
export {
	LABEL_KINDS,
	PLACE_PARTS,
	addressFields,
	addressLines,
	addressProblem,
	countryChoices,
	countryCodeOf,
	countryName,
	tidyPostcode,
} from '@ss/contracts/address';

/** The address fields in form order, with the longest value each takes (the country: a code or an English name). */
export const ADDRESS_LIMITS = Object.freeze({
	name: 120,
	phone: 40,
	...PLACE_LIMITS,
	country: 60,
	notes: 500,
});

/** @typedef {keyof typeof ADDRESS_LIMITS} AddressField */

/** The address fields in form order. @type {ReadonlyArray<AddressField>} */
export const ADDRESS_FIELDS = Object.freeze(/** @type {AddressField[]} */ (Object.keys(ADDRESS_LIMITS)));

/** Address fields a merchant may make required (`checkout.addressRequired`; the name always is, the phone by
 * `checkout.phoneRequired`). */
export const OPTIONAL_ADDRESS_FIELDS = Object.freeze(
	/** @type {AddressField[]} */ (['line1', 'line2', 'area', 'city', 'region', 'postalCode', 'country']),
);

/** A place name as compared: trimmed, inner spaces single, lower case. @param {unknown} value */
export const placeKey = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '');

/** A postcode as compared: upper case without spaces (`sw1a 1aa` = `SW1A1AA`). @param {unknown} value */
export const postcodeKey = (value) => (typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '');

/**
 * A country as compared: its ISO 3166-1 alpha-2 code for a code or an English name (`pk`, `Pakistan` → `PK`), else the
 * text as a place name; '' when empty.
 * @param {unknown} value
 */
export const countryKey = (value) => {
	const key = placeKey(value);
	if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
	return countryCodeOf(key) ?? key;
};

/**
 * A place an address is in, as zones and tax rules read it.
 * @typedef {{ country: string, region: string, city: string, area: string, postalCode: string }} Place
 */

/**
 * The place of an address (or of the cart's delivery choice); without a country it is in `homeCountry`.
 * @param {Partial<Record<'country' | 'region' | 'city' | 'area' | 'postalCode', unknown>> | null | undefined} where
 * @param {unknown} homeCountry the business country
 * @returns {Place}
 */
export const placeOf = (where, homeCountry) => {
	/** @param {unknown} value */
	const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
	return {
		country: textOf(where?.country) || textOf(homeCountry),
		region: textOf(where?.region),
		city: textOf(where?.city),
		area: textOf(where?.area),
		postalCode: textOf(where?.postalCode),
	};
};

/**
 * The region names checkout offers per country (the Portal's Region and format › Address rules, `[{ country, names }]`):
 * an address in a listed country names one of them exactly.
 * @typedef {{ country: string, names: string[] }} AddressRegions
 */

/**
 * The region names offered for a country, or null when the list does not name it.
 * @param {ReadonlyArray<AddressRegions>} regions @param {unknown} country
 * @returns {string[] | null}
 */
export const regionsFor = (regions, country) => {
	const key = countryKey(country);
	if (!key) return null;
	return regions.find((entry) => countryKey(entry.country) === key)?.names ?? null;
};
