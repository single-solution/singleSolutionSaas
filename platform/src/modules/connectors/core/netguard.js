/**
 * SSRF guard rules (pure): which network destinations the Portal may contact on behalf of a merchant connector.
 *
 * Every outbound connection made for a connector check (HTTP providers, object stores, client databases) must go
 * to a **public** address. Refused: loopback, private (RFC 1918 / ULA), carrier-grade NAT, link-local (including
 * the cloud metadata endpoints 169.254.169.254 and fd00:ec2::254), multicast, reserved, documentation and
 * translation ranges, IPv4-mapped / 6to4 / Teredo / NAT64 IPv6 forms (they embed IPv4 destinations), and names that
 * only resolve inside a network (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, single labels).
 * A development allowlist (honoured only outside production/preview, see `allowlistFor`) can admit exact hosts or
 * IPs — e.g. a local MongoDB or object store.
 *
 * Name checks happen here; the address check runs again **after DNS resolution, at connect time** (see
 * `adapters/outbound.js` `guardedLookup`), so DNS rebinding cannot slip a private address in.
 * @module
 */
import { BlockList, isIP } from 'node:net';

const V4 = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
];
const V6 = [
	['::', 128],
	['::1', 128],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8],
];

/** @type {BlockList} */
const BLOCKED = (() => {
	const list = new BlockList();
	for (const [net, prefix] of V4) list.addSubnet(/** @type {string} */ (net), /** @type {number} */ (prefix), 'ipv4');
	for (const [net, prefix] of V6) list.addSubnet(/** @type {string} */ (net), /** @type {number} */ (prefix), 'ipv6');
	return list;
})();

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Strip IPv6 brackets and lower-case a host.
 * @param {string} host
 */
export const normaliseHost = (host) => {
	const h = host.trim().toLowerCase().replace(/\.$/, '');
	return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
};

/**
 * True when an IP literal is not a public unicast address. Non-IPs are reported as blocked (fail closed).
 * @param {string} address
 * @returns {boolean}
 */
export const isBlockedAddress = (address) => {
	const ip = normaliseHost(address).replace(/%.*$/, '');
	const family = isIP(ip);
	if (family === 0) return true;
	if (family === 6) {
		// IPv4-mapped (::ffff:a.b.c.d) embeds an IPv4 destination: refuse the whole range. The URL parser gives the
		// canonical compressed form whatever spelling was used (expanded, dotted, hex).
		const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
		if (canonical.startsWith('::ffff:')) return true;
		return BLOCKED.check(canonical, 'ipv6');
	}
	return BLOCKED.check(ip, 'ipv4');
};

/**
 * @typedef {{ hosts: ReadonlySet<string> }} Allowlist
 */

/** An allowlist admitting nothing. */
export const EMPTY_ALLOWLIST = Object.freeze({ hosts: /** @type {ReadonlySet<string>} */ (new Set()) });

/**
 * The effective development allowlist: entries are honoured only in `development` and `test` environments.
 * @param {string} env Portal environment
 * @param {ReadonlyArray<string>} entries exact hosts or IPs
 * @returns {Allowlist}
 */
export const allowlistFor = (env, entries) => {
	if (env !== 'development' && env !== 'test') return EMPTY_ALLOWLIST;
	return Object.freeze({ hosts: new Set(entries.map(normaliseHost)) });
};

/**
 * @param {Allowlist} allowlist
 * @param {string} host
 */
export const isAllowlisted = (allowlist, host) => allowlist.hosts.has(normaliseHost(host));

/**
 * Check a destination host name before any resolution.
 * @param {string} rawHost
 * @param {Allowlist} allowlist
 * @returns {{ ok: true, host: string, ip: boolean, allowlisted: boolean } | { ok: false, code: 'address_refused' | 'invalid_host' }}
 */
export const checkHost = (rawHost, allowlist) => {
	if (typeof rawHost !== 'string' || rawHost.length === 0) return { ok: false, code: 'invalid_host' };
	const host = normaliseHost(rawHost);
	if (isAllowlisted(allowlist, host)) return { ok: true, host, ip: isIP(host) !== 0, allowlisted: true };
	if (isIP(host) !== 0)
		return isBlockedAddress(host) ? { ok: false, code: 'address_refused' } : { ok: true, host, ip: true, allowlisted: false };
	if (host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix)))
		return { ok: false, code: 'address_refused' };
	if (!HOSTNAME.test(host)) return { ok: false, code: 'invalid_host' };
	// purely numeric labels (e.g. `2130706433`, `0x7f.1`) are IP forms in disguise
	if (host.split('.').every((label) => /^(?:0x[0-9a-f]*|[0-9]+)$/.test(label))) return { ok: false, code: 'address_refused' };
	return { ok: true, host, ip: false, allowlisted: false };
};

/**
 * Check a URL for an outbound HTTP call: https only (http only for allowlisted development hosts), no userinfo,
 * no fragment, a public host.
 * @param {string} raw
 * @param {Allowlist} allowlist
 * @returns {{ ok: true, url: URL, allowlisted: boolean } | { ok: false, code: 'invalid_url' | 'https_required' | 'address_refused' | 'invalid_host' }}
 */
export const checkUrl = (raw, allowlist) => {
	/** @type {URL} */
	let url;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, code: 'invalid_url' };
	}
	if (url.username || url.password || url.hash) return { ok: false, code: 'invalid_url' };
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, code: 'https_required' };
	const host = checkHost(url.hostname, allowlist);
	if (!host.ok) return host;
	if (url.protocol === 'http:' && !host.allowlisted) return { ok: false, code: 'https_required' };
	return { ok: true, url, allowlisted: host.allowlisted };
};
