import { describe, expect, it } from 'vitest';
import {
	ID_ALPHABET,
	ID_PREFIXES,
	createId,
	encodeBase32,
	getDefaultValidator,
	hostMatchesDomain,
	idPattern,
	isId,
	normaliseDomain,
	parseId,
	SCHEMA_IDS,
} from '../src/index.js';

describe('ids', () => {
	it('creates prefixed 26-char base32 ids', () => {
		const id = createId(ID_PREFIXES.website);
		expect(id).toMatch(/^web_[0-9a-hjkmnp-tv-z]{26}$/);
		expect(new RegExp(idPattern('web')).test(id)).toBe(true);
		expect(createId('web')).not.toBe(id);
	});

	it('is deterministic with injected randomness', () => {
		const zeros = createId('sub', { randomBytes: (n) => new Uint8Array(n) });
		expect(zeros).toBe(`sub_${'0'.repeat(26)}`);
		const ones = createId('mer', { randomBytes: (n) => new Uint8Array(n).fill(255) });
		expect(ones).toBe(`mer_${'z'.repeat(25)}w`);
	});

	it('encodes base32 like Crockford', () => {
		expect(ID_ALPHABET).toHaveLength(32);
		expect(encodeBase32(new Uint8Array([]))).toBe('');
		expect(encodeBase32(new Uint8Array([0xff]))).toBe('zw');
		expect(encodeBase32(new Uint8Array([0, 0, 0, 0, 0]))).toBe('00000000');
	});

	it('rejects invalid prefixes', () => {
		expect(() => createId('Web')).toThrow(TypeError);
		expect(() => createId('w')).toThrow(TypeError);
		expect(() => createId('web_')).toThrow(TypeError);
	});

	it('checks and parses ids', () => {
		const id = createId('evt');
		expect(isId(id)).toBe(true);
		expect(isId(id, 'evt')).toBe(true);
		expect(isId(id, 'web')).toBe(false);
		expect(isId('evt_short')).toBe(false);
		expect(isId(42)).toBe(false);
		expect(parseId(id)).toEqual({ prefix: 'evt', random: id.slice(4) });
		expect(parseId('nope')).toBeNull();
	});

	it('generated ids satisfy the entitlement schema patterns', () => {
		const v = getDefaultValidator();
		const common = `${SCHEMA_IDS.common}#/$defs/`;
		expect(v.validate(`${common}websiteId`, createId(ID_PREFIXES.website)).ok).toBe(true);
		expect(v.validate(`${common}merchantId`, createId(ID_PREFIXES.merchant)).ok).toBe(true);
		expect(v.validate(`${common}subscriptionId`, createId(ID_PREFIXES.subscription)).ok).toBe(true);
		expect(v.validate(`${common}subscriptionId`, createId(ID_PREFIXES.website)).ok).toBe(false);
	});
});

describe('normaliseDomain', () => {
	/** @type {Array<[unknown, string]>} */
	const accepted = [
		['example.com', 'example.com'],
		['Example.COM', 'example.com'],
		['  shop.example.com  ', 'shop.example.com'],
		['https://shop.example.com', 'shop.example.com'],
		['HTTP://Shop.Example.com/', 'shop.example.com'],
		['https://shop.example.com:8443/path?q=1#frag', 'shop.example.com'],
		['shop.example.com:443', 'shop.example.com'],
		['shop.example.com:', 'shop.example.com'],
		['//cdn.example.com/x.js', 'cdn.example.com'],
		['example.com.', 'example.com'],
		['https://user:pass@example.com/login', 'example.com'],
		['example.com/path/to/page', 'example.com'],
		['example.com?x=1', 'example.com'],
		['example.com#top', 'example.com'],
		['example.com\\evil', 'example.com'],
		['münchen.de', 'xn--mnchen-3ya.de'],
		['https://MÜNCHEN.de/', 'xn--mnchen-3ya.de'],
		['例え.テスト', 'xn--r8jz45g.xn--zckzah'],
		['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
		['example。com', 'example.com'],
		['a-b.example.co.uk', 'a-b.example.co.uk'],
		['wss://chat.example.io:9000', 'chat.example.io'],
		['123.example.com', '123.example.com'],
	];
	it.each(accepted)('accepts %j → %s', (input, expected) => {
		expect(normaliseDomain(input)).toEqual({ ok: true, value: expected });
	});

	/** @type {Array<[unknown, string]>} */
	const rejected = [
		[42, 'invalid_type'],
		[null, 'invalid_type'],
		['', 'empty'],
		['   ', 'empty'],
		['https://', 'empty'],
		['.', 'empty'],
		['exa mple.com', 'invalid_domain'],
		['ex_ample.com', 'invalid_domain'],
		['-example.com', 'invalid_domain'],
		['example-.com', 'invalid_domain'],
		['a..b.com', 'invalid_domain'],
		['example.com..', 'invalid_domain'],
		['example.com:abc', 'invalid_domain'],
		[`${'a'.repeat(64)}.com`, 'invalid_domain'],
		[`${'a.'.repeat(126)}com`, 'too_long'],
		['*.example.com', 'wildcard'],
		['192.168.0.1', 'ip_not_allowed'],
		['http://10.0.0.1:3000/', 'ip_not_allowed'],
		['0x7f.1', 'ip_not_allowed'],
		['[::1]', 'ip_not_allowed'],
		['http://[2001:db8::1]:8080/', 'ip_not_allowed'],
		['::1', 'ip_not_allowed'],
		['[nope]', 'invalid_domain'],
		['a.b.c.123', 'invalid_domain'],
		['localhost', 'local_not_allowed'],
		['http://localhost:3000', 'local_not_allowed'],
		['app.localhost', 'local_not_allowed'],
		['intranet', 'single_label'],
		['com', 'single_label'],
	];
	it.each(rejected)('rejects %j (%s)', (input, code) => {
		const result = normaliseDomain(input);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe(code);
			expect(result.message.length).toBeGreaterThan(0);
		}
	});

	it('allows local hosts and IPs with allowLocal', () => {
		expect(normaliseDomain('http://localhost:3000', { allowLocal: true })).toEqual({ ok: true, value: 'localhost' });
		expect(normaliseDomain('shop.localhost', { allowLocal: true })).toEqual({ ok: true, value: 'shop.localhost' });
		expect(normaliseDomain('127.0.0.1:8080', { allowLocal: true })).toEqual({ ok: true, value: '127.0.0.1' });
		expect(normaliseDomain('[::1]:3000', { allowLocal: true })).toEqual({ ok: true, value: '::1' });
		expect(normaliseDomain('[2001:DB8::1]', { allowLocal: true })).toEqual({ ok: true, value: '2001:db8::1' });
		expect(normaliseDomain('devbox', { allowLocal: true })).toEqual({ ok: true, value: 'devbox' });
	});

	it('rejects public suffixes through an injected predicate', () => {
		const isPublicSuffix = (/** @type {string} */ d) => ['co.uk', 'com.br'].includes(d);
		expect(normaliseDomain('CO.UK', { isPublicSuffix })).toMatchObject({ ok: false, code: 'public_suffix' });
		expect(normaliseDomain('shop.co.uk', { isPublicSuffix })).toEqual({ ok: true, value: 'shop.co.uk' });
	});

	it('produces values accepted by the hostname schema', () => {
		const v = getDefaultValidator();
		for (const [input] of accepted) {
			const result = normaliseDomain(input);
			if (result.ok) expect(v.validate(`${SCHEMA_IDS.common}#/$defs/hostname`, result.value).ok).toBe(true);
		}
	});
});

describe('hostMatchesDomain', () => {
	it('matches exact hosts and optional subdomains', () => {
		expect(hostMatchesDomain('https://Shop.Example.com/x', 'shop.example.com')).toBe(true);
		expect(hostMatchesDomain('www.shop.example.com', 'shop.example.com')).toBe(false);
		expect(hostMatchesDomain('www.shop.example.com', 'shop.example.com', { allowSubdomains: true })).toBe(true);
		expect(hostMatchesDomain('evilshop.example.com', 'shop.example.com', { allowSubdomains: true })).toBe(false);
		expect(hostMatchesDomain('localhost', 'localhost')).toBe(false);
		expect(hostMatchesDomain('localhost:3000', 'localhost', { allowLocal: true })).toBe(true);
	});
});
