/**
 * Outbound policy (pure): which URLs and hosts may be contacted, before any DNS resolution. The address check runs
 * again on every resolved answer at connect time (`lookup.js`), so a rebinding DNS answer cannot slip through.
 *
 * Rules for hosts **not** on the allowlist:
 * - `https:` only; explicit ports only 443 and 8443; no userinfo.
 * - IP literals must be public unicast addresses (see `address.js`).
 * - Names must be syntactically valid DNS names with at least two labels; `localhost` and the internal suffixes
 *   (`.localhost`, `.local`, `.internal`, `.home.arpa`, `.localdomain`, `.lan`, `.intranet`, `.corp`) are refused, and a
 *   numeric last label (an IPv4 spelling in disguise, e.g. `0x7f.1`) must be a canonical public dotted quad.
 *
 * Allowlisted hosts (exact host names or IP literals — meant for development) may use `http:`, any port, and private
 * addresses. An allowlisted IP literal also admits that address when a non-allowlisted name resolves to it.
 *
 * `safeFetch` follows at most 3 redirects, each to the same scheme, host and port; one call has 10 seconds and a 1 MiB
 * body unless the call sets its own `timeoutMs` and `maxBytes`.
 * @module
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { classifyAddress } from './address.js';

/** @typedef {{ address: string, family: number }} ResolvedAddress */
/** @typedef {(hostname: string, options: { family?: number }) => Promise<ReadonlyArray<ResolvedAddress>>} Resolver */

/**
 * @typedef {object} OutboundPolicyOptions
 * @property {ReadonlyArray<string>} [allowHosts] exact host names / IP literals admitted despite the rules (development)
 * @property {Resolver} [resolve] DNS resolver returning every address (default `dns.lookup` with `all`, `verbatim`)
 * @property {string} [userAgent] default `user-agent` request header (default `ss-net/1`)
 */

/** @typedef {Readonly<{ allowHosts: ReadonlySet<string>, resolve: Resolver, userAgent: string }>} OutboundPolicy */

/**
 * @typedef {{ ok: true, host: string, ip: boolean, allowlisted: boolean }
 *   | { ok: false, code: 'bad_url' | 'ssrf_blocked', reason: string }} HostCheck
 */
/**
 * @typedef {{ ok: true, url: URL, host: string, port: number, ip: boolean, allowlisted: boolean }
 *   | { ok: false, code: 'bad_url' | 'ssrf_blocked', reason: string }} UrlCheck
 */

/** Ports allowed for hosts not on the allowlist. */
const PORTS = new Set([443, 8443]);
/** Overall deadline of one `safeFetch` call, redirects included, unless the call sets `timeoutMs`. */
export const TIMEOUT_MS = 10_000;
/** Response body cap of one `safeFetch` call unless the call sets `maxBytes`. */
export const MAX_BYTES = 1024 * 1024;
/** Redirects `safeFetch` follows, each to the same scheme, host and port. */
export const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 4096;

/** Name suffixes that only resolve inside a network. */
const INTERNAL_SUFFIXES = Object.freeze([
	'localhost',
	'local',
	'internal',
	'home.arpa',
	'localdomain',
	'lan',
	'intranet',
	'corp',
]);

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** @type {Resolver} */
const defaultResolve = (hostname, { family } = {}) =>
	dnsLookup(hostname, { all: true, verbatim: true, ...(family === 4 || family === 6 ? { family } : {}) });

/**
 * Lower-case a host, strip IPv6 brackets and a trailing dot.
 * @param {string} host
 * @returns {string}
 */
export const normaliseHost = (host) => {
	const h = host.trim().toLowerCase().replace(/\.$/, '');
	return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
};

/**
 * Create an immutable outbound policy.
 * @param {OutboundPolicyOptions} [options]
 * @returns {OutboundPolicy}
 */
export const createOutboundPolicy = ({ allowHosts = [], resolve = defaultResolve, userAgent = 'ss-net/1' } = {}) => {
	if (!Array.isArray(allowHosts) || allowHosts.some((h) => typeof h !== 'string'))
		throw new TypeError('allowHosts must be an array of strings');
	if (typeof resolve !== 'function') throw new TypeError('resolve must be a function');
	return Object.freeze({
		allowHosts: new Set(allowHosts.map(normaliseHost).filter((h) => h !== '')),
		resolve,
		userAgent: String(userAgent),
	});
};

/**
 * Is a host (or IP) on the policy allowlist?
 * @param {OutboundPolicy} policy
 * @param {string} host
 * @returns {boolean}
 */
export const isAllowlisted = (policy, host) => {
	const h = normaliseHost(host);
	if (policy.allowHosts.has(h)) return true;
	const ip = classifyAddress(h);
	return ip.address !== null && policy.allowHosts.has(ip.address);
};

/**
 * @param {string} reason
 * @returns {{ ok: false, code: 'ssrf_blocked', reason: string }}
 */
const blocked = (reason) => ({ ok: false, code: 'ssrf_blocked', reason });
/**
 * @param {string} reason
 * @returns {{ ok: false, code: 'bad_url', reason: string }}
 */
const bad = (reason) => ({ ok: false, code: 'bad_url', reason });

/**
 * Check a destination host (name or IP literal) before resolution.
 * @param {unknown} rawHost
 * @param {OutboundPolicy} policy
 * @returns {HostCheck}
 */
export const checkHost = (rawHost, policy) => {
	if (typeof rawHost !== 'string' || rawHost.trim() === '' || rawHost.length > 253) return bad('invalid_host');
	const host = normaliseHost(rawHost);
	const ip = classifyAddress(host);
	const allowlisted = isAllowlisted(policy, host);
	if (allowlisted) return { ok: true, host: ip.address ?? host, ip: ip.family !== null, allowlisted };
	if (ip.family === 6 || (ip.family === 4 && ip.canonical)) {
		if (ip.blocked) return blocked(`${ip.category}_address`);
		return { ok: true, host: /** @type {string} */ (ip.address), ip: true, allowlisted };
	}
	const labels = host.split('.');
	const last = /** @type {string} */ (labels[labels.length - 1]);
	// a numeric last label makes the whole name an IPv4 spelling (WHATWG URL / inet_aton semantics)
	if (ip.family === 4) return blocked(ip.blocked ? `${ip.category}_address` : 'ip_spelling');
	if (/^(0x[0-9a-f]*|[0-9]+)$/.test(last)) return blocked('ip_spelling');
	if (host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))
		return blocked('internal_name');
	if (labels.some((label) => !LABEL.test(label))) return bad('invalid_host');
	if (labels.length < 2) return blocked('single_label');
	return { ok: true, host, ip: false, allowlisted };
};

/**
 * Check a URL for an outbound HTTP(S) call. Fragments are ignored (never sent).
 * @param {unknown} raw
 * @param {OutboundPolicy} policy
 * @returns {UrlCheck}
 */
export const checkUrl = (raw, policy) => {
	if (typeof raw !== 'string' && !(raw instanceof URL)) return bad('invalid_url');
	const text = String(raw);
	if (text.length > MAX_URL_LENGTH) return bad('url_too_long');
	/** @type {URL} */
	let url;
	try {
		url = new URL(text);
	} catch {
		return bad('invalid_url');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return bad('unsupported_scheme');
	if (url.username !== '' || url.password !== '') return bad('userinfo');
	url.hash = '';
	const host = checkHost(url.hostname, policy);
	if (!host.ok) return host;
	if (url.protocol === 'http:' && !host.allowlisted) return blocked('https_required');
	const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
	if (!host.allowlisted && !PORTS.has(port)) return blocked('port');
	return { ok: true, url, host: host.host, port, ip: host.ip, allowlisted: host.allowlisted };
};

/**
 * Same scheme, host and port?
 * @param {URL} a
 * @param {URL} b
 * @returns {boolean}
 */
export const sameOrigin = (a, b) => a.origin === b.origin;
