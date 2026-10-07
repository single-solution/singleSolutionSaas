/**
 * Identifier formats and domain normalisation.
 *
 * Ids are `<prefix>_<random>` where `<random>` is 128 random bits in lowercase Crockford base32 (26 chars).
 * They are opaque: consumers must never parse meaning out of the random part.
 * @module
 */
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

/** Prefixes of Portal-issued ids. */
export const ID_PREFIXES = Object.freeze({
	website: 'web',
	merchant: 'mer',
	admin: 'adm',
	request: 'req',
});

/** Lowercase Crockford base32 alphabet (no i, l, o, u). */
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Number of random bytes in a generated id. */
export const ID_RANDOM_BYTES = 16;

/**
 * Regular-expression source accepted for ids with the given prefix.
 * @param {string} prefix
 * @returns {string}
 */
export const idPattern = (prefix) => `^${prefix}_[0-9a-z]{10,64}$`;

/**
 * Encode bytes as lowercase Crockford base32 (no padding).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const encodeBase32 = (bytes) => {
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ID_ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += ID_ALPHABET[(buffer << (5 - bits)) & 31];
	return out;
};

/**
 * @callback RandomBytes
 * @param {number} length
 * @returns {Uint8Array}
 */

/** @type {RandomBytes} */
const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * Create a new prefixed opaque id, e.g. `createId('web')` → `web_1k9…`.
 * @param {string} prefix lowercase letters, 2–8 chars
 * @param {{ randomBytes?: RandomBytes }} [options] inject randomness (tests)
 * @returns {string}
 */
export const createId = (prefix, options = {}) => {
	if (!/^[a-z]{2,8}$/.test(prefix)) throw new TypeError(`Invalid id prefix: ${JSON.stringify(prefix)}`);
	const randomBytes = options.randomBytes ?? defaultRandomBytes;
	return `${prefix}_${encodeBase32(randomBytes(ID_RANDOM_BYTES))}`;
};

/**
 * True when `value` is a well-formed id (optionally with the given prefix).
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {value is string}
 */
export const isId = (value, prefix) =>
	typeof value === 'string' && new RegExp(prefix === undefined ? idPattern('[a-z]{2,8}') : idPattern(prefix)).test(value);

/**
 * Split an id into prefix and opaque part; `null` when malformed.
 * @param {unknown} value
 * @returns {{ prefix: string, random: string } | null}
 */
export const parseId = (value) => {
	if (!isId(value)) return null;
	const index = value.indexOf('_');
	return { prefix: value.slice(0, index), random: value.slice(index + 1) };
};

/**
 * @typedef {'invalid_type' | 'empty' | 'invalid_domain' | 'too_long' | 'wildcard' | 'ip_not_allowed' | 'local_not_allowed' | 'single_label' | 'public_suffix'} DomainErrorCode
 */

/**
 * @typedef {{ ok: true, value: string } | { ok: false, code: DomainErrorCode, message: string }} DomainResult
 */

/**
 * @typedef {object} NormaliseDomainOptions
 * @property {boolean} [allowLocal] accept `localhost`, `*.localhost`, IP literals and single-label hosts (development only)
 * @property {(domain: string) => boolean} [isPublicSuffix] optional public-suffix-list predicate; matching domains are rejected
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAIN = 253;

/**
 * @param {DomainErrorCode} code
 * @param {string} message
 * @returns {DomainResult}
 */
const fail = (code, message) => ({ ok: false, code, message });

/**
 * @param {string} ip
 * @param {NormaliseDomainOptions} options
 * @returns {DomainResult}
 */
const ipResult = (ip, options) =>
	options.allowLocal
		? { ok: true, value: ip.toLowerCase() }
		: fail('ip_not_allowed', 'IP addresses are not accepted as website domains.');

/**
 * Normalise user input to a bare ASCII (punycode) hostname: lowercase, no scheme, userinfo, path, query, fragment,
 * port or trailing dot. Rejects IPs, `localhost` and single-label names unless `allowLocal` is set.
 * @param {unknown} input e.g. `HTTPS://Shop.Example.COM:443/path?q`
 * @param {NormaliseDomainOptions} [options]
 * @returns {DomainResult}
 */
export const normaliseDomain = (input, options = {}) => {
	if (typeof input !== 'string') return fail('invalid_type', 'Domain must be a string.');
	let host = input.trim();
	if (host === '') return fail('empty', 'Domain is empty.');
	if (/\s/.test(host)) return fail('invalid_domain', 'Domain must not contain whitespace.');
	host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
	const cut = host.search(/[/?#\\]/);
	if (cut >= 0) host = host.slice(0, cut);
	const at = host.lastIndexOf('@');
	if (at >= 0) host = host.slice(at + 1);
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		const literal = end > 0 ? host.slice(1, end) : '';
		return isIP(literal) === 6 ? ipResult(literal, options) : fail('invalid_domain', 'Malformed IPv6 literal.');
	}
	if (isIP(host) === 6) return ipResult(host, options);
	host = host.replace(/:\d*$/, '');
	if (host.endsWith('.')) host = host.slice(0, -1);
	if (host === '') return fail('empty', 'Domain is empty.');
	if (host.startsWith('*')) return fail('wildcard', 'Wildcards are not accepted; a website is one exact domain.');
	const ascii = domainToASCII(host);
	if (ascii === '') return fail('invalid_domain', 'Not a valid domain name.');
	if (isIP(ascii) !== 0) return ipResult(ascii, options);
	if (ascii.length > MAX_DOMAIN) return fail('too_long', `Domain exceeds ${MAX_DOMAIN} characters.`);
	const labels = ascii.split('.');
	if (!labels.every((label) => LABEL.test(label)))
		return fail('invalid_domain', 'Domain labels must be 1–63 letters, digits or hyphens.');
	if (ascii === 'localhost' || ascii.endsWith('.localhost')) {
		return options.allowLocal ? { ok: true, value: ascii } : fail('local_not_allowed', 'Local hostnames are not accepted.');
	}
	if (labels.length < 2 && !options.allowLocal) return fail('single_label', 'Domain must have at least two labels.');
	if (options.isPublicSuffix?.(ascii)) return fail('public_suffix', 'A public suffix cannot be registered as a website domain.');
	return { ok: true, value: ascii };
};

/**
 * True when `host` and `domain` normalise to the same domain (exact match only: a website is one exact domain).
 * @param {string} host
 * @param {string} domain
 * @param {{ allowLocal?: boolean }} [options]
 * @returns {boolean}
 */
export const hostMatchesDomain = (host, domain, options = {}) => {
	const allowLocal = options.allowLocal ?? false;
	const h = normaliseDomain(host, { allowLocal });
	const d = normaliseDomain(domain, { allowLocal });
	return h.ok && d.ok && h.value === d.value;
};
