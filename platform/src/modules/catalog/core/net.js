/**
 * Pure SSRF policy for every outbound call the catalog makes (registration, manifest refresh): which URLs may be
 * fetched and which resolved addresses may be connected to. No I/O — the HTTP adapter (`../fetcher.js`) resolves DNS,
 * asks {@link addressRefusal} about **every** answer and then connects to the vetted address only (no second lookup,
 * so DNS rebinding cannot swap the target between the check and the connection).
 *
 * Rules:
 * - `https:` only; plain `http:` only for hosts on the explicit development allowlist.
 * - No userinfo, no fragments; explicit ports other than 443/8443 only for allowlisted hosts.
 * - Host names under `localhost`, `.local`, `.internal`, `.home.arpa` and single-label names are refused.
 * - Addresses in private, loopback, link-local (incl. cloud metadata 169.254.169.254 / fd00:ec2::254), CGNAT,
 *   multicast, reserved, documentation and translation ranges are refused, including IPv4-mapped / NAT64 forms.
 * - Allowlisted hosts (development only) skip the address check — nothing else does.
 * @module
 */

/** @typedef {{ ok: true, url: URL, host: string, allowlisted: boolean } | { ok: false, reason: string }} TargetCheck */

/** IPv4 CIDRs that must never be reached from the Portal. */
export const FORBIDDEN_V4 = Object.freeze([
	'0.0.0.0/8',
	'10.0.0.0/8',
	'100.64.0.0/10',
	'127.0.0.0/8',
	'169.254.0.0/16',
	'172.16.0.0/12',
	'192.0.0.0/24',
	'192.0.2.0/24',
	'192.88.99.0/24',
	'192.168.0.0/16',
	'198.18.0.0/15',
	'198.51.100.0/24',
	'203.0.113.0/24',
	'224.0.0.0/4',
	'240.0.0.0/4',
]);

/** IPv6 prefixes that must never be reached (embedded IPv4 forms are checked against {@link FORBIDDEN_V4}). */
export const FORBIDDEN_V6 = Object.freeze([
	'::/128',
	'::1/128',
	'::/96',
	'100::/64',
	'2001::/23',
	'2001:db8::/32',
	'2002::/16',
	'3fff::/20',
	'5f00::/16',
	'fc00::/7',
	'fe80::/10',
	'fec0::/10',
	'ff00::/8',
]);

const REFUSED_SUFFIXES = Object.freeze(['localhost', 'local', 'internal', 'home.arpa', 'localdomain', 'lan']);
const ALLOWED_PORTS = new Set(['', '443', '8443']);

/**
 * Parse a dotted-quad IPv4 address (strict: four decimal octets, no leading zeros).
 * @param {string} value
 * @returns {number | null} the address as an unsigned 32-bit integer
 */
export const parseIPv4 = (value) => {
	const parts = value.split('.');
	if (parts.length !== 4) return null;
	let out = 0;
	for (const part of parts) {
		if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
		const n = Number(part);
		if (n > 255) return null;
		out = out * 256 + n;
	}
	return out;
};

/**
 * Parse an IPv6 address (with `::` compression and an optional trailing dotted quad) into 8 hextets.
 * @param {string} value
 * @returns {number[] | null}
 */
export const parseIPv6 = (value) => {
	let text = value.toLowerCase();
	if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
	if (text.includes('%')) return null; // zone ids are never valid targets
	if (!/^[0-9a-f:.]+$/.test(text) || text.length > 45) return null;
	/** @type {number[]} */
	let tail = [];
	if (text.includes('.')) {
		const lastColon = text.lastIndexOf(':');
		if (lastColon < 0) return null;
		const v4 = parseIPv4(text.slice(lastColon + 1));
		if (v4 === null) return null;
		tail = [Math.floor(v4 / 65536), v4 % 65536];
		text = text.slice(0, lastColon + 1);
		if (!text.endsWith('::')) text = text.slice(0, -1);
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	/** @param {string} part */
	const groups = (part) => (part === '' ? [] : part.split(':'));
	const head = groups(/** @type {string} */ (halves[0]));
	const rest = halves.length === 2 ? groups(/** @type {string} */ (halves[1])) : [];
	const all = [...head, ...rest];
	if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	const count = all.length + tail.length;
	if (halves.length === 1 && count !== 8) return null;
	if (halves.length === 2 && count > 7) return null;
	const fill = halves.length === 2 ? Array.from({ length: 8 - count }, () => 0) : [];
	return [...head.map((g) => parseInt(g, 16)), ...fill, ...rest.map((g) => parseInt(g, 16)), ...tail];
};

/**
 * @param {number} address
 * @param {string} cidr
 */
const inV4 = (address, cidr) => {
	const [base, bits] = cidr.split('/');
	const start = /** @type {number} */ (parseIPv4(/** @type {string} */ (base)));
	const size = 2 ** (32 - Number(bits));
	return address >= start && address < start + size;
};

/**
 * @param {number[]} hextets
 * @param {string} cidr
 */
const inV6 = (hextets, cidr) => {
	const [base, bitsText] = cidr.split('/');
	const prefix = /** @type {number[]} */ (parseIPv6(/** @type {string} */ (base)));
	let bits = Number(bitsText);
	for (let i = 0; i < 8 && bits > 0; i += 1) {
		const take = Math.min(16, bits);
		const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
		const a = hextets[i] ?? 0;
		const b = prefix[i] ?? 0;
		if (((a ^ b) & mask) !== 0) return false;
		bits -= take;
	}
	return true;
};

/**
 * Why an IP address must not be connected to, or `null` when it is a public unicast address.
 * @param {string} ip
 * @returns {string | null}
 */
export const addressRefusal = (ip) => {
	const v4 = parseIPv4(ip);
	if (v4 !== null) {
		const hit = FORBIDDEN_V4.find((cidr) => inV4(v4, cidr));
		return hit ? `address ${ip} is in ${hit}` : null;
	}
	const v6 = parseIPv6(ip);
	if (!v6) return `address ${ip} is not an IP address`;
	// IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96, 64:ff9b:1::/48): judge the embedded IPv4 address
	const embedded =
		inV6(v6, '::ffff:0:0/96') || inV6(v6, '64:ff9b::/96') || inV6(v6, '64:ff9b:1::/48')
			? /** @type {number} */ (v6[6]) * 65536 + /** @type {number} */ (v6[7])
			: null;
	if (embedded !== null) {
		const hit = FORBIDDEN_V4.find((cidr) => inV4(embedded, cidr));
		return hit ? `address ${ip} embeds an address in ${hit}` : null;
	}
	const hit = FORBIDDEN_V6.find((cidr) => inV6(v6, cidr));
	return hit ? `address ${ip} is in ${hit}` : null;
};

/**
 * Normalise allowlist entries (lower-case host names or IP literals, brackets removed).
 * @param {ReadonlyArray<string> | undefined | null} allowlist
 * @returns {ReadonlySet<string>}
 */
export const normaliseAllowlist = (allowlist) =>
	new Set(
		(allowlist ?? [])
			.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
			.map((entry) =>
				entry
					.trim()
					.toLowerCase()
					.replace(/^\[|\]$/g, ''),
			),
	);

/**
 * Host as compared against the allowlist and the address rules (lower case, no brackets, no trailing dot).
 * @param {URL} url
 */
export const hostOf = (url) =>
	url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');

/**
 * Check whether a URL may be fetched (before DNS resolution).
 * @param {unknown} value
 * @param {{ allowlist?: ReadonlySet<string> }} [options]
 * @returns {TargetCheck}
 */
export const checkTarget = (value, { allowlist = new Set() } = {}) => {
	if (typeof value !== 'string' || value.length > 2048)
		return { ok: false, reason: 'URL must be a string of at most 2048 chars' };
	/** @type {URL} */
	let url;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, reason: 'URL is invalid' };
	}
	const host = hostOf(url);
	const allowlisted = allowlist.has(host);
	if (url.username || url.password) return { ok: false, reason: 'URL must not carry credentials' };
	if (url.hash) return { ok: false, reason: 'URL must not carry a fragment' };
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowlisted))
		return { ok: false, reason: 'only https URLs are allowed' };
	if (!allowlisted && !ALLOWED_PORTS.has(url.port)) return { ok: false, reason: `port ${url.port} is not allowed` };
	if (!allowlisted) {
		const literal = parseIPv4(host) !== null || parseIPv6(host) !== null;
		if (literal) {
			const refused = addressRefusal(host);
			if (refused) return { ok: false, reason: refused };
		} else {
			if (!host.includes('.')) return { ok: false, reason: 'single-label host names are not allowed' };
			if (REFUSED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))
				return { ok: false, reason: `host ${host} is internal` };
		}
	}
	return { ok: true, url, host, allowlisted };
};

/**
 * May a redirect from `from` go to `to`? Only to the same scheme, host and port.
 * @param {URL} from
 * @param {URL} to
 */
export const sameTarget = (from, to) => from.protocol === to.protocol && hostOf(from) === hostOf(to) && from.port === to.port;
