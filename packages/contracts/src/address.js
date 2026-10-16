/**
 * Address formats per country (one table for every product's address forms, checks and display), browser-safe.
 *
 * A postal address has a country (ISO 3166-1 alpha-2) and up to six place parts: `line1` and `line2` (the street
 * lines), `area` (a neighborhood, district or suburb inside the city), `city`, `region` (a state, province, prefecture,
 * emirate …) and `postalCode`. Each country's entry, after Google's address data (libaddressinput, the source CLDR and
 * Shopify use), says:
 * - the order of the parts and how they are written (`%A` street lines, `%D` area, `%C` city, `%S` region, `%Z`
 *   postal code, `%n` a new line; other text sits between parts), which a form follows and a printed address uses;
 * - the kind of label each part takes (a region is a `state` in the US and an `emirate` in the UAE; a postal code a
 *   `zip` in the US and a `pin` in India). Products show each kind as a widget text (`address.<part>.<kind>`), so a
 *   website renames any of them (for example `address.area.area`);
 * - which parts the country itself requires (only the region and the postal code: the others are the website's
 *   choice) and the shape of its postal codes, when it has them.
 * Every other country takes {@link DEFAULT_FORMAT}. Nothing here shortens what may be typed, and a part the country
 * does not use still shows when the website requires it (a postal code never shows where the country has none).
 * @module
 */
import { PHONE_COUNTRIES } from './phone.js';

/** The place parts, in their usual order, with the longest value each takes. */
export const PLACE_LIMITS = Object.freeze({
	line1: 200,
	line2: 200,
	area: 100,
	city: 100,
	region: 100,
	postalCode: 20,
});

/** @typedef {keyof typeof PLACE_LIMITS} PlacePart */

/** The place parts in their usual order. @type {ReadonlyArray<PlacePart>} */
export const PLACE_PARTS = Object.freeze(/** @type {PlacePart[]} */ (Object.keys(PLACE_LIMITS)));

/**
 * The label kinds of the parts whose names differ between countries, the first of each the default: each is a
 * widget text `address.<part>.<kind>` in the products that show addresses.
 */
export const LABEL_KINDS = Object.freeze({
	area: Object.freeze(['area', 'neighborhood', 'district', 'suburb', 'townland', 'village_township']),
	city: Object.freeze(['city', 'suburb', 'post_town', 'district']),
	region: Object.freeze([
		'region',
		'state',
		'province',
		'prefecture',
		'emirate',
		'county',
		'department',
		'governorate',
		'oblast',
		'do_si',
		'area',
	]),
	postalCode: Object.freeze(['postal', 'zip', 'pin', 'eircode']),
});

/** @typedef {keyof typeof LABEL_KINDS} LabeledPart */

/**
 * One country's entry: `f` the format, `r` the parts it requires (`S` region, `Z` postal code), `d`/`c`/`s`/`z` the
 * label kinds of the area, city, region and postal code when not the default, `p` the postal code's shape (a regular
 * expression matched whole, any letter case) and `z: ''` for a country without postal codes.
 * @typedef {{ f: string, r?: string, d?: string, c?: string, s?: string, z?: string, p?: string }} Entry
 */

/** The format of a country not listed: street lines, then the city and an optional postal code. */
export const DEFAULT_FORMAT = '%A%n%C %Z';

/** @type {Readonly<Record<string, Entry>>} */
const FORMATS = Object.freeze({
	AE: { f: '%A%n%C%n%S', r: 'S', s: 'emirate' },
	AR: { f: '%A%n%Z %C%n%S', s: 'province', p: '[A-HJ-NP-Z]?\\d{4}(?:[A-Z]{3})?' },
	AT: { f: '%A%n%Z %C', r: 'Z', p: '\\d{4}' },
	AU: { f: '%A%n%C %S %Z', r: 'SZ', c: 'suburb', s: 'state', p: '\\d{4}' },
	BD: { f: '%A%n%C - %Z', p: '\\d{4}' },
	BE: { f: '%A%n%Z %C', r: 'Z', p: '\\d{4}' },
	BG: { f: '%A%n%Z %C', p: '\\d{4}' },
	BR: { f: '%A%n%D%n%C-%S%n%Z', r: 'SZ', d: 'neighborhood', s: 'state', p: '\\d{5}-?\\d{3}' },
	CA: {
		f: '%A%n%C %S %Z',
		r: 'SZ',
		s: 'province',
		p: '[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d',
	},
	CH: { f: '%A%n%Z %C', r: 'Z', p: '\\d{4}' },
	CL: { f: '%A%n%Z %C%n%S', p: '\\d{7}' },
	CN: { f: '%A%n%D%n%C%n%S, %Z', r: 'S', d: 'district', s: 'province', p: '\\d{6}' },
	CO: { f: '%A%n%D%n%C, %S, %Z', r: 'S', s: 'department', p: '\\d{6}' },
	CZ: { f: '%A%n%Z %C', r: 'Z', p: '\\d{3} ?\\d{2}' },
	DE: { f: '%A%n%Z %C', r: 'Z', p: '\\d{5}' },
	DK: { f: '%A%n%Z %C', r: 'Z', p: '\\d{4}' },
	EE: { f: '%A%n%Z %C %S', s: 'county', p: '\\d{5}' },
	EG: { f: '%A%n%C%n%S%n%Z', s: 'governorate', p: '\\d{5}' },
	ES: { f: '%A%n%Z %C %S', r: 'SZ', s: 'province', p: '\\d{5}' },
	FI: { f: '%A%n%Z %C', r: 'Z', p: '\\d{5}' },
	FR: { f: '%A%n%Z %C', r: 'Z', p: '\\d{2} ?\\d{3}' },
	GB: {
		f: '%A%n%C%n%Z',
		r: 'Z',
		c: 'post_town',
		p: 'GIR ?0AA|[A-PR-UWYZ](?:\\d[\\dA-HJKPS-UW]?|[A-HK-Y]\\d[\\dABEHMNPRV-Y]?) ?\\d[ABD-HJLNP-UW-Z]{2}',
	},
	GR: { f: '%A%n%Z %C', r: 'Z', p: '\\d{3} ?\\d{2}' },
	HK: { f: '%A%n%C%n%S', r: 'S', c: 'district', s: 'area' },
	HR: { f: '%A%n%Z %C', p: '\\d{5}' },
	HU: { f: '%C%n%A%n%Z', r: 'Z', p: '\\d{4}' },
	ID: { f: '%A%n%C%n%S %Z', r: 'S', s: 'province', p: '\\d{5}' },
	IE: { f: '%A%n%D%n%C%n%S%n%Z', d: 'townland', s: 'county', z: 'eircode', p: '[\\dA-Z]{3} ?[\\dA-Z]{4}' },
	IL: { f: '%A%n%C %Z', p: '\\d{5}(?:\\d{2})?' },
	IN: { f: '%A%n%D%n%C %Z%n%S', r: 'SZ', s: 'state', z: 'pin', p: '\\d{6}' },
	IT: { f: '%A%n%Z %C %S', r: 'SZ', s: 'province', p: '\\d{5}' },
	JP: { f: '%Z%n%S%n%C%n%A', r: 'SZ', s: 'prefecture', p: '\\d{3}-?\\d{4}' },
	KE: { f: '%A%n%C%n%Z', p: '\\d{5}' },
	KR: { f: '%A%n%D%n%C%n%S%n%Z', r: 'SZ', d: 'district', s: 'do_si', p: '\\d{5}' },
	KW: { f: '%A%n%Z %C', p: '\\d{5}' },
	LK: { f: '%A%n%C%n%Z', p: '\\d{5}' },
	LT: { f: '%A%n%Z %C', r: 'Z', p: '(?:LT-)?\\d{5}' },
	LU: { f: '%A%n%Z %C', r: 'Z', p: '(?:L-)?\\d{4}' },
	LV: { f: '%A%n%C, %Z', r: 'Z', p: '(?:LV-)?\\d{4}' },
	MA: { f: '%A%n%Z %C', p: '\\d{5}' },
	MX: { f: '%A%n%D%n%Z %C, %S', r: 'SZ', d: 'neighborhood', s: 'state', p: '\\d{5}' },
	MY: { f: '%A%n%D%n%Z %C%n%S', r: 'SZ', d: 'village_township', s: 'state', p: '\\d{5}' },
	NG: { f: '%A%n%D%n%C %Z%n%S', s: 'state', p: '\\d{6}' },
	NL: { f: '%A%n%Z %C', r: 'Z', p: '\\d{4} ?[A-Z]{2}' },
	NO: { f: '%A%n%Z %C', r: 'Z', p: '\\d{4}' },
	NP: { f: '%A%n%C %Z', p: '\\d{5}' },
	NZ: { f: '%A%n%D%n%C %Z', r: 'Z', d: 'suburb', p: '\\d{4}' },
	PE: { f: '%A%n%C %Z%n%S' },
	PH: { f: '%A%n%D, %C%n%Z %S', s: 'province', p: '\\d{4}' },
	PK: { f: '%A%n%D%n%C-%Z', p: '\\d{5}' },
	PL: { f: '%A%n%Z %C', r: 'Z', p: '\\d{2}-?\\d{3}' },
	PR: { f: '%A%n%C %Z', r: 'Z', z: 'zip', p: '00[679]\\d{2}(?:[ -]\\d{4})?' },
	PT: { f: '%A%n%Z %C', r: 'Z', p: '\\d{4}-?\\d{3}' },
	QA: { f: '%A%n%C' },
	RO: { f: '%A%n%Z %S %C', s: 'county', p: '\\d{6}' },
	RU: { f: '%A%n%C%n%S%n%Z', r: 'SZ', s: 'oblast', p: '\\d{6}' },
	SA: { f: '%A%n%D%n%C %Z', p: '\\d{5}(?:-?\\d{4})?' },
	SE: { f: '%A%n%Z %C', r: 'Z', p: '\\d{3} ?\\d{2}' },
	SG: { f: '%A%n%Z', r: 'Z', p: '\\d{6}' },
	SK: { f: '%A%n%Z %C', r: 'Z', p: '\\d{3} ?\\d{2}' },
	TH: { f: '%A%n%D%n%C%n%S %Z', s: 'province', p: '\\d{5}' },
	TR: { f: '%A%n%Z %C/%S', r: 'SZ', s: 'province', p: '\\d{5}' },
	TW: { f: '%A%n%C, %S %Z', r: 'S', s: 'county', p: '\\d{3}(?:\\d{2,3})?' },
	UA: { f: '%A%n%C%n%S%n%Z', s: 'oblast', p: '\\d{5}' },
	US: { f: '%A%n%C, %S %Z', r: 'SZ', s: 'state', z: 'zip', p: '\\d{5}(?:[ -]\\d{4})?' },
	VN: { f: '%A%n%C%n%S %Z', s: 'province', p: '\\d{5,6}' },
	ZA: { f: '%A%n%D%n%C%n%Z', r: 'Z', d: 'suburb', p: '\\d{4}' },
});

/** Countries without postal codes (Google's address data lists none for them). */
const NO_POSTCODES = new Set(
	(
		'AE AG AO AW BF BI BJ BO BS BW BZ CD CF CG CI CK CM DJ DM ER FJ GA GD GH GM GQ GY HK JM KI KM KN KP LC ML MO MR ' +
		'MW NR NU QA RW SB SC SL SR ST SY TD TG TK TL TO TV UG VU YE ZW'
	).split(' '),
);

/** The letters of a format and the part each stands for (`A` is both street lines). */
const LETTERS = Object.freeze(
	/** @type {Record<string, PlacePart[]>} */ ({
		A: ['line1', 'line2'],
		D: ['area'],
		C: ['city'],
		S: ['region'],
		Z: ['postalCode'],
	}),
);

/**
 * A line of a written address: its parts with the text before each (the first part's is '').
 * @typedef {ReadonlyArray<{ part: PlacePart, before: string }>} FormatLine
 */

/**
 * A country's address format.
 * @typedef {object} AddressFormat
 * @property {string} country the ISO code, or '' for the default
 * @property {ReadonlyArray<PlacePart>} parts the parts the country uses, in its order
 * @property {ReadonlyArray<FormatLine>} lines how an address is written, line by line
 * @property {Readonly<Record<LabeledPart, string>>} labels the label kind of each part whose name differs
 * @property {ReadonlyArray<PlacePart>} required the parts the country requires (region, postal code)
 * @property {boolean} postcodes whether the country has postal codes
 * @property {RegExp | null} postcode the shape of its postal codes, when known
 */

/** @type {Map<string, AddressFormat>} */
const made = new Map();

/** @param {string} format @returns {FormatLine[]} */
const linesOf = (format) =>
	format.split('%n').flatMap((line) => {
		/** @type {Array<{ part: PlacePart, before: string }>} */
		const parts = [];
		let before = '';
		for (const piece of line.split(/(%[A-Z])/)) {
			const letter = /^%([A-Z])$/.exec(piece)?.[1];
			if (!letter) {
				before += piece;
				continue;
			}
			const [first, second] = /** @type {[PlacePart, PlacePart | undefined]} */ (LETTERS[letter]);
			if (second) {
				// the street lines are lines of their own
				return [[{ part: first, before: '' }], [{ part: second, before: '' }]];
			}
			parts.push({ part: first, before: parts.length === 0 ? '' : before });
			before = '';
		}
		return [parts];
	});

/**
 * The address format of a country (ISO 3166-1 alpha-2, any case); an unknown or empty country takes the default.
 * @param {unknown} country
 * @returns {AddressFormat}
 */
export const addressFormat = (country) => {
	const code = typeof country === 'string' ? country.trim().toUpperCase() : '';
	const known = made.get(code);
	if (known) return known;
	const entry = FORMATS[code] ?? { f: DEFAULT_FORMAT };
	const lines = linesOf(entry.f);
	const postcodes = !NO_POSTCODES.has(code) && entry.f.includes('%Z');
	const format = Object.freeze({
		country: isAddressCountry(code) ? code : '',
		parts: Object.freeze(lines.flat().flatMap(({ part }) => (postcodes || part !== 'postalCode' ? [part] : []))),
		lines: Object.freeze(
			lines
				.map((line) => Object.freeze(line.filter(({ part }) => postcodes || part !== 'postalCode')))
				.filter((line) => line.length > 0),
		),
		labels: Object.freeze({
			area: entry.d ?? 'area',
			city: entry.c ?? 'city',
			region: entry.s ?? 'region',
			postalCode: entry.z ?? 'postal',
		}),
		required: Object.freeze(
			/** @type {PlacePart[]} */ ([
				...(entry.r?.includes('S') ? ['region'] : []),
				...(postcodes && entry.r?.includes('Z') ? ['postalCode'] : []),
			]),
		),
		postcodes,
		postcode: postcodes && entry.p ? new RegExp(`^(?:${entry.p})$`, 'i') : null,
	});
	made.set(code, format);
	return format;
};

/**
 * A place part of a form: its label kind (for the parts whose name differs) and whether it must be filled.
 * @typedef {{ part: PlacePart, label: string, required: boolean }} AddressField
 */

/**
 * The place parts a form shows for a country, in the country's order: the parts the country uses, plus those the
 * website requires or always asks (`ask`: for example a region a website lists names for); a postal code never shows
 * where the country has none. A part is required when the website or the country requires it.
 * @param {unknown} country
 * @param {{ required?: ReadonlyArray<string>, ask?: ReadonlyArray<string> }} [website]
 * @returns {AddressField[]}
 */
export const addressFields = (country, { required = [], ask = [] } = {}) => {
	const format = addressFormat(country);
	/** @type {PlacePart[]} */
	const order = [...format.parts];
	for (const part of PLACE_PARTS) {
		if (order.includes(part) || !(required.includes(part) || ask.includes(part))) continue;
		if (part === 'postalCode' && !format.postcodes) continue;
		// a part the country does not use goes after the part it usually follows
		const usual = PLACE_PARTS.indexOf(part);
		const after = order.reduce((last, each, index) => (PLACE_PARTS.indexOf(each) < usual ? index : last), -1);
		order.splice(after + 1, 0, part);
	}
	return order.map((part) => ({
		part,
		label: part in format.labels ? format.labels[/** @type {LabeledPart} */ (part)] : part,
		required: required.includes(part) || format.required.includes(part),
	}));
};

/** @param {unknown} value */
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A postal code as kept: trimmed, upper case, inner spaces single.
 * @param {unknown} value
 */
export const tidyPostcode = (value) => textOf(value).replace(/\s+/g, ' ').toUpperCase();

/**
 * The first place part of an address its country refuses: a required part left empty (`required`), or a postal code
 * not in the country's shape (`postcode`); null when none.
 * @param {Partial<Record<PlacePart | 'country', unknown>>} address
 * @param {{ country?: string, required?: ReadonlyArray<string>, ask?: ReadonlyArray<string> }} [website] `country`:
 *   the country of an address without one
 * @returns {{ part: PlacePart, problem: 'required' | 'postcode' } | null}
 */
export const addressProblem = (address, { country = '', required = [], ask = [] } = {}) => {
	const where = textOf(address.country) || country;
	for (const field of addressFields(where, { required, ask }))
		if (field.required && textOf(address[field.part]) === '') return { part: field.part, problem: 'required' };
	const postcode = tidyPostcode(address.postalCode);
	const shape = addressFormat(where).postcode;
	if (postcode !== '' && shape && !shape.test(postcode)) return { part: 'postalCode', problem: 'postcode' };
	return null;
};

/**
 * An address as its country writes it: the place lines in the country's order, empty parts and lines left out; a part
 * the country does not use is kept on a line of its own after the part it usually follows (never lost).
 * @param {Partial<Record<PlacePart | 'country', unknown>>} address
 * @param {string} [homeCountry] the country of an address without one
 * @returns {string[]}
 */
export const addressLines = (address, homeCountry = '') => {
	const format = addressFormat(textOf(address.country) || homeCountry);
	/** @type {FormatLine[]} */
	const lines = [...format.lines];
	for (const part of PLACE_PARTS) {
		if (format.parts.includes(part)) continue;
		const usual = PLACE_PARTS.indexOf(part);
		const after = lines.reduce(
			(last, line, index) => (line.some((each) => PLACE_PARTS.indexOf(each.part) < usual) ? index : last),
			-1,
		);
		lines.splice(after + 1, 0, [{ part, before: '' }]);
	}
	return lines
		.map((line) => {
			let out = '';
			for (const { part, before } of line) {
				const value = part === 'postalCode' ? tidyPostcode(address[part]) : textOf(address[part]);
				if (value) out += (out ? before || ' ' : '') + value;
			}
			return out;
		})
		.filter(Boolean);
};

/** The countries an address may be in (ISO 3166-1 alpha-2), in code order. */
export const ADDRESS_COUNTRIES = PHONE_COUNTRIES;

const COUNTRY_SET = new Set(ADDRESS_COUNTRIES);

/**
 * Whether a value is the code of a country an address may be in.
 * @param {unknown} code
 * @returns {code is string}
 */
export const isAddressCountry = (code) => typeof code === 'string' && COUNTRY_SET.has(code);

/** @type {Intl.DisplayNames | null | undefined} */
let names;

/**
 * A country's name in US English (`GB` → "United Kingdom"); the value itself when unknown.
 * @param {unknown} code
 */
export const countryName = (code) => {
	const text = textOf(code);
	if (!isAddressCountry(text)) return text;
	if (names === undefined)
		try {
			names = new Intl.DisplayNames(['en-US'], { type: 'region' });
		} catch {
			names = null;
		}
	return names?.of(text) ?? text;
};

/** @type {Map<string, string> | null} */
let byName = null;

/** @param {string} value */
const nameKey = (value) =>
	value
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.toLowerCase();

/**
 * The code of a country given as a code or its US English name, in any letter case (`gb`, `United Kingdom`); null
 * when it names no country.
 * @param {unknown} value
 * @returns {string | null}
 */
export const countryCodeOf = (value) => {
	const text = textOf(value);
	if (isAddressCountry(text.toUpperCase())) return text.toUpperCase();
	if (!byName) byName = new Map(ADDRESS_COUNTRIES.map((code) => [nameKey(countryName(code)), code]));
	return byName.get(nameKey(text)) ?? null;
};

/**
 * The countries as a picker lists them: by US English name.
 * @returns {Array<{ value: string, label: string }>}
 */
export const countryChoices = () =>
	ADDRESS_COUNTRIES.map((code) => ({ value: code, label: countryName(code) })).sort((a, b) =>
		a.label.localeCompare(b.label, 'en-US'),
	);
