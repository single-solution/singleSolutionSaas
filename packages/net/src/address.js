/**
 * IP address classification (pure). Decides whether an address is a public unicast destination or belongs to a range
 * an outbound call must never reach: private (RFC 1918, ULA, site-local), loopback, link-local, cloud metadata
 * (169.254.169.254, fd00:ec2::254, …), carrier-grade NAT, benchmarking, documentation, multicast, broadcast,
 * unspecified and reserved space — including IPv6 forms that embed an IPv4 destination (IPv4-mapped, NAT64, 6to4,
 * Teredo, IPv4-compatible) and the numeric IPv4 spellings `inet_aton` accepts (`2130706433`, `0x7f.1`, `0177.0.0.1`).
 * @module
 */

/**
 * @typedef {'public' | 'private' | 'loopback' | 'link_local' | 'metadata' | 'cgnat' | 'benchmark' | 'documentation'
 *   | 'multicast' | 'broadcast' | 'unspecified' | 'reserved' | 'invalid'} AddressCategory
 */
/** @typedef {'ipv4_mapped' | 'nat64' | 'nat64_local' | '6to4' | 'teredo' | 'ipv4_compatible'} Embedding */
/**
 * @typedef {object} AddressClass
 * @property {AddressCategory} category
 * @property {boolean} blocked true unless `category` is `public`
 * @property {4 | 6 | null} family
 * @property {string | null} address canonical text (dotted quad / RFC 5952 compressed IPv6), null when invalid
 * @property {boolean} canonical false when the input used another spelling (numeric/hex/octal IPv4, expanded IPv6, …)
 * @property {string | null} range the matched CIDR, null for public or invalid addresses
 * @property {Embedding} [via] how an IPv6 address embeds an IPv4 one
 * @property {string} [embedded] the embedded IPv4 address
 */

/** @type {ReadonlyArray<readonly [string, AddressCategory]>} first match wins */
export const IPV4_RANGES = Object.freeze([
	['0.0.0.0/8', 'unspecified'],
	['10.0.0.0/8', 'private'],
	['100.64.0.0/10', 'cgnat'],
	['127.0.0.0/8', 'loopback'],
	['169.254.169.254/32', 'metadata'],
	['169.254.170.2/32', 'metadata'],
	['169.254.170.23/32', 'metadata'],
	['169.254.0.0/16', 'link_local'],
	['172.16.0.0/12', 'private'],
	['192.0.0.0/24', 'reserved'],
	['192.0.2.0/24', 'documentation'],
	['192.88.99.0/24', 'reserved'],
	['192.168.0.0/16', 'private'],
	['198.18.0.0/15', 'benchmark'],
	['198.51.100.0/24', 'documentation'],
	['203.0.113.0/24', 'documentation'],
	['224.0.0.0/4', 'multicast'],
	['255.255.255.255/32', 'broadcast'],
	['240.0.0.0/4', 'reserved'],
]);

/** @type {ReadonlyArray<readonly [string, AddressCategory]>} first match wins; embedded forms are handled before */
export const IPV6_RANGES = Object.freeze([
	['::/128', 'unspecified'],
	['::1/128', 'loopback'],
	['100::/64', 'reserved'],
	['2001:2::/48', 'benchmark'],
	['2001::/23', 'reserved'],
	['2001:db8::/32', 'documentation'],
	['3fff::/20', 'documentation'],
	['5f00::/16', 'reserved'],
	['fd00:ec2::254/128', 'metadata'],
	['fd00:ec2::23/128', 'metadata'],
	['fc00::/7', 'private'],
	['fe80::/10', 'link_local'],
	['fec0::/10', 'private'],
	['ff00::/8', 'multicast'],
]);

/**
 * Parse a strict dotted-quad IPv4 address (four decimal octets, no leading zeros).
 * @param {string} value
 * @returns {number | null} unsigned 32-bit value
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
 * Parse any IPv4 spelling `inet_aton` / the WHATWG URL parser accept: 1–4 parts, each decimal, octal (leading `0`) or
 * hex (`0x`); the last part fills the remaining bytes (`127.1`, `2130706433`, `0x7f.0.0.1`, `0177.0.0.1`).
 * @param {string} value
 * @returns {number | null}
 */
export const parseLooseIPv4 = (value) => {
	const text = value.endsWith('.') ? value.slice(0, -1) : value;
	const parts = text.split('.');
	if (parts.length < 1 || parts.length > 4) return null;
	/** @type {number[]} */
	const numbers = [];
	for (const part of parts) {
		/** @type {number} */
		let n;
		if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
		else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8);
		else if (/^(0|[1-9][0-9]*)$/.test(part)) n = Number(part);
		else return null;
		if (!Number.isSafeInteger(n)) return null;
		numbers.push(n);
	}
	const last = /** @type {number} */ (numbers.pop());
	if (numbers.some((n) => n > 255)) return null;
	if (last >= 256 ** (4 - numbers.length)) return null;
	return numbers.reduce((acc, n, i) => acc + n * 256 ** (3 - i), 0) + last;
};

/**
 * Parse an IPv6 address (`::` compression, optional trailing dotted quad, optional brackets) into 8 hextets.
 * Zone ids (`%eth0`) are refused.
 * @param {string} value
 * @returns {number[] | null}
 */
export const parseIPv6 = (value) => {
	let text = value.toLowerCase();
	if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
	if (!/^[0-9a-f:.]+$/.test(text) || text.length > 45 || !text.includes(':')) return null;
	/** @type {number[]} */
	let tail = [];
	if (text.includes('.')) {
		const lastColon = text.lastIndexOf(':');
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
 * @param {number} value unsigned 32-bit
 * @returns {string}
 */
export const formatIPv4 = (value) => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');

/**
 * RFC 5952 text of 8 hextets (longest run of ≥ 2 zero groups compressed, first one on ties).
 * @param {ReadonlyArray<number>} hextets
 * @returns {string}
 */
export const formatIPv6 = (hextets) => {
	let bestStart = -1;
	let bestLength = 1;
	for (let i = 0; i < 8;) {
		if (hextets[i] !== 0) {
			i += 1;
			continue;
		}
		let j = i;
		while (j < 8 && hextets[j] === 0) j += 1;
		if (j - i > bestLength) {
			bestStart = i;
			bestLength = j - i;
		}
		i = j;
	}
	const hex = hextets.map((h) => h.toString(16));
	if (bestStart < 0) return hex.join(':');
	return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
};

/**
 * @param {number} address
 * @param {string} cidr
 */
const inV4 = (address, cidr) => {
	const [base, bits] = cidr.split('/');
	const start = /** @type {number} */ (parseIPv4(/** @type {string} */ (base)));
	return address >= start && address < start + 2 ** (32 - Number(bits));
};

/**
 * @param {ReadonlyArray<number>} hextets
 * @param {string} cidr
 */
const inV6 = (hextets, cidr) => {
	const [base, bitsText] = cidr.split('/');
	const prefix = /** @type {number[]} */ (parseIPv6(/** @type {string} */ (base)));
	let bits = Number(bitsText);
	for (let i = 0; i < 8 && bits > 0; i += 1) {
		const take = Math.min(16, bits);
		const mask = (0xffff << (16 - take)) & 0xffff;
		if ((((hextets[i] ?? 0) ^ (prefix[i] ?? 0)) & mask) !== 0) return false;
		bits -= take;
	}
	return true;
};

/**
 * @param {number} value
 * @returns {{ category: AddressCategory, range: string | null }}
 */
const categoryV4 = (value) => {
	const hit = IPV4_RANGES.find(([cidr]) => inV4(value, cidr));
	return hit ? { category: hit[1], range: hit[0] } : { category: 'public', range: null };
};

/** @type {AddressClass} */
const INVALID = Object.freeze({ category: 'invalid', blocked: true, family: null, address: null, canonical: false, range: null });

/**
 * @param {ReadonlyArray<number>} h
 * @param {string} input
 * @returns {AddressClass}
 */
const classifyV6 = (h, input) => {
	const address = formatIPv6(h);
	const canonical = input === address;
	const embeddedAt = (/** @type {number} */ hi, /** @type {number} */ lo) => (h[hi] ?? 0) * 65536 + (h[lo] ?? 0);
	/**
	 * @param {Embedding} via
	 * @param {number} v4
	 * @param {string} range
	 * @param {boolean} judgeEmbedded true: the embedded address decides; false: always reserved
	 * @returns {AddressClass}
	 */
	const embedding = (via, v4, range, judgeEmbedded) => {
		const inner = categoryV4(v4);
		const category = judgeEmbedded ? inner.category : 'reserved';
		return {
			category,
			blocked: category !== 'public',
			family: 6,
			address,
			canonical,
			range: judgeEmbedded ? inner.range : range,
			via,
			embedded: formatIPv4(v4),
		};
	};
	if (inV6(h, '::ffff:0:0/96')) return embedding('ipv4_mapped', embeddedAt(6, 7), '::ffff:0:0/96', true);
	if (inV6(h, '64:ff9b::/96')) return embedding('nat64', embeddedAt(6, 7), '64:ff9b::/96', true);
	if (inV6(h, '64:ff9b:1::/48')) return embedding('nat64_local', embeddedAt(6, 7), '64:ff9b:1::/48', false);
	if (inV6(h, '2002::/16')) return embedding('6to4', embeddedAt(1, 2), '2002::/16', false);
	if (inV6(h, '2001::/32')) {
		// Teredo: the client IPv4 address is stored inverted in the last 32 bits
		const client = (0xffffffff - embeddedAt(6, 7)) >>> 0;
		return embedding('teredo', client, '2001::/32', false);
	}
	if (inV6(h, '::/96') && !inV6(h, '::/127')) return embedding('ipv4_compatible', embeddedAt(6, 7), '::/96', false);
	const hit = IPV6_RANGES.find(([cidr]) => inV6(h, cidr));
	if (hit) return { category: hit[1], blocked: true, family: 6, address, canonical, range: hit[0] };
	// everything outside the global unicast block 2000::/3 is unallocated
	if (!inV6(h, '2000::/3')) return { category: 'reserved', blocked: true, family: 6, address, canonical, range: null };
	return { category: 'public', blocked: false, family: 6, address, canonical, range: null };
};

/**
 * Classify an IP address. Accepts dotted quads, the numeric IPv4 spellings `inet_aton` accepts, and IPv6 (optionally
 * bracketed). Anything else — host names, zone ids, garbage — is `invalid` and blocked (fail closed).
 * @param {unknown} ip
 * @returns {AddressClass}
 */
export const classifyAddress = (ip) => {
	if (typeof ip !== 'string' || ip.length === 0 || ip.length > 64) return INVALID;
	const text = ip.toLowerCase();
	const strict = parseIPv4(text);
	const v4 = strict ?? parseLooseIPv4(text);
	if (v4 !== null) {
		const { category, range } = categoryV4(v4);
		return { category, blocked: category !== 'public', family: 4, address: formatIPv4(v4), canonical: strict !== null, range };
	}
	const h = parseIPv6(text);
	if (!h) return INVALID;
	return classifyV6(h, text.startsWith('[') ? text.slice(1, -1) : text);
};

/**
 * True when an address must not be connected to (anything but a public unicast IP, including non-IPs).
 * @param {unknown} ip
 * @returns {boolean}
 */
export const isBlockedAddress = (ip) => classifyAddress(ip).blocked;

/**
 * True when `value` is an IP literal in any spelling {@link classifyAddress} understands.
 * @param {unknown} value
 * @returns {boolean}
 */
export const isIpLiteral = (value) => classifyAddress(value).family !== null;
