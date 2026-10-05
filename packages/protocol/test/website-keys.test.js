import { beforeAll, describe, expect, it } from 'vitest';
import {
	compareSecretKey,
	hashSecretKey,
	issueWebsiteKey,
	normalizeDomain,
	originAllowed,
	verifyWebsiteKey,
} from '../src/index.js';
import { signCompact } from '../src/jws.js';
import { createClock, expectCode, expectThrowCode, makeKey, staticResolver, tamperSignature } from './helpers.js';

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let portal;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let attacker;
beforeAll(async () => {
	portal = await makeKey('portal-1');
	attacker = await makeKey('portal-1');
});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const issue = (clock, overrides = {}) =>
	issueWebsiteKey({
		signer: portal.signer,
		kind: 'pk',
		websiteId: 'web_1',
		merchantId: 'mer_1',
		domain: 'Shop.Example.com',
		env: 'live',
		scopes: ['loader.read', 'events.write'],
		keyId: 'key_1',
		now: clock.now,
		...overrides,
	});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {string} key
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, key, overrides = {}) =>
	verifyWebsiteKey({
		key,
		keyResolver: staticResolver([portal.publicJwk]),
		revocations: new Set(),
		now: clock.now,
		...overrides,
	});

describe('website keys', () => {
	it('issues pk_/sk_ keys with env prefixes and verifies them offline', async () => {
		const clock = createClock();
		const pk = await issue(clock);
		expect(pk.key.startsWith('pk_live_')).toBe(true);
		expect(pk.claims.domain).toBe('shop.example.com');
		const claims = await verify(clock, pk.key);
		expect(claims).toMatchObject({
			kind: 'pk',
			env: 'live',
			websiteId: 'web_1',
			merchantId: 'mer_1',
			keyId: 'key_1',
			kid: 'portal-1',
		});
		expect(claims.allowSubdomains).toBe(false);
		const sk = await issue(clock, {
			kind: 'sk',
			env: 'test',
			allowSubdomains: true,
			expiresAt: Math.floor(clock.now() / 1000) + 60,
		});
		expect(sk.key.startsWith('sk_test_')).toBe(true);
		expect(await verify(clock, sk.key, { expectedKind: 'sk', expectedEnv: 'test' })).toMatchObject({
			kind: 'sk',
			exp: sk.claims.exp,
		});
	});

	it('rejects revoked keys (set, array and predicate)', async () => {
		const clock = createClock();
		const { key } = await issue(clock);
		await expectCode(verify(clock, key, { revocations: new Set(['key_1']) }), 'revoked');
		await expectCode(verify(clock, key, { revocations: ['key_0', 'key_1'] }), 'revoked');
		await expectCode(
			verify(clock, key, { revocations: { isRevoked: async (/** @type {string} */ id) => id === 'key_1' } }),
			'revoked',
		);
		await expect(verify(clock, key, { revocations: ['key_0'] })).resolves.toBeTruthy();
		await expectCode(verify(clock, key, { revocations: undefined }), 'invalid_argument');
	});

	it('rejects expired, future-issued, wrong-kind, wrong-env and prefix-swapped keys', async () => {
		const clock = createClock();
		const expiring = await issue(clock, { expiresAt: Math.floor(clock.now() / 1000) + 10 });
		const later = createClock(clock.now() + 3_600_000);
		await expectCode(verify(later, expiring.key), 'expired');
		const future = await issue(later);
		await expectCode(verify(clock, future.key), 'not_yet_valid');
		const pk = await issue(clock);
		await expectCode(verify(clock, pk.key, { expectedKind: 'sk' }), 'wrong_type');
		await expectCode(verify(clock, pk.key, { expectedEnv: 'test' }), 'env_mismatch');
		await expectCode(verify(clock, pk.key.replace(/^pk_/, 'sk_')), 'malformed');
		await expectCode(verify(clock, pk.key.replace(/^pk_live_/, 'pk_test_')), 'env_mismatch');
	});

	it('rejects forged, tampered and malformed keys', async () => {
		const clock = createClock();
		const pk = await issue(clock);
		const forged = await issue(clock, { signer: attacker.signer });
		await expectCode(verify(clock, forged.key), 'signature');
		await expectCode(verify(clock, tamperSignature(pk.key)), 'signature');
		await expectCode(verify(clock, pk.key, { keyResolver: staticResolver([]) }), 'unknown_kid');
		await expectCode(verify(clock, 'pk_live_'), 'malformed');
		await expectCode(verify(clock, 'xk_live_abc.def.ghi'), 'malformed');
		await expectCode(verify(clock, /** @type {any} */ (123)), 'malformed');
		/** @param {Record<string, unknown>} payload */
		const raw = async (payload) =>
			`pk_live_${await signCompact({ signer: portal.signer, typ: 'ss-website-key+jws', payload })}`;
		const good = { ...pk.claims };
		await expectCode(verify(clock, await raw({ ...good, v: 2 })), 'malformed');
		await expectCode(verify(clock, await raw({ ...good, websiteId: '' })), 'malformed');
		await expectCode(verify(clock, await raw({ ...good, allowSubdomains: 'yes' })), 'malformed');
		await expectCode(verify(clock, await raw({ ...good, scopes: [1] })), 'malformed');
		await expectCode(verify(clock, await raw({ ...good, iat: undefined })), 'malformed');
		const typed = `pk_live_${await signCompact({ signer: portal.signer, typ: 'ss-entitlement+jws', payload: good })}`;
		await expectCode(verify(clock, typed), 'wrong_type');
	});

	it('validates issue arguments', async () => {
		const clock = createClock();
		await expectCode(issue(clock, { kind: 'rk' }), 'invalid_argument');
		await expectCode(issue(clock, { env: 'prod' }), 'invalid_argument');
		await expectCode(issue(clock, { scopes: 'all' }), 'invalid_argument');
		await expectCode(issue(clock, { expiresAt: 1 }), 'invalid_argument');
		await expectCode(issue(clock, { domain: 'https://example.com' }), 'invalid_argument');
		await expectCode(issue(clock, { keyId: '' }), 'invalid_argument');
	});

	it('normalizes domains to punycode and rejects non-hosts', () => {
		expect(normalizeDomain('Bücher.DE.')).toBe('xn--bcher-kva.de');
		expect(normalizeDomain('shop.example.com')).toBe('shop.example.com');
		for (const bad of [
			'',
			'example.com:443',
			'a b.com',
			'*.example.com',
			'evil@example.com',
			'.example.com',
			'a..b',
			'ex%61mple.com',
			'a\\b',
		]) {
			expectThrowCode(() => normalizeDomain(bad), 'invalid_argument');
		}
		expectThrowCode(() => normalizeDomain(42), 'invalid_argument');
	});
});

describe('originAllowed', () => {
	/** @type {Array<[string, { origin?: string | null, referer?: string | null, domain?: string, allowSubdomains?: boolean, env?: 'live' | 'test' }, boolean]>} */
	const table = [
		// exact host
		['exact https origin', { origin: 'https://example.com' }, true],
		['upper-case origin host', { origin: 'https://EXAMPLE.com' }, true],
		['port ignored', { origin: 'https://example.com:8443' }, true],
		['default port', { origin: 'https://example.com:443' }, true],
		['trailing slash origin', { origin: 'https://example.com/' }, true],
		['trailing dot host', { origin: 'https://example.com.' }, true],
		// scheme
		['http rejected', { origin: 'http://example.com' }, false],
		['http rejected in test env for non-local', { origin: 'http://example.com', env: 'test' }, false],
		['ftp rejected', { origin: 'ftp://example.com' }, false],
		['wss rejected', { origin: 'wss://example.com' }, false],
		['javascript: rejected', { origin: 'javascript:alert(1)' }, false],
		['data: rejected', { origin: 'data:text/html,hi' }, false],
		// suffix / prefix tricks
		['suffix trick example.com.evil.com', { origin: 'https://example.com.evil.com' }, false],
		['suffix trick with subdomains allowed', { origin: 'https://example.com.evil.com', allowSubdomains: true }, false],
		['hyphen prefix evil-example.com', { origin: 'https://evil-example.com' }, false],
		['hyphen prefix with subdomains allowed', { origin: 'https://evil-example.com', allowSubdomains: true }, false],
		['glued prefix evilexample.com', { origin: 'https://evilexample.com', allowSubdomains: true }, false],
		['longer TLD example.comm', { origin: 'https://example.comm' }, false],
		['shorter TLD example.co', { origin: 'https://example.co' }, false],
		['percent-encoded dot', { origin: 'https://example.com%2eevil.com' }, false],
		// userinfo
		['userinfo evil@example.com', { origin: 'https://evil@example.com' }, false],
		['userinfo example.com@evil.com', { origin: 'https://example.com@evil.com' }, false],
		['userinfo in referer', { referer: 'https://user:pass@example.com/page' }, false],
		// origin strictness
		['origin with path', { origin: 'https://example.com/path' }, false],
		['origin with query', { origin: 'https://evil.com/?example.com' }, false],
		['origin with fragment', { origin: 'https://evil.com#example.com' }, false],
		['null origin', { origin: 'null' }, false],
		['whitespace in origin', { origin: 'https://exa mple.com' }, false],
		['tab in origin', { origin: 'https://exa\tmple.com' }, false],
		['backslash in origin', { origin: 'https://evil.com\\@example.com' }, false],
		['garbage origin', { origin: 'not a url' }, false],
		['nothing provided', {}, false],
		// IDN / homoglyphs
		['IDN domain vs punycode origin', { origin: 'https://xn--bcher-kva.de', domain: 'bücher.de' }, true],
		['IDN origin in unicode form', { origin: 'https://bücher.de', domain: 'xn--bcher-kva.de' }, true],
		['Cyrillic homoglyph е (punycode)', { origin: 'https://xn--xample-2of.com' }, false],
		['Cyrillic homoglyph in unicode form', { origin: 'https://еxample.com' }, false],
		['full-width letters normalize to ascii', { origin: 'https://ｅｘａｍｐｌｅ.com' }, true],
		// subdomains
		['subdomain without allowSubdomains', { origin: 'https://shop.example.com' }, false],
		['subdomain with allowSubdomains', { origin: 'https://shop.example.com', allowSubdomains: true }, true],
		['deep subdomain with allowSubdomains', { origin: 'https://a.b.example.com', allowSubdomains: true }, true],
		['parent of bound subdomain', { origin: 'https://example.com', domain: 'shop.example.com', allowSubdomains: true }, false],
		[
			'sibling of bound subdomain',
			{ origin: 'https://blog.example.com', domain: 'shop.example.com', allowSubdomains: true },
			false,
		],
		['www is not implied', { origin: 'https://www.example.com' }, false],
		// referer fallback
		['referer used when origin absent', { referer: 'https://example.com/products/1?x=1' }, true],
		['referer with @ in path', { referer: 'https://example.com/users/@bob' }, true],
		['referer suffix trick', { referer: 'https://example.com.evil.com/' }, false],
		['mismatched origin not rescued by referer', { origin: 'https://evil.com', referer: 'https://example.com/' }, false],
		['http referer rejected', { referer: 'http://example.com/' }, false],
		['null origin with valid referer', { origin: null, referer: 'https://example.com/' }, true],
		// localhost
		['localhost in test env', { origin: 'http://localhost:3000', env: 'test' }, true],
		['*.localhost in test env', { origin: 'http://shop.localhost:3000', env: 'test' }, true],
		['127.0.0.1 in test env', { origin: 'http://127.0.0.1:5173', env: 'test' }, true],
		['[::1] in test env', { origin: 'http://[::1]:8080', env: 'test' }, true],
		['localhost in live env', { origin: 'http://localhost:3000' }, false],
		['https localhost in live env', { origin: 'https://localhost' }, false],
		['localhost.evil.com is not local', { origin: 'http://localhost.evil.com', env: 'test' }, false],
		// bad bound domain
		['invalid bound domain', { origin: 'https://example.com', domain: 'https://example.com' }, false],
	];

	it(`has at least 30 cases (${table.length})`, () => {
		expect(table.length).toBeGreaterThanOrEqual(30);
	});

	it.each(table)('%s', (_name, input, expected) => {
		expect(originAllowed({ domain: 'example.com', ...input })).toBe(expected);
	});
});

describe('secret key storage', () => {
	const pepper = 'pepper-0123456789abcdef';
	it('hashes with a pepper and compares in constant time', () => {
		const hash = hashSecretKey({ key: 'sk_live_abc', pepper });
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).not.toBe(hashSecretKey({ key: 'sk_live_abc', pepper: 'another-pepper-012345' }));
		expect(compareSecretKey({ key: 'sk_live_abc', hash, pepper })).toBe(true);
		expect(compareSecretKey({ key: 'sk_live_abd', hash, pepper })).toBe(false);
		expect(compareSecretKey({ key: 'sk_live_abc', hash: hash.slice(1), pepper })).toBe(false);
		expect(compareSecretKey({ key: '', hash, pepper })).toBe(false);
		expect(compareSecretKey({ key: 'sk_live_abc', hash: undefined, pepper })).toBe(false);
		expectThrowCode(() => hashSecretKey({ key: 'k', pepper: 'short' }), 'invalid_argument');
		expectThrowCode(() => hashSecretKey({ key: '', pepper }), 'invalid_argument');
	});
});
