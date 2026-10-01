/**
 * Outbound-call guard (SSRF): which URLs the Portal may POST deliveries to. Pure — DNS answers are checked with
 * {@link isPrivateAddress} by the transport at connect time (so a rebinding answer cannot slip through).
 *
 * Rules: `https:` only (plain `http:` only for allow-listed development hosts), no userinfo, no IP literal or host
 * name in a private, loopback, link-local, carrier-grade NAT, documentation, benchmark, multicast or reserved range,
 * no `localhost` / `*.localhost` / `*.local` / `*.internal` names — unless the host is on the explicit allow list.
 *
 * This is a local copy until infra provides one shared guard for every module (see the module README notes).
 * @module
 */
import { isIPv4, isIPv6 } from 'node:net';

/** IPv4 ranges never reachable from the Portal: [network, prefix length]. */
const IPV4_BLOCKED = /** @type {ReadonlyArray<[string, number]>} */ ([
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
]);

/** @param {string} ip dotted quad (already validated) */
const ipv4ToInt = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);

/**
 * @param {string} ip
 * @returns {boolean}
 */
const ipv4Blocked = (ip) => {
	const value = ipv4ToInt(ip);
	return IPV4_BLOCKED.some(([network, bits]) => {
		const size = 2 ** (32 - bits);
		const start = ipv4ToInt(network);
		return value >= start && value < start + size;
	});
};

/**
 * Expand an IPv6 address to 8 numeric hextets (an embedded dotted IPv4 tail becomes two hextets).
 * @param {string} ip a valid IPv6 address
 * @returns {number[]}
 */
export const expandIpv6 = (ip) => {
	let text = ip.toLowerCase().split('%')[0] ?? '';
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (tail?.[1]) {
		const v4 = ipv4ToInt(tail[1]);
		text = `${text.slice(0, -tail[1].length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
	}
	const [head = '', rest] = text.split('::');
	const left = head === '' ? [] : head.split(':');
	const right = rest === undefined || rest === '' ? [] : rest.split(':');
	const missing = rest === undefined ? 0 : 8 - left.length - right.length;
	return [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => Number.parseInt(part, 16));
};

/**
 * @param {number[]} h eight hextets
 * @returns {boolean}
 */
const ipv6Blocked = (h) => {
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, last = 0] = h;
	const v4 = () => `${g >> 8}.${g & 255}.${last >> 8}.${last & 255}`;
	// ::, ::1 and IPv4-compatible (::a.b.c.d, inside 0.0.0.0/8 or the embedded range) / IPv4-mapped (::ffff:a.b.c.d)
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) return ipv4Blocked(v4());
	if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return ipv4Blocked(v4()); // NAT64
	if (a === 0x2002) return ipv4Blocked(`${b >> 8}.${b & 255}.${c >> 8}.${c & 255}`); // 6to4
	if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
	if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((a & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
	if ((a & 0xff00) === 0xff00) return true; // multicast
	if (a === 0x2001 && b === 0x0db8) return true; // documentation
	if (a === 0x2001 && b < 0x200) return true; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, …)
	if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard-only 100::/64
	return false;
};

/**
 * True when an IP address is not publicly routable (or not an IP at all — fail closed).
 * @param {string} ip
 * @returns {boolean}
 */
export const isPrivateAddress = (ip) => {
	const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
	if (isIPv4(bare)) return ipv4Blocked(bare);
	if (isIPv6(bare)) return ipv6Blocked(expandIpv6(bare));
	return true;
};

const BLOCKED_NAMES = /** @type {const} */ (['localhost']);
const BLOCKED_SUFFIXES = /** @type {const} */ (['.localhost', '.local', '.internal', '.localdomain', '.home.arpa']);

/**
 * @typedef {object} OutboundPolicy
 * @property {ReadonlyArray<string>} [allowHosts] host names / IPs that may be private and may use `http:` (development only)
 */

/**
 * Check a delivery URL.
 * @param {string} target
 * @param {OutboundPolicy} [policy]
 * @returns {{ ok: true, url: URL, allowPrivate: boolean } | { ok: false, code: 'ssrf_blocked', reason: string }}
 */
export const checkOutboundUrl = (target, { allowHosts = [] } = {}) => {
	/** @param {string} reason */
	const blocked = (reason) => ({ ok: /** @type {const} */ (false), code: /** @type {const} */ ('ssrf_blocked'), reason });
	/** @type {URL} */
	let url;
	try {
		url = new URL(target);
	} catch {
		return blocked('invalid_url');
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	const bare = host.startsWith('[') ? host.slice(1, -1) : host;
	const allowed = allowHosts.some((entry) => entry.toLowerCase() === host || entry.toLowerCase() === bare);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowed)) return blocked('scheme');
	if (url.username !== '' || url.password !== '') return blocked('userinfo');
	if (host === '') return blocked('host');
	if (allowed) return { ok: true, url, allowPrivate: true };
	if (isIPv4(bare) || isIPv6(bare)) {
		if (isPrivateAddress(bare)) return blocked('private_address');
		return { ok: true, url, allowPrivate: false };
	}
	if (BLOCKED_NAMES.includes(/** @type {any} */ (host)) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)))
		return blocked('private_name');
	if (!host.includes('.')) return blocked('single_label');
	return { ok: true, url, allowPrivate: false };
};

/**
 * The events endpoint of a product: `endpoints.base` + `endpoints.events` (both from the registered app).
 * @param {{ base?: unknown, events?: unknown } | null | undefined} endpoints
 * @returns {string | null}
 */
export const eventsEndpoint = (endpoints) => {
	if (!endpoints || typeof endpoints.base !== 'string' || typeof endpoints.events !== 'string') return null;
	if (!endpoints.events.startsWith('/')) return null;
	return `${endpoints.base.replace(/\/+$/, '')}${endpoints.events}`;
};
