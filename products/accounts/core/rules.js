/**
 * Sign-in rules (PLAN 0.8.6), pure: one-time codes, password rules, risk checks, return addresses, devices and the
 * sign-up rules.
 * @module
 */
import { emailDomain } from './identifiers.js';

// ------------------------------------------------------------------------------------------------- one-time codes

/**
 * Wrong tries a two-step step or a staff sign-in code allows before it is spent (code constant). Codes sent by email
 * or phone take theirs from the website's settings (`codeTries`, A9).
 */
export const CODE_ATTEMPTS = 5;
/** Days the trace of a setup link is kept after the link's end, so a setup page can still tell why it no longer works. */
export const SETUP_TRACE_DAYS = 30;

/**
 * @typedef {{ status: 'valid', until: Date } | { status: 'expired' | 'used' | 'canceled' | 'invalid' }} SetupLinkState
 */

/**
 * The state of a setup link as a setup page may learn it (A3, A5), from what Accounts keeps of a link whose code
 * matched: its live record (null once it was used, replaced or removed, or past its end) and its trace (null for a link
 * made before traces were kept). The trace says `used` or `canceled` (a newer link replaced it, or staff declined its
 * request); past its end the link is `expired`; a link gone without a trace saying why is `canceled` (for example its
 * user was removed). Neither: `invalid` (an unknown or wrong code).
 * @param {{ live: { expireAt: Date } | null, trace: { data: Record<string, any> } | null, now: number }} input
 * @returns {SetupLinkState}
 */
export const setupLinkState = ({ live, trace, now }) => {
	if (!trace) return live ? { status: 'valid', until: live.expireAt } : { status: 'invalid' };
	const state = trace.data.state;
	if (state === 'used' || state === 'canceled') return { status: state };
	const until = new Date(trace.data.validUntil);
	if (until.getTime() <= now) return { status: 'expired' };
	return live ? { status: 'valid', until } : { status: 'canceled' };
};

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

/** Longest password accepted (the `maxLength` settings may lower it, down to 128; ST-26). */
const PASSWORD_MAX = 256;
/** Personal words shorter than this are not refused (PLAN 0.8.10 A9). */
const MIN_PERSONAL_WORD = 4;
/** A run this long of keyboard, number or alphabet steps is refused (A9, A10). */
const STEP_RUN = 4;
/**
 * The letter rows of the usual keyboard layouts, each read both ways (A10): QWERTY, AZERTY, QWERTZ, Dvorak, Turkish Q,
 * Russian ЙЦУКЕН, Ukrainian, Greek, Hebrew, Arabic and Persian. Digits of every script and runs of the alphabet
 * (consecutive letters, `abcd`, `абвг`, `αβγδ`) are found without rows (`hasSequence`).
 */
const STEP_ROWS = Object.freeze([
	'qwertyuiop',
	'asdfghjkl',
	'zxcvbnm',
	'azertyuiop',
	'qsdfghjklm',
	'wxcvbn',
	'qwertzuiop',
	'yxcvbnm',
	'pyfgcrl',
	'aoeuidhtns',
	'qjkxbmwvz',
	'ertyuıopğü',
	'asdfghjklşi',
	'zxcvbnmöç',
	'йцукенгшщзхъ',
	'фывапролджэ',
	'ячсмитьбю',
	'йцукенгшщзхї',
	'фівапролджє',
	'ςερτυθιοπ',
	'ασδφγηξκλ',
	'ζχψωβνμ',
	'קראטוןםפ',
	'שדגכעיחלךף',
	'זסבהנמצתץ',
	'ضصثقفغعهخحجد',
	'شسيبلاتنمكط',
	'ئءؤرلاىةوزظ',
	'ضصثقفغعهخحجچ',
	'شسیبلاتنمکگ',
	'ظطزرذدپو',
]);

/**
 * The value of a decimal digit of any script (`7`, `٧`, `۷`, `७`, `７` …), or -1: Unicode encodes each script's digits
 * 0 to 9 in a row, so the digits before it in its row give its value.
 * @param {string} char one code point
 */
const digitValue = (char) => {
	if (!/^\p{Nd}$/u.test(char)) return -1;
	let point = /** @type {number} */ (char.codePointAt(0));
	let value = 0;
	while (/^\p{Nd}$/u.test(String.fromCodePoint(point - 1))) {
		point -= 1;
		value += 1;
	}
	return value % 10;
};

/**
 * Whether a run of `STEP_RUN` characters steps by one, up or down: digits of any script by their value (`1234`,
 * `٤٣٢١`), letters by their place in the alphabet (`abcd`, `абвг`, `zyxw`).
 * @param {string[]} chars
 */
const hasSequence = (chars) => {
	/** @param {string} char */
	const rank = (char) => {
		const digit = digitValue(char);
		return digit >= 0 ? digit : /^\p{L}$/u.test(char) ? /** @type {number} */ (char.codePointAt(0)) : NaN;
	};
	for (let at = 0; at + STEP_RUN <= chars.length; at += 1) {
		const ranks = chars.slice(at, at + STEP_RUN).map(rank);
		const step = Number(ranks[1]) - Number(ranks[0]);
		if ((step === 1 || step === -1) && ranks.every((value, i) => i === 0 || value - Number(ranks[i - 1]) === step)) return true;
	}
	return false;
};

/**
 * Whether a password holds a run of `STEP_RUN` keyboard, number or alphabet steps (`qwer`, `azer`, `йцук`, `1234`,
 * `٤٣٢١`, `abcd`).
 * @param {string} password
 */
const hasStepRun = (password) => {
	const chars = [...password.toLowerCase()];
	if (hasSequence(chars)) return true;
	for (let at = 0; at + STEP_RUN <= chars.length; at += 1) {
		const run = chars.slice(at, at + STEP_RUN).join('');
		if (STEP_ROWS.some((row) => row.includes(run) || [...row].reverse().join('').includes(run))) return true;
	}
	return false;
};

/**
 * The words of the user's name and of their email address's local part (at least 4 characters each).
 * @param {{ name?: string | null, email?: string | null }} who
 */
const personalWords = ({ name, email }) =>
	[String(name ?? ''), String(email ?? '').split('@')[0] ?? '']
		.flatMap((text) => [text.toLowerCase(), ...text.toLowerCase().split(/[^\p{L}\p{N}]+/u)])
		.filter((word) => [...word].length >= MIN_PERSONAL_WORD);

/**
 * Why a new password is refused, or null: `too_short`, `too_long` (beyond `maxLength`, at most 256), `letter_and_digit`
 * (A2, ST-26: a letter and a digit are required) or `personal` (A9, A10: it holds the name, the email's local part, or a
 * run of 4 keyboard, number or alphabet steps in any of the usual layouts and scripts). The breached-password check
 * runs in adapters.
 * @param {unknown} password
 * @param {{ minLength: number, maxLength?: number, letterAndDigit?: boolean,
 *   personal?: { name?: string | null, email?: string | null } | null }} rules
 * @returns {'too_short' | 'too_long' | 'letter_and_digit' | 'personal' | null}
 */
export const passwordProblem = (password, { minLength, maxLength = PASSWORD_MAX, letterAndDigit = false, personal = null }) => {
	if (typeof password !== 'string' || [...password].length < minLength) return 'too_short';
	if (password.length > Math.min(maxLength, PASSWORD_MAX)) return 'too_long';
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

// ---------------------------------------------------------------------------------------------- new phone users

/**
 * The name a new phone-code user gets without one (A7): the `newUserName` setting with `{last4}` filled in.
 * @param {string} template
 * @param {string} phone E.164
 */
export const newUserNameOf = (template, phone) => template.replaceAll('{last4}', phone.slice(-4)).trim().slice(0, 120);

// -------------------------------------------------------------------------------------------------- risk checks

/** Common disposable email domains (the merchant adds their own in Settings). */
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
 * port), of one of the merchant's other hosts listed for it (K-27: reset links to an admin on its own host), or a local
 * page for testing (PLAN 0.8.1). Returns the URL without its fragment, or null.
 * @param {unknown} url
 * @param {string} domain
 * @param {ReadonlyArray<unknown>} [hosts] the merchant's other host names
 * @returns {string | null}
 */
export const returnAddress = (url, domain, hosts = []) => {
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
	const listed = (/** @type {unknown} */ host) => String(host).toLowerCase().replace(/\.$/, '') === parsed.hostname;
	const own = parsed.protocol === 'https:' && parsed.port === '' && (parsed.hostname === domain || hosts.some(listed));
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
