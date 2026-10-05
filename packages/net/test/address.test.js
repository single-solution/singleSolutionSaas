import { describe, expect, it } from 'vitest';
import {
	IPV4_RANGES,
	IPV6_RANGES,
	classifyAddress,
	formatIPv4,
	formatIPv6,
	isBlockedAddress,
	isIpLiteral,
	parseIPv4,
	parseIPv6,
	parseLooseIPv4,
} from '../src/index.js';

describe('parsing', () => {
	it('parses strict dotted quads only', () => {
		expect(parseIPv4('1.2.3.4')).toBe(0x01020304);
		expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
		for (const bad of ['1.2.3', '1.2.3.4.5', '01.2.3.4', '256.1.1.1', '1.2.3.x', '']) expect(parseIPv4(bad)).toBeNull();
	});

	it('parses every inet_aton spelling', () => {
		expect(parseLooseIPv4('2130706433')).toBe(0x7f000001);
		expect(parseLooseIPv4('0x7f000001')).toBe(0x7f000001);
		expect(parseLooseIPv4('0x7f.1')).toBe(0x7f000001);
		expect(parseLooseIPv4('127.1')).toBe(0x7f000001);
		expect(parseLooseIPv4('127.0.1')).toBe(0x7f000001);
		expect(parseLooseIPv4('0177.0.0.1')).toBe(0x7f000001);
		expect(parseLooseIPv4('0x.0.0.0')).toBe(0);
		expect(parseLooseIPv4('1.2.3.4.')).toBe(0x01020304);
		for (const bad of ['1.2.3.4.5', '256.1', '1.16777216', '4294967296', '09.1.1.1', 'a.b', '', '1..2', '0xg'])
			expect(parseLooseIPv4(bad)).toBeNull();
		expect(parseLooseIPv4('9'.repeat(30))).toBeNull();
	});

	it('parses IPv6 with compression, embedded IPv4 and brackets', () => {
		expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
		expect(parseIPv6('[2001:db8::1]')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
		expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
		expect(parseIPv6('0:0:0:0:0:ffff:7f00:1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
		expect(parseIPv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x102, 0x304]);
		for (const bad of [
			'1:2:3',
			'1::2::3',
			'fe80::1%eth0',
			'1:2:3:4:5:6:7:8:9',
			'::1.2.3',
			'12345::',
			'g::1',
			'1.2.3.4',
			'::1:2:3:4:5:6:7:8',
		])
			expect(parseIPv6(bad)).toBeNull();
	});

	it('formats canonical text', () => {
		expect(formatIPv4(0x7f000001)).toBe('127.0.0.1');
		expect(formatIPv6([0x2001, 0xdb8, 0, 0, 1, 0, 0, 1])).toBe('2001:db8::1:0:0:1');
		expect(formatIPv6([1, 0, 2, 3, 4, 5, 6, 7])).toBe('1:0:2:3:4:5:6:7');
		expect(formatIPv6([0, 0, 0, 0, 0, 0, 0, 0])).toBe('::');
		expect(formatIPv6([1, 2, 3, 4, 5, 6, 7, 0])).toBe('1:2:3:4:5:6:7:0');
	});
});

describe('classifyAddress', () => {
	/** @type {Array<[string, string]>} */
	const v4 = [
		['0.0.0.0', 'unspecified'],
		['10.1.2.3', 'private'],
		['100.64.0.1', 'cgnat'],
		['100.127.255.255', 'cgnat'],
		['127.0.0.1', 'loopback'],
		['127.255.255.254', 'loopback'],
		['169.254.169.254', 'metadata'],
		['169.254.170.2', 'metadata'],
		['169.254.170.23', 'metadata'],
		['169.254.1.1', 'link_local'],
		['172.16.0.1', 'private'],
		['172.31.255.255', 'private'],
		['192.0.0.8', 'reserved'],
		['192.0.2.1', 'documentation'],
		['192.88.99.1', 'reserved'],
		['192.168.1.1', 'private'],
		['198.18.0.1', 'benchmark'],
		['198.19.255.255', 'benchmark'],
		['198.51.100.7', 'documentation'],
		['203.0.113.9', 'documentation'],
		['224.0.0.1', 'multicast'],
		['239.255.255.250', 'multicast'],
		['240.0.0.1', 'reserved'],
		['255.255.255.255', 'broadcast'],
		['8.8.8.8', 'public'],
		['1.1.1.1', 'public'],
		['172.32.0.1', 'public'],
		['100.128.0.1', 'public'],
		['11.0.0.1', 'public'],
	];
	it.each(v4)('IPv4 %s is %s', (ip, category) => {
		const c = classifyAddress(ip);
		expect(c).toMatchObject({ category, family: 4, address: ip, canonical: true, blocked: category !== 'public' });
	});

	/** @type {Array<[string, string]>} */
	const v6 = [
		['::', 'unspecified'],
		['::1', 'loopback'],
		['100::1', 'reserved'],
		['2001:2::1', 'benchmark'],
		['2001:10::1', 'reserved'],
		['2001:db8::1', 'documentation'],
		['3fff::1', 'documentation'],
		['5f00::1', 'reserved'],
		['fd00:ec2::254', 'metadata'],
		['fd00:ec2::23', 'metadata'],
		['fc00::1', 'private'],
		['fd12:3456::1', 'private'],
		['fe80::1', 'link_local'],
		['febf::1', 'link_local'],
		['fec0::1', 'private'],
		['ff02::1', 'multicast'],
		['4000::1', 'reserved'],
		['::ffff:0:a00:1', 'reserved'],
		['2606:4700:4700::1111', 'public'],
		['2a00:1450:4001::200e', 'public'],
	];
	it.each(v6)('IPv6 %s is %s', (ip, category) => {
		expect(classifyAddress(ip)).toMatchObject({ category, family: 6, address: ip, blocked: category !== 'public' });
	});

	it('judges IPv4-mapped and NAT64 addresses by the embedded IPv4 address', () => {
		expect(classifyAddress('::ffff:127.0.0.1')).toMatchObject({
			category: 'loopback',
			via: 'ipv4_mapped',
			embedded: '127.0.0.1',
			address: '::ffff:7f00:1',
			canonical: false,
			blocked: true,
		});
		expect(classifyAddress('::ffff:a9fe:a9fe')).toMatchObject({ category: 'metadata', via: 'ipv4_mapped' });
		expect(classifyAddress('0:0:0:0:0:ffff:0808:0808')).toMatchObject({ category: 'public', blocked: false });
		expect(classifyAddress('64:ff9b::10.0.0.1')).toMatchObject({ category: 'private', via: 'nat64', embedded: '10.0.0.1' });
		expect(classifyAddress('64:ff9b::8.8.8.8')).toMatchObject({ category: 'public', via: 'nat64', blocked: false });
	});

	it('always refuses 6to4, Teredo, local NAT64 and IPv4-compatible forms', () => {
		expect(classifyAddress('2002:c0a8:101::1')).toMatchObject({
			category: 'reserved',
			via: '6to4',
			embedded: '192.168.1.1',
			range: '2002::/16',
		});
		expect(classifyAddress('2002:0808:0808::1')).toMatchObject({ category: 'reserved', via: '6to4', embedded: '8.8.8.8' });
		// Teredo client address is stored inverted: 0x80fffffe → 127.0.0.1
		expect(classifyAddress('2001:0:4136:e378:8000:63bf:80ff:fffe')).toMatchObject({
			category: 'reserved',
			via: 'teredo',
			embedded: '127.0.0.1',
		});
		expect(classifyAddress('64:ff9b:1::8.8.8.8')).toMatchObject({ category: 'reserved', via: 'nat64_local' });
		expect(classifyAddress('::8.8.8.8')).toMatchObject({ category: 'reserved', via: 'ipv4_compatible', embedded: '8.8.8.8' });
	});

	it('decodes numeric IPv4 spellings and flags them as non-canonical', () => {
		for (const spelling of ['2130706433', '0x7f000001', '0x7f.1', '0177.0.0.1', '127.1', '017700000001']) {
			expect(classifyAddress(spelling)).toMatchObject({
				category: 'loopback',
				address: '127.0.0.1',
				canonical: false,
				blocked: true,
			});
		}
		expect(classifyAddress('0xa9.0xfe.0xa9.0xfe')).toMatchObject({ category: 'metadata', canonical: false });
		expect(classifyAddress('134744072')).toMatchObject({ category: 'public', address: '8.8.8.8', canonical: false });
		expect(classifyAddress('0')).toMatchObject({ category: 'unspecified' });
	});

	it('accepts brackets and upper case, and canonicalises IPv6', () => {
		expect(classifyAddress('[::1]')).toMatchObject({ category: 'loopback', address: '::1', canonical: true });
		expect(classifyAddress('FE80::1')).toMatchObject({ category: 'link_local', address: 'fe80::1' });
		expect(classifyAddress('0:0:0:0:0:0:0:1')).toMatchObject({ category: 'loopback', address: '::1', canonical: false });
	});

	it('fails closed on anything that is not an IP', () => {
		for (const value of ['', 'example.com', 'fe80::1%lo0', ' 1.2.3.4', 'x'.repeat(65), null, 42, undefined, {}]) {
			expect(classifyAddress(value)).toMatchObject({ category: 'invalid', blocked: true, family: null, address: null });
			expect(isBlockedAddress(value)).toBe(true);
			expect(isIpLiteral(value)).toBe(false);
		}
		expect(isBlockedAddress('8.8.8.8')).toBe(false);
		expect(isIpLiteral('::1')).toBe(true);
	});

	it('keeps every range table entry reachable (first match wins)', () => {
		for (const [cidr, category] of IPV4_RANGES) {
			const base = /** @type {string} */ (cidr.split('/')[0]);
			expect(classifyAddress(base).category).toBe(category);
		}
		for (const [cidr, category] of IPV6_RANGES) {
			const base = /** @type {string} */ (cidr.split('/')[0]);
			expect(classifyAddress(base === '::' ? '::' : base).category).toBe(category);
		}
	});
});
