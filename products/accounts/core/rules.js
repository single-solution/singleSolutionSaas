/**
 * Sign-in rules (PLAN 0.8.6), pure: one-time codes, password rules, risk checks, return addresses, devices and the
 * sign-up rules.
 * @module
 */
import { emailDomain } from './identifiers.js';

// ------------------------------------------------------------------------------------------------- one-time codes

/** Wrong tries a code allows before it is spent (code constant). */
export const CODE_ATTEMPTS = 5;
/** Seconds before the same address can get a new code (code constant protecting the merchant's provider). */
export const CODE_COOLDOWN_SECONDS = 30;
/** Codes per address per hour (code constant). */
export const CODES_PER_HOUR = 6;

/**
 * A numeric code of `length` digits from random bytes, without modulo bias.
 * @param {{ length: number, randomBytes: (n: number) => Uint8Array }} input
 */
export const generateCode = ({ length, randomBytes }) => {
	let out = '';
	while (out.length < length)
		for (const byte of randomBytes(length * 2)) {
			if (byte < 250) out += String(byte % 10);
			if (out.length === length) break;
		}
	return out;
};

/**
 * What the user typed as a code (spaces and dashes ignored), or null when it cannot be one.
 * @param {unknown} input
 * @param {number} length
 */
export const normaliseCode = (input, length) => {
	if (typeof input !== 'string' || input.length > 32) return null;
	const value = input.replace(/[\s-]/g, '');
	return new RegExp(`^\\d{${length}}$`).test(value) ? value : null;
};

// ----------------------------------------------------------------------------------------------------- passwords

/** Longest password accepted (code constant). */
const PASSWORD_MAX = 256;
/** Personal words shorter than this are not refused (PLAN 0.8.10 A9). */
const MIN_PERSONAL_WORD = 4;
/** A run this long of keyboard or number steps is refused (A9). */
const STEP_RUN = 4;
/** Keyboard rows and the digits, each read both ways (A9). */
const STEP_ROWS = Object.freeze(['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']);

/**
 * Whether a password holds a run of `STEP_RUN` keyboard or number steps (`1234`, `4321`, `qwer`, `lkjh`).
 * @param {string} password
 */
const hasStepRun = (password) => {
	const lower = password.toLowerCase();
	for (let at = 0; at + STEP_RUN <= lower.length; at += 1) {
		const run = lower.slice(at, at + STEP_RUN);
		if (STEP_ROWS.some((row) => row.includes(run) || [...row].reverse().join('').includes(run))) return true;
	}
	return false;
};

/**
 * The words of the user's name and of their e-mail address's local part (at least 4 characters each).
 * @param {{ name?: string | null, email?: string | null }} who
 */
const personalWords = ({ name, email }) =>
	[String(name ?? ''), String(email ?? '').split('@')[0] ?? '']
		.flatMap((text) => [text.toLowerCase(), ...text.toLowerCase().split(/[^\p{L}\p{N}]+/u)])
		.filter((word) => [...word].length >= MIN_PERSONAL_WORD);

/**
 * Why a new password is refused, or null: `too_short`, `too_long`, `letter_and_digit` (A2: a letter and a digit are
 * required) or `personal` (A9: it holds the name, the e-mail's local part, or a run of 4 keyboard or number steps). The
 * breached-password check runs in adapters.
 * @param {unknown} password
 * @param {{ minLength: number, letterAndDigit?: boolean, personal?: { name?: string | null, email?: string | null } | null }} rules
 * @returns {'too_short' | 'too_long' | 'letter_and_digit' | 'personal' | null}
 */
export const passwordProblem = (password, { minLength, letterAndDigit = false, personal = null }) => {
	if (typeof password !== 'string' || [...password].length < minLength) return 'too_short';
	if (password.length > PASSWORD_MAX) return 'too_long';
	if (letterAndDigit && !(/\p{L}/u.test(password) && /\p{N}/u.test(password))) return 'letter_and_digit';
	if (personal) {
		const lower = password.toLowerCase();
		if (hasStepRun(password) || personalWords(personal).some((word) => lower.includes(word))) return 'personal';
	}
	return null;
};

/** The longest growing lock, in minutes (A9). */
const GROWING_LOCK_MAX_MINUTES = 60;

/**
 * The lock state after a wrong password (A9). `fixed`: once `maxAttempts` failures add up, a lock of `lockMinutes`, and
 * the count starts again. `growing`: `maxAttempts` failures pass, then each further failure locks for twice as long as
 * the one before, from 1 minute up to 60.
 * @param {{ failures: number, maxAttempts: number, lockMinutes: number, lockMode: string, now: number }} input
 *   `failures`: the failures so far, this one included
 * @returns {{ failedLogins: number, lockedUntil: Date | null, lockLevel: number }}
 */
export const lockAfter = ({ failures, maxAttempts, lockMinutes, lockMode, now }) => {
	if (lockMode === 'growing') {
		const level = failures - maxAttempts;
		return level > 0
			? {
					failedLogins: failures,
					lockLevel: level,
					lockedUntil: new Date(now + Math.min(GROWING_LOCK_MAX_MINUTES, 2 ** (level - 1)) * 60_000),
				}
			: { failedLogins: failures, lockLevel: 0, lockedUntil: null };
	}
	return failures >= maxAttempts
		? { failedLogins: 0, lockLevel: 0, lockedUntil: new Date(now + lockMinutes * 60_000) }
		: { failedLogins: failures, lockLevel: 0, lockedUntil: null };
};

// ---------------------------------------------------------------------------------------------- phone countries

/** ISO 3166-1 alpha-2 country → its calling code (A7; NANP countries share 1, Russia and Kazakhstan 7). */
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

/** The country codes `countries` settings may name. */
export const COUNTRIES = Object.freeze(Object.keys(CALLING_CODES));

/**
 * Whether an E.164 number's calling code belongs to one of the countries (A7; [] = any).
 * @param {string} phone E.164
 * @param {ReadonlyArray<string>} countries ISO codes
 */
export const phoneCountryAllowed = (phone, countries) =>
	countries.length === 0 || countries.some((country) => phone.startsWith(`+${CALLING_CODES[country] ?? 'x'}`));

/**
 * The name a new phone-code user gets without one (A7): the `newUserName` setting with `{last4}` filled in.
 * @param {string} template
 * @param {string} phone E.164
 */
export const newUserNameOf = (template, phone) => template.replaceAll('{last4}', phone.slice(-4)).trim().slice(0, 120);

// -------------------------------------------------------------------------------------------------- risk checks

/** Common disposable e-mail domains (the merchant adds their own in Settings). */
const DISPOSABLE_DOMAINS = Object.freeze([
	'10minutemail.com',
	'discard.email',
	'dispostable.com',
	'fakeinbox.com',
	'getnada.com',
	'guerrillamail.com',
	'mailinator.com',
	'maildrop.cc',
	'mintemail.com',
	'mohmal.com',
	'sharklasers.com',
	'temp-mail.org',
	'tempmail.com',
	'throwawaymail.com',
	'trashmail.com',
	'yopmail.com',
]);

/**
 * Whether an address's domain (or a parent domain) is refused.
 * @param {string} email canonical address
 * @param {{ blockDisposable: boolean, blockedDomains: ReadonlyArray<string> }} rules
 */
export const emailRefused = (email, { blockDisposable, blockedDomains }) => {
	const domain = emailDomain(email);
	return [...blockedDomains, ...(blockDisposable ? DISPOSABLE_DOMAINS : [])].some((entry) => {
		const d = String(entry).trim().toLowerCase().replace(/^\.+/, '');
		return d.length > 0 && (domain === d || domain.endsWith(`.${d}`));
	});
};

// -------------------------------------------------------------------------------------------- return addresses

const LOCAL_HOSTS = /^(?:localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Whether links and sign-in redirects may return to `url`: a page of the website's exact domain over https (default
 * port), or a local page for testing (PLAN 0.8.1). Returns the URL without its fragment, or null.
 * @param {unknown} url
 * @param {string} domain
 * @returns {string | null}
 */
export const returnAddress = (url, domain) => {
	if (typeof url !== 'string' || url.length > 2048) return null;
	/** @type {URL} */
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.username || parsed.password) return null;
	const local = LOCAL_HOSTS.test(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
	const own = parsed.protocol === 'https:' && parsed.hostname === domain && parsed.port === '';
	if (!local && !own) return null;
	parsed.hash = '';
	return parsed.toString();
};

// ------------------------------------------------------------------------------------------------------- devices

const BROWSERS = /** @type {const} */ ([
	['Edge', /\bEdg(?:e|A|iOS)?\//],
	['Opera', /\bOPR\/|\bOpera\b/],
	['Samsung Internet', /\bSamsungBrowser\//],
	['Firefox', /\bFirefox\/|\bFxiOS\//],
	['Chrome', /\bChrome\/|\bCriOS\//],
	['Safari', /\bSafari\//],
]);
const SYSTEMS = /** @type {const} */ ([
	['iOS', /\biPhone|\biPad|\biPod/],
	['Android', /\bAndroid\b/],
	['Windows', /\bWindows\b/],
	['macOS', /\bMac OS X\b|\bMacintosh\b/],
	['ChromeOS', /\bCrOS\b/],
	['Linux', /\bLinux\b/],
]);

/**
 * A coarse device name for the device list (never the raw user agent).
 * @param {unknown} userAgent
 */
export const deviceOf = (userAgent) => {
	const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
	const browser = BROWSERS.find(([, pattern]) => pattern.test(ua))?.[0] ?? 'Unknown browser';
	const os = SYSTEMS.find(([, pattern]) => pattern.test(ua))?.[0] ?? 'Unknown system';
	return `${browser} on ${os}`;
};

/**
 * The device id the widget keeps in the browser (risk checks), or null.
 * @param {unknown} value
 */
export const deviceIdOf = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null);

// ---------------------------------------------------------------------------------------------- sign-up rules

/**
 * @typedef {object} SignUpRules
 * @property {'open' | 'invite' | 'approval'} mode
 * @property {Array<'name' | 'email' | 'phone'>} requiredFields
 */

/** Without the Approval / invite sign-up feature: open sign-up, nothing more required. @type {SignUpRules} */
export const OPEN_SIGN_UP = Object.freeze({ mode: 'open', requiredFields: [] });
