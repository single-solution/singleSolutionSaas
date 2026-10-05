import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MAX_BYTES,
	checkHost,
	checkUrl,
	createOutboundPolicy,
	isAllowlisted,
	normaliseHost,
	sameOrigin,
} from '../src/index.js';

const policy = createOutboundPolicy();
const dev = createOutboundPolicy({ allowHosts: ['LocalHost', '[::1]', '10.0.0.5', 'minio.internal.'] });

describe('createOutboundPolicy', () => {
	it('has safe defaults', () => {
		expect(policy).toMatchObject({
			allowHttpForAllowed: true,
			maxRedirects: 3,
			sameHostRedirectsOnly: true,
			timeoutMs: 10_000,
			maxBytes: DEFAULT_MAX_BYTES,
			userAgent: 'ss-net/1',
		});
		expect([...policy.ports]).toEqual([443, 8443]);
		expect(policy.allowHosts.size).toBe(0);
		expect(Object.isFrozen(policy)).toBe(true);
		expect([...dev.allowHosts]).toEqual(['localhost', '::1', '10.0.0.5', 'minio.internal']);
	});

	it('validates options', () => {
		expect(() => createOutboundPolicy({ allowHosts: /** @type {any} */ ('x') })).toThrow(TypeError);
		expect(() => createOutboundPolicy({ allowHosts: /** @type {any} */ ([1]) })).toThrow(TypeError);
		expect(() => createOutboundPolicy({ ports: /** @type {any} */ (443) })).toThrow(TypeError);
		expect(() => createOutboundPolicy({ ports: [0] })).toThrow(TypeError);
		expect(() => createOutboundPolicy({ maxRedirects: -1 })).toThrow(TypeError);
		expect(() => createOutboundPolicy({ timeoutMs: 0 })).toThrow(TypeError);
		expect(() => createOutboundPolicy({ maxBytes: 1.5 })).toThrow(TypeError);
		expect(() => createOutboundPolicy({ resolve: /** @type {any} */ ('dns') })).toThrow(TypeError);
	});
});

describe('checkHost', () => {
	it('accepts public names and public IP literals', () => {
		expect(checkHost('API.Example.COM.', policy)).toEqual({ ok: true, host: 'api.example.com', ip: false, allowlisted: false });
		expect(checkHost('my_host.example.com', policy)).toMatchObject({ ok: true });
		expect(checkHost('8.8.8.8', policy)).toEqual({ ok: true, host: '8.8.8.8', ip: true, allowlisted: false });
		expect(checkHost('[2606:4700:4700::1111]', policy)).toMatchObject({ ok: true, ip: true });
	});

	/** @type {Array<[string, string]>} */
	const refused = [
		['localhost', 'internal_name'],
		['app.localhost', 'internal_name'],
		['printer.local', 'internal_name'],
		['db.internal', 'internal_name'],
		['router.home.arpa', 'internal_name'],
		['box.localdomain', 'internal_name'],
		['nas.lan', 'internal_name'],
		['wiki.intranet', 'internal_name'],
		['mail.corp', 'internal_name'],
		['intranet', 'internal_name'],
		['metadata', 'single_label'],
		['127.0.0.1', 'loopback_address'],
		['169.254.169.254', 'metadata_address'],
		['[::1]', 'loopback_address'],
		['::ffff:10.0.0.1', 'private_address'],
		['2130706433', 'loopback_address'],
		['0x7f.1', 'loopback_address'],
		['134744072', 'ip_spelling'],
		['0x08080808', 'ip_spelling'],
		['8.8.8.010', 'ip_spelling'],
		['example.123', 'ip_spelling'],
		['1.2.3.4.5', 'ip_spelling'],
	];
	it.each(refused)('refuses %s (%s)', (host, reason) => {
		expect(checkHost(host, policy)).toEqual({ ok: false, code: 'ssrf_blocked', reason });
	});

	it('rejects malformed hosts', () => {
		for (const host of [
			'',
			'  ',
			'a..b',
			'-a.example.com',
			'exa mple.com',
			'a'.repeat(64) + '.com',
			'x'.repeat(254),
			'ex!.com',
		]) {
			expect(checkHost(host, policy)).toMatchObject({ ok: false, code: 'bad_url' });
		}
		expect(checkHost(/** @type {any} */ (42), policy)).toMatchObject({ ok: false, code: 'bad_url' });
	});

	it('admits allowlisted hosts and addresses', () => {
		expect(checkHost('localhost', dev)).toEqual({ ok: true, host: 'localhost', ip: false, allowlisted: true });
		expect(checkHost('[::1]', dev)).toEqual({ ok: true, host: '::1', ip: true, allowlisted: true });
		expect(checkHost('0:0:0:0:0:0:0:1', dev)).toEqual({ ok: true, host: '::1', ip: true, allowlisted: true });
		expect(checkHost('minio.internal', dev)).toMatchObject({ ok: true, allowlisted: true });
		expect(checkHost('10.0.0.6', dev)).toMatchObject({ ok: false });
		expect(isAllowlisted(dev, '10.0.0.5')).toBe(true);
		expect(isAllowlisted(dev, 'LOCALHOST.')).toBe(true);
		expect(isAllowlisted(dev, 'example.com')).toBe(false);
	});
});

describe('checkUrl', () => {
	it('accepts public https URLs on allowed ports and drops fragments', () => {
		const ok = checkUrl('https://api.example.com/v1?x=1#frag', policy);
		expect(ok).toMatchObject({ ok: true, host: 'api.example.com', port: 443, allowlisted: false });
		expect(ok.ok && ok.url.href).toBe('https://api.example.com/v1?x=1');
		expect(checkUrl(new URL('https://api.example.com:8443/'), policy)).toMatchObject({ ok: true, port: 8443 });
	});

	/** @type {Array<[unknown, string, string]>} */
	const refused = [
		['not a url', 'bad_url', 'invalid_url'],
		[42, 'bad_url', 'invalid_url'],
		[`https://example.com/${'a'.repeat(5000)}`, 'bad_url', 'url_too_long'],
		['ftp://example.com/', 'bad_url', 'unsupported_scheme'],
		['file:///etc/passwd', 'bad_url', 'unsupported_scheme'],
		['gopher://example.com/', 'bad_url', 'unsupported_scheme'],
		['https://user:pass@example.com/', 'bad_url', 'userinfo'],
		['https://user@example.com/', 'bad_url', 'userinfo'],
		['http://example.com/', 'ssrf_blocked', 'https_required'],
		['https://example.com:22/', 'ssrf_blocked', 'port'],
		['https://example.com:80/', 'ssrf_blocked', 'port'],
		['https://127.0.0.1/', 'ssrf_blocked', 'loopback_address'],
		['https://0x7f.1/', 'ssrf_blocked', 'loopback_address'],
		['https://2130706433/', 'ssrf_blocked', 'loopback_address'],
		['https://[::ffff:169.254.169.254]/', 'ssrf_blocked', 'metadata_address'],
		['https://[fd00:ec2::254]/', 'ssrf_blocked', 'metadata_address'],
		['https://localhost/', 'ssrf_blocked', 'internal_name'],
		['https://metadata.google.internal/', 'ssrf_blocked', 'internal_name'],
	];
	it.each(refused)('refuses %s', (url, code, reason) => {
		expect(checkUrl(url, policy)).toEqual({ ok: false, code, reason });
	});

	it('lets allowlisted hosts use http and any port, unless http is disabled', () => {
		expect(checkUrl('http://localhost:3000/', dev)).toMatchObject({ ok: true, port: 3000, allowlisted: true });
		expect(checkUrl('http://[::1]/', dev)).toMatchObject({ ok: true, port: 80 });
		const strict = createOutboundPolicy({ allowHosts: ['localhost'], allowHttpForAllowed: false });
		expect(checkUrl('http://localhost:3000/', strict)).toEqual({ ok: false, code: 'ssrf_blocked', reason: 'https_required' });
		expect(checkUrl('https://localhost:3000/', strict)).toMatchObject({ ok: true });
		expect(checkUrl('https://example.com:9000/', createOutboundPolicy({ ports: [9000] }))).toMatchObject({ ok: true });
	});

	it('compares origins', () => {
		expect(sameOrigin(new URL('https://a.example.com/x'), new URL('https://a.example.com:443/y'))).toBe(true);
		expect(sameOrigin(new URL('https://a.example.com/'), new URL('http://a.example.com/'))).toBe(false);
		expect(sameOrigin(new URL('https://a.example.com/'), new URL('https://a.example.com:8443/'))).toBe(false);
		expect(normaliseHost(' [FE80::1] ')).toBe('fe80::1');
	});
});
