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

/**
 * Why a new password is refused (`too_short`, `too_long`), or null. The breached-password check runs in adapters.
 * @param {unknown} password
 * @param {{ minLength: number }} rules
 * @returns {'too_short' | 'too_long' | null}
 */
export const passwordProblem = (password, { minLength }) => {
	if (typeof password !== 'string' || [...password].length < minLength) return 'too_short';
	return password.length > PASSWORD_MAX ? 'too_long' : null;
};

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
