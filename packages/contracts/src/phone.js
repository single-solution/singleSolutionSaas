/**
 * Phone numbers (PLAN 0.8.10, always): one normaliser for every product, so a person typing their number in any usual
 * way gets one E.164 number (`+`, the country calling code and the national significant number) and one record. Pure
 * and browser-safe: products' `core/` and widgets use it through `@ss/contracts/phone`.
 *
 * Rules, for any country:
 *
 * - spaces, dashes, dots, slashes and brackets are dropped; one `+` may lead; `00` leads like `+`;
 * - a number with `+` or `00` names its calling code (an assigned country code; non-geographic codes are refused);
 * - a number without them needs the website's default calling code (a setting, else the business.json country,
 *   `websiteCallingCode`); without one it is refused, as the product never guesses a country. Such a number may be:
 *   1. already international without the `+` (it starts with the calling code's digits and the rest has a national
 *      length): kept, not prefixed again (`923001234567` with +92);
 *   2. national with the trunk prefix (`0`, Russia and Kazakhstan `8`, or the website's own): the prefix is dropped
 *      (`03001234567`);
 *   3. national without it (`3001234567`). The first reading that fits wins; where national numbers keep their 0
 *      (no trunk prefix: Italy …) reading 3 comes before reading 1, as such numbers may start with the code's digits;
 * - right after a calling code a trunk `0` (also written `(0)`) is dropped (`+92 0300 …`, `+44 (0)20 …`), except
 *   where national numbers keep their 0 (`+39 06 …`);
 * - the result has 8–15 digits, and the national number fits the country's lengths where they are listed
 *   (`NATIONAL_LENGTHS`, from the ITU-T E.164 national numbering plans) and does not start with 0 unless the country
 *   keeps it. Anything else is refused (null).
 * @module
 */

/** ISO 3166-1 alpha-2 country → its calling code (NANP countries share 1, Russia and Kazakhstan 7). */
const CALLING_CODES = Object.freeze(
	Object.fromEntries(
		(
			'AD376 AE971 AF93 AG1 AI1 AL355 AM374 AO244 AR54 AS1 AT43 AU61 AW297 AX358 AZ994 BA387 BB1 BD880 BE32 BF226 ' +
			'BG359 BH973 BI257 BJ229 BL590 BM1 BN673 BO591 BQ599 BR55 BS1 BT975 BW267 BY375 BZ501 CA1 CC61 CD243 CF236 ' +
			'CG242 CH41 CI225 CK682 CL56 CM237 CN86 CO57 CR506 CU53 CV238 CW599 CX61 CY357 CZ420 DE49 DJ253 DK45 DM1 DO1 ' +
			'DZ213 EC593 EE372 EG20 EH212 ER291 ES34 ET251 FI358 FJ679 FK500 FM691 FO298 FR33 GA241 GB44 GD1 GE995 GF594 ' +
			'GG44 GH233 GI350 GL299 GM220 GN224 GP590 GQ240 GR30 GT502 GU1 GW245 GY592 HK852 HN504 HR385 HT509 HU36 ID62 ' +
			'IE353 IL972 IM44 IN91 IO246 IQ964 IR98 IS354 IT39 JE44 JM1 JO962 JP81 KE254 KG996 KH855 KI686 KM269 KN1 KP850 ' +
			'KR82 KW965 KY1 KZ7 LA856 LB961 LC1 LI423 LK94 LR231 LS266 LT370 LU352 LV371 LY218 MA212 MC377 MD373 ME382 ' +
			'MF590 MG261 MH692 MK389 ML223 MM95 MN976 MO853 MP1 MQ596 MR222 MS1 MT356 MU230 MV960 MW265 MX52 MY60 MZ258 ' +
			'NA264 NC687 NE227 NF672 NG234 NI505 NL31 NO47 NP977 NR674 NU683 NZ64 OM968 PA507 PE51 PF689 PG675 PH63 PK92 ' +
			'PL48 PM508 PR1 PS970 PT351 PW680 PY595 QA974 RE262 RO40 RS381 RU7 RW250 SA966 SB677 SC248 SD249 SE46 SG65 ' +
			'SH290 SI386 SJ47 SK421 SL232 SM378 SN221 SO252 SR597 SS211 ST239 SV503 SX1 SY963 SZ268 TC1 TD235 TG228 TH66 ' +
			'TJ992 TK690 TL670 TM993 TN216 TO676 TR90 TT1 TV688 TW886 TZ255 UA380 UG256 US1 UY598 UZ998 VA39 VC1 VE58 VG1 ' +
			'VI1 VN84 VU678 WF681 WS685 XK383 YE967 YT262 ZA27 ZM260 ZW263'
		)
			.split(' ')
			.map((entry) => [entry.slice(0, 2), entry.slice(2)]),
	),
);

/** The countries a phone setting may name (ISO 3166-1 alpha-2), in alphabetical order. */
export const PHONE_COUNTRIES = Object.freeze(Object.keys(CALLING_CODES));

/** Every assigned country calling code (they are prefix-free: no code starts another). */
const CODES = new Set(Object.values(CALLING_CODES));

/**
 * Calling codes whose national numbers may start with 0 (no trunk prefix): Italy and the Vatican, San Marino, Côte
 * d'Ivoire, Benin, Gabon and the Republic of the Congo.
 */
const KEEPS_ZERO = new Set(['39', '378', '225', '229', '241', '242']);

/** Trunk prefixes other than 0. */
const TRUNKS = Object.freeze(/** @type {Record<string, string>} */ ({ 7: '8' }));

/**
 * Lengths [shortest, longest] of national significant numbers (landlines and mobiles) where the plan is settled; any
 * other country only keeps the E.164 total of 8–15 digits.
 */
const NATIONAL_LENGTHS = Object.freeze(
	Object.fromEntries(
		(
			'1:10 7:10 20:8-10 27:9 30:10 31:9 32:8-9 33:9 34:9 36:8-9 39:6-11 40:9 41:9 44:9-10 45:8 47:8 48:9 51:8-9 ' +
			'52:10 54:10-11 55:10-11 56:9 57:10 58:10 60:8-10 61:9 62:7-12 63:8-10 64:8-10 65:8 66:8-9 81:9-10 82:8-10 ' +
			'84:9-10 86:10-11 90:10 91:10 92:9-10 93:9 94:9 98:10 212:9 213:8-9 216:8 225:10 233:9 242:9 255:9 256:9 ' +
			'351:9 353:7-9 380:9 420:9 421:9 852:8 853:8 886:8-9 960:7 961:7-8 962:8-9 965:8 966:9 968:8 971:8-9 972:8-9 ' +
			'973:8 974:8 977:8-10'
		)
			.split(' ')
			.map((entry) => {
				const [code = '', lengths = ''] = entry.split(':');
				const [low = '', high = low] = lengths.split('-');
				return /** @type {[string, [number, number]]} */ ([code, [Number(low), Number(high)]]);
			}),
	),
);

/** Longest text taken as a phone number. */
const MAX_INPUT = 40;
const PHONE_CHARACTERS = /^\+?[\d\s()./-]+$/;
const TRUNK = /^\d{1,2}$/;

/**
 * The calling code of a country, as `+92`, or '' for an unknown country.
 * @param {unknown} country ISO 3166-1 alpha-2 (any case)
 */
export const callingCodeOf = (country) => {
	const code = typeof country === 'string' ? CALLING_CODES[country.toUpperCase()] : undefined;
	return code === undefined ? '' : `+${code}`;
};

/**
 * The digits of an assigned calling code given as `+92` or `92`, or ''.
 * @param {unknown} value
 */
const codeDigits = (value) => {
	const digits = typeof value === 'string' ? value.trim().replace(/^\+/, '') : '';
	return CODES.has(digits) ? digits : '';
};

/**
 * A website's default calling code: its phone setting when that is an assigned code, else the calling code of its
 * business.json country, else '' (national numbers are then refused).
 * @param {unknown} setting `+92`, `92` or ''
 * @param {unknown} [country] business.json `country`
 */
export const websiteCallingCode = (setting, country) => {
	const digits = codeDigits(setting);
	return digits === '' ? callingCodeOf(country) : `+${digits}`;
};

/**
 * The calling code at the start of international digits, or ''.
 * @param {string} digits
 */
const leadingCode = (digits) => [1, 2, 3].map((n) => digits.slice(0, n)).find((code) => CODES.has(code)) ?? '';

/**
 * The national number after a calling code, without a trunk 0 where the country has one.
 * @param {string} code @param {string} rest
 */
const afterCode = (code, rest) => (rest.startsWith('0') && !KEEPS_ZERO.has(code) ? rest.slice(1) : rest);

/**
 * The E.164 number, or null when the national number cannot belong to the calling code.
 * @param {string} code @param {string} national
 * @returns {string | null}
 */
const e164 = (code, national) => {
	const total = code.length + national.length;
	const lengths = NATIONAL_LENGTHS[code];
	const fits = lengths ? national.length >= lengths[0] && national.length <= lengths[1] : true;
	const leadingZero = national.startsWith('0') && !KEEPS_ZERO.has(code);
	return total >= 8 && total <= 15 && fits && !leadingZero ? `+${code}${national}` : null;
};

/**
 * A phone number as E.164, or null when it cannot be one.
 * @param {unknown} input as typed
 * @param {string | { defaultCallingCode?: string, trunkPrefix?: string }} [options] the website's default calling code
 *   (`+92`; see `websiteCallingCode`), or that and its trunk prefix (1–2 digits; '' = the country's usual one: 0, 8 for
 *   +7, none where national numbers keep their 0)
 * @returns {string | null}
 */
export const normalisePhone = (input, options = {}) => {
	if (typeof input !== 'string') return null;
	const raw = input.trim();
	if (raw.length === 0 || raw.length > MAX_INPUT || !PHONE_CHARACTERS.test(raw)) return null;
	const digits = raw.replace(/\D/g, '');
	if (raw.startsWith('+') || digits.startsWith('00')) {
		const international = raw.startsWith('+') ? digits : digits.slice(2);
		const code = leadingCode(international);
		return code === '' ? null : e164(code, afterCode(code, international.slice(code.length)));
	}
	const { defaultCallingCode = '', trunkPrefix = '' } = typeof options === 'string' ? { defaultCallingCode: options } : options;
	const code = codeDigits(defaultCallingCode);
	if (code === '') return null;
	const trunk = TRUNK.test(trunkPrefix) ? trunkPrefix : KEEPS_ZERO.has(code) ? '' : (TRUNKS[code] ?? '0');
	const international = digits.startsWith(code) ? afterCode(code, digits.slice(code.length)) : null;
	const trunked = trunk !== '' && digits.startsWith(trunk) ? digits.slice(trunk.length) : null;
	const readings = KEEPS_ZERO.has(code) ? [trunked, digits, international] : [international, trunked, digits];
	return readings.map((national) => (national === null ? null : e164(code, national))).find((found) => found !== null) ?? null;
};

/**
 * Whether an E.164 number belongs to one of the countries ([] = any; NANP countries share +1).
 * @param {string} phone E.164
 * @param {ReadonlyArray<string>} countries ISO 3166-1 alpha-2
 */
export const phoneInCountries = (phone, countries) =>
	countries.length === 0 || countries.some((country) => phone.startsWith(callingCodeOf(country) || 'x'));
