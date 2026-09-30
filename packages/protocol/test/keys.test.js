import { describe, expect, it } from 'vitest';
import {
	createJwks,
	createKeyResolver,
	createProtocolError,
	createSigner,
	ERROR_CODES,
	exportPublicJwk,
	generateSigningKey,
	importPrivateKey,
	importPublicKey,
	isProtocolError,
	thumbprint,
	toPublicJwk,
} from '../src/index.js';
import { createClock, expectCode, expectThrowCode, makeKey } from './helpers.js';

describe('keys', () => {
	it('generates Ed25519 pairs with kid, alg and use; kid defaults to the thumbprint', async () => {
		const named = await generateSigningKey({ kid: 'portal-2026-10' });
		expect(named.publicJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'portal-2026-10', alg: 'EdDSA', use: 'sig' });
		expect(named.publicJwk).not.toHaveProperty('d');
		expect(typeof named.privateJwk.d).toBe('string');
		const unnamed = await generateSigningKey();
		expect(unnamed.publicJwk.kid).toBe(await thumbprint(unnamed.publicJwk));
	});

	it('signs with a Signer and verifies with the imported public key', async () => {
		const { privateJwk, publicJwk, signer } = await makeKey('k1');
		expect(signer.kid).toBe('k1');
		expect(signer.alg).toBe('EdDSA');
		const data = new TextEncoder().encode('hello');
		const sig = await signer.sign(data);
		expect(sig).toHaveLength(64);
		const key = await importPublicKey(publicJwk);
		expect(await crypto.subtle.verify('Ed25519', key, /** @type {BufferSource} */ (sig), data)).toBe(true);
		const priv = await importPrivateKey(privateJwk);
		expect(priv.extractable).toBe(false);
	});

	it('exports public JWKs from CryptoKeys and JWKs', async () => {
		const { privateJwk, publicJwk } = await makeKey('k1');
		expect(await exportPublicJwk(privateJwk)).toEqual(publicJwk);
		expect(await exportPublicJwk(publicJwk, { kid: 'renamed' })).toMatchObject({ kid: 'renamed', x: publicJwk.x });
		const key = await importPublicKey(publicJwk);
		expect(await exportPublicJwk(key, { kid: 'k1' })).toEqual(publicJwk);
		expect((await exportPublicJwk(key)).kid).toBe(await thumbprint(publicJwk));
		await expectCode(exportPublicJwk(await importPrivateKey(privateJwk)), 'invalid_argument');
	});

	it('validates JWKs strictly', async () => {
		const { publicJwk, privateJwk } = await makeKey('k1');
		expectThrowCode(() => toPublicJwk(null), 'invalid_argument');
		expectThrowCode(() => toPublicJwk({ ...publicJwk, kty: 'EC' }), 'invalid_argument');
		expectThrowCode(() => toPublicJwk({ ...publicJwk, x: 'short' }), 'invalid_argument');
		expectThrowCode(() => toPublicJwk({ ...publicJwk, kid: '' }), 'invalid_argument');
		expectThrowCode(() => toPublicJwk({ ...publicJwk, alg: 'RS256' }), 'invalid_argument');
		expectThrowCode(() => toPublicJwk({ ...publicJwk, use: 'enc' }), 'invalid_argument');
		expectThrowCode(() => toPublicJwk({ ...publicJwk, exp: 1.5 }), 'invalid_argument');
		expect(toPublicJwk({ ...privateJwk, nbf: 1, exp: 2 })).toEqual({ ...publicJwk, nbf: 1, exp: 2 });
		await expectCode(importPrivateKey(publicJwk), 'invalid_argument');
	});

	it('builds a JWKS without private members and rejects duplicate kids', async () => {
		const a = await makeKey('a');
		const b = await makeKey('b');
		const jwks = createJwks([a.privateJwk, b.publicJwk]);
		expect(jwks.keys.map((k) => k.kid)).toEqual(['a', 'b']);
		expect(JSON.stringify(jwks)).not.toContain('"d"');
		expectThrowCode(() => createJwks([a.publicJwk, a.publicJwk]), 'invalid_argument');
		expectThrowCode(() => createJwks(/** @type {any} */ ('nope')), 'invalid_argument');
	});

	it('error helpers', () => {
		const error = createProtocolError('expired', 'x', { a: 1 });
		expect(isProtocolError(error)).toBe(true);
		expect(isProtocolError(error, 'expired')).toBe(true);
		expect(isProtocolError(error, 'replay')).toBe(false);
		expect(isProtocolError(new Error('x'))).toBe(false);
		expect(error.details).toEqual({ a: 1 });
		expect(ERROR_CODES).toContain('replay');
	});
});

describe('createKeyResolver', () => {
	it('requires a source', () => {
		expectThrowCode(() => createKeyResolver({}), 'invalid_argument');
	});

	it('resolves static keys and rejects unknown/invalid kids', async () => {
		const a = await makeKey('a');
		const resolver = createKeyResolver({ jwks: createJwks([a.publicJwk]) });
		expect(await resolver.resolve('a')).toBeInstanceOf(CryptoKey);
		expect(await resolver.resolve('a')).toBe(await resolver.resolve('a'));
		await expectCode(resolver.resolve('b'), 'unknown_kid');
		await expectCode(resolver.resolve(/** @type {any} */ (undefined)), 'unknown_kid');
		await expectCode(resolver.resolve('bad kid!'), 'unknown_kid');
		expect(resolver.kids()).toEqual(['a']);
	});

	it('ignores malformed JWKS members and drops ambiguous duplicate kids', async () => {
		const a = await makeKey('a');
		const b = await makeKey('b');
		const b2 = await makeKey('b');
		const resolver = createKeyResolver({ jwks: { keys: [a.publicJwk, { kty: 'RSA', kid: 'r' }, b.publicJwk, b2.publicJwk] } });
		expect(resolver.kids()).toEqual(['a']);
		expectThrowCode(() => createKeyResolver({ jwks: { nope: true } }), 'jwks_unavailable');
	});

	it('enforces revocation by list and predicate', async () => {
		const a = await makeKey('a');
		const b = await makeKey('b');
		const jwks = createJwks([a.publicJwk, b.publicJwk]);
		await expectCode(createKeyResolver({ jwks, revokedKids: ['a'] }).resolve('a'), 'revoked_key');
		await expectCode(createKeyResolver({ jwks, isRevoked: (kid) => kid === 'b' }).resolve('b'), 'revoked_key');
	});

	it('honours nbf/exp overlap windows on keys', async () => {
		const clock = createClock();
		const t = clock.now() / 1000;
		const old = await makeKey('old');
		const next = await makeKey('next');
		const resolver = createKeyResolver({
			jwks: createJwks([
				{ ...old.publicJwk, exp: t + 3600 },
				{ ...next.publicJwk, nbf: t + 60 },
			]),
			now: clock.now,
		});
		expect(await resolver.resolve('old')).toBeInstanceOf(CryptoKey);
		await expectCode(resolver.resolve('next'), 'key_not_active');
		clock.advance(61_000);
		expect(await resolver.resolve('next')).toBeInstanceOf(CryptoKey);
		clock.advance(3600_000);
		await expectCode(resolver.resolve('old'), 'key_retired');
	});

	it('refetches on unknown kid (rate-limited), on TTL, and serves stale keys when the fetch fails', async () => {
		const clock = createClock();
		const a = await makeKey('a');
		const b = await makeKey('b');
		/** @type {unknown} */
		let published = createJwks([a.publicJwk]);
		let fail = false;
		let calls = 0;
		const resolver = createKeyResolver({
			fetchJwks: async () => {
				calls += 1;
				if (fail) throw new Error('portal down');
				return published;
			},
			cacheTtlMs: 60_000,
			minRefreshIntervalMs: 10_000,
			maxStaleMs: 600_000,
			now: clock.now,
		});
		await resolver.resolve('a');
		expect(calls).toBe(1);
		await resolver.resolve('a');
		expect(calls).toBe(1);
		// rotation: new kid appears, but refetch is rate limited
		published = createJwks([a.publicJwk, b.publicJwk]);
		await expectCode(resolver.resolve('b'), 'unknown_kid');
		expect(calls).toBe(1);
		clock.advance(10_000);
		expect(await resolver.resolve('b')).toBeInstanceOf(CryptoKey);
		expect(calls).toBe(2);
		// forged kids cannot amplify fetches
		await expectCode(resolver.resolve('forged'), 'unknown_kid');
		await expectCode(resolver.resolve('forged2'), 'unknown_kid');
		expect(calls).toBe(2);
		// TTL refresh; Portal down → keep last known keys
		fail = true;
		clock.advance(60_000);
		expect(await resolver.resolve('a')).toBeInstanceOf(CryptoKey);
		expect(calls).toBeGreaterThan(2);
		// beyond maxStale → unavailable
		clock.advance(600_000);
		await expectCode(resolver.resolve('a'), 'jwks_unavailable');
	});

	it('removes keys dropped from the JWKS after refresh and re-imports rotated material under the same kid', async () => {
		const clock = createClock();
		const a = await makeKey('a');
		const a2 = await makeKey('a');
		/** @type {unknown} */
		let published = createJwks([a.publicJwk]);
		const resolver = createKeyResolver({ fetchJwks: async () => published, cacheTtlMs: 1000, now: clock.now });
		const first = await resolver.resolve('a');
		published = createJwks([a2.publicJwk]);
		clock.advance(1000);
		const second = await resolver.resolve('a');
		expect(second).not.toBe(first);
		published = { keys: [] };
		clock.advance(1000);
		await expectCode(resolver.resolve('a'), 'unknown_kid');
	});

	it('fails when the first fetch fails', async () => {
		const resolver = createKeyResolver({ fetchJwks: async () => Promise.reject(new Error('down')) });
		await expectCode(resolver.resolve('a'), 'jwks_unavailable');
	});

	it('dedupes concurrent refreshes', async () => {
		const a = await makeKey('a');
		let calls = 0;
		const resolver = createKeyResolver({
			fetchJwks: async () => {
				calls += 1;
				return createJwks([a.publicJwk]);
			},
		});
		await Promise.all([resolver.resolve('a'), resolver.resolve('a'), resolver.refresh()]);
		expect(calls).toBe(1);
	});

	it('createSigner rejects invalid JWKs', () => {
		expectThrowCode(() => createSigner(/** @type {any} */ ({ kty: 'OKP' })), 'invalid_argument');
	});
});
