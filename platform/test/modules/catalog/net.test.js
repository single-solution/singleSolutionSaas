import { describe, expect, it } from 'vitest';
import {
	addressRefusal,
	checkTarget,
	normaliseAllowlist,
	parseIPv4,
	parseIPv6,
	sameTarget,
} from '../../../src/modules/catalog/core/net.js';

describe('catalog SSRF policy: addresses', () => {
	it.each([
		'0.0.0.0',
		'10.0.0.1',
		'10.255.255.255',
		'100.64.0.1',
		'100.100.100.200',
		'127.0.0.1',
		'127.255.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.0.0.170',
		'192.0.2.1',
		'192.168.1.1',
		'198.18.0.1',
		'198.51.100.7',
		'203.0.113.9',
		'224.0.0.1',
		'240.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'::ffff:169.254.169.254',
		'64:ff9b::a00:1',
		'64:ff9b::10.0.0.1',
		'::127.0.0.1',
		'fc00::1',
		'fd00:ec2::254',
		'fe80::1',
		'fec0::1',
		'ff02::1',
		'2001:db8::1',
		'2002:7f00:1::',
		'2001::1',
		'100::1',
		'[::1]',
	])('refuses %s', (ip) => {
		expect(addressRefusal(ip)).toEqual(expect.any(String));
	});

	it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
		'allows public %s',
		(ip) => {
			expect(addressRefusal(ip)).toBeNull();
		},
	);

	it('refuses things that are not addresses', () => {
		expect(addressRefusal('example.com')).toMatch(/not an IP/);
		expect(addressRefusal('fe80::1%eth0')).toMatch(/not an IP/);
	});

	it('parses IPv4 strictly', () => {
		expect(parseIPv4('1.2.3.4')).toBe(0x01020304);
		for (const bad of ['1.2.3', '01.2.3.4', '1.2.3.256', '1.2.3.4.5', '0x7f.0.0.1', '']) expect(parseIPv4(bad)).toBeNull();
	});

	it('parses IPv6 forms', () => {
		expect(parseIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(parseIPv6('1::8')).toEqual([1, 0, 0, 0, 0, 0, 0, 8]);
		expect(parseIPv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
		expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
		expect(parseIPv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
		for (const bad of [
			'1:2:3:4:5:6:7',
			'1:2:3:4:5:6:7:8:9',
			'1::2::3',
			':1',
			'12345::',
			'g::1',
			'1.2.3.4',
			'::1.2.3',
			'1:2:3:4:5:6:7:1.2.3.4',
			'1::2:3:4:5:6:7:8',
		])
			expect(parseIPv6(bad)).toBeNull();
	});
});

describe('catalog SSRF policy: URLs', () => {
	const allow = normaliseAllowlist(['127.0.0.1', ' LocalHost ', '[::1]', '', /** @type {any} */ (7)]);

	it('normalises the allowlist', () => {
		expect([...allow]).toEqual(['127.0.0.1', 'localhost', '::1']);
		expect(normaliseAllowlist(undefined).size).toBe(0);
	});

	it('accepts public https URLs', () => {
		const ok = checkTarget('https://Coupons.Example.dev/base');
		expect(ok).toMatchObject({ ok: true, host: 'coupons.example.dev', allowlisted: false });
		expect(checkTarget('https://shop.example.com:8443/x').ok).toBe(true);
		expect(checkTarget('https://8.8.8.8/').ok).toBe(true);
		expect(checkTarget('https://example.com./').ok).toBe(true);
	});

	it.each([
		[123, /string/],
		['x'.repeat(3000), /string/],
		['not a url', /invalid/],
		['http://coupons.example.dev', /https/],
		['ftp://coupons.example.dev', /https/],
		['https://user:pw@coupons.example.dev', /credentials/],
		['https://coupons.example.dev/#x', /fragment/],
		['https://coupons.example.dev:22/', /port/],
		['https://127.0.0.1/', /127\.0\.0\.0\/8/],
		['https://169.254.169.254/latest/meta-data', /169\.254/],
		['https://10.1.2.3/', /10\.0\.0\.0/],
		['https://[::1]/', /::1/],
		['https://[::ffff:10.0.0.1]/', /embeds/],
		['https://localhost/', /single-label/],
		['https://api.localhost/', /internal/],
		['https://metadata.google.internal/', /internal/],
		['https://printer.local/', /internal/],
		['https://intranet/', /single-label/],
	])('refuses %s', (url, reason) => {
		const result = checkTarget(url);
		expect(result.ok).toBe(false);
		expect(/** @type {any} */ (result).reason).toMatch(reason);
	});

	it('lets allowlisted hosts use http, any port and private addresses', () => {
		expect(checkTarget('http://127.0.0.1:4321/x', { allowlist: allow })).toMatchObject({ ok: true, allowlisted: true });
		expect(checkTarget('http://localhost:80', { allowlist: allow })).toMatchObject({ ok: true, allowlisted: true });
		expect(checkTarget('http://[::1]:9/', { allowlist: allow })).toMatchObject({ ok: true, allowlisted: true });
		expect(checkTarget('http://127.0.0.2:4321/', { allowlist: allow }).ok).toBe(false);
		expect(checkTarget('https://u@127.0.0.1/', { allowlist: allow }).ok).toBe(false);
	});

	it('compares redirect targets', () => {
		const from = new URL('https://a.example.com/x');
		expect(sameTarget(from, new URL('https://A.example.com/y'))).toBe(true);
		expect(sameTarget(from, new URL('https://b.example.com/x'))).toBe(false);
		expect(sameTarget(from, new URL('http://a.example.com/x'))).toBe(false);
		expect(sameTarget(from, new URL('https://a.example.com:8443/x'))).toBe(false);
	});
});
