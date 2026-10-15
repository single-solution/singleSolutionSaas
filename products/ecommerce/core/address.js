/**
 * Addresses (dynamic model §5): the fields of a delivery address in the order forms show them, with the longest value
 * each takes — one table for checkout, the cart widget, staff edits and imports — and how places compare: names
 * without letter case and extra spaces, postcodes upper-cased without spaces (zones and tax rules match their starts),
 * countries by ISO 3166-1 alpha-2 code or English name. An address without a country is in the business.json country.
 * No I/O and no imports (the widgets use it too).
 * @module
 */

/** The address fields in form order, with the longest value each takes. */
export const ADDRESS_LIMITS = Object.freeze({
	name: 120,
	phone: 40,
	line1: 200,
	line2: 200,
	city: 100,
	area: 100,
	region: 100,
	postalCode: 20,
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

/** @type {Map<string, string> | null} English country names (as compared) → ISO code, made on first use. */
let countryCodes = null;

/** @returns {Map<string, string>} */
const codesByName = () => {
	if (countryCodes) return countryCodes;
	countryCodes = new Map();
	try {
		const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
		for (let first = 65; first <= 90; first += 1)
			for (let second = 65; second <= 90; second += 1) {
				const code = String.fromCharCode(first, second);
				const name = names.of(code);
				if (name && name !== code) countryCodes.set(placeKey(name), code);
			}
	} catch {
		// no region names in this runtime: countries then compare by code or as typed
	}
	return countryCodes;
};

/**
 * A country as compared: its ISO 3166-1 alpha-2 code for a code or an English name (`pk`, `Pakistan` → `PK`), else the
 * text as a place name; '' when empty.
 * @param {unknown} value
 */
export const countryKey = (value) => {
	const key = placeKey(value);
	if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
	return codesByName().get(key) ?? key;
};

/**
 * A place an address is in, as zones and tax rules read it.
 * @typedef {{ country: string, region: string, city: string, area: string, postalCode: string }} Place
 */

/**
 * The place of an address (or of the cart's delivery choice); without a country it is in `homeCountry`.
 * @param {Partial<Record<'country' | 'region' | 'city' | 'area' | 'postalCode', unknown>> | null | undefined} where
 * @param {unknown} homeCountry the business.json country
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
 * The region names checkout offers per country (`address_regions`, `[{ country, names }]`): an address in a listed
 * country names one of them exactly.
 * @typedef {{ country: string, names: string[] }} AddressRegions
 */

/** At most this many countries in `address_regions`, and this many region names in one. */
const MAX_REGION_COUNTRIES = 50;
const MAX_REGION_NAMES = 200;

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the `address_regions` list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: AddressRegions[] } | { ok: false, errors: string[] }}
 */
export const checkAddressRegions = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list of countries with their regions is expected.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_REGION_COUNTRIES) errors.push(`At most ${MAX_REGION_COUNTRIES} countries.`);
	/** @type {AddressRegions[]} */
	const out = [];
	const seen = new Set();
	for (const [index, raw] of value.slice(0, MAX_REGION_COUNTRIES).entries()) {
		const entry = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
		const country = typeof entry.country === 'string' ? entry.country.trim() : '';
		const label = `Country ${index + 1}`;
		if (!country || country.length > ADDRESS_LIMITS.country) {
			errors.push(`${label} needs a country of at most ${ADDRESS_LIMITS.country} characters.`);
			continue;
		}
		if (seen.has(countryKey(country))) errors.push(`${country} is listed twice.`);
		seen.add(countryKey(country));
		const names = Array.isArray(entry.names) ? entry.names : null;
		if (!names || names.length === 0 || names.length > MAX_REGION_NAMES) {
			errors.push(`${country}: list 1–${MAX_REGION_NAMES} region names.`);
			continue;
		}
		/** @type {string[]} */
		const clean = [];
		for (const name of names) {
			const text = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
			if (!text || text.length > ADDRESS_LIMITS.region) {
				errors.push(`${country}: every region name has 1–${ADDRESS_LIMITS.region} characters.`);
				break;
			}
			if (!clean.some((known) => placeKey(known) === placeKey(text))) clean.push(text);
		}
		out.push({ country, names: clean });
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: out };
};

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
