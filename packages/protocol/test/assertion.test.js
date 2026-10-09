import { beforeAll, describe, expect, it } from 'vitest';
import { consumeWith, createMemoryReplayStore, signAssertion, verifyAssertion } from '../src/index.js';
import { signCompact } from '../src/jws.js';
import { createClock, expectCode, makeKey, seededRandom, staticResolver, tamperSegment, tamperSignature } from './helpers.js';

const AUD = 'https://portal.test/v1/token';

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let product;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let other;
beforeAll(async () => {
	product = await makeKey('product-key-1');
	other = await makeKey('other-key-1');
});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {string} token
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, token, overrides = {}) =>
	verifyAssertion({
		token,
		keyResolverForProduct: (productId) =>
			productId === 'notes'
				? staticResolver([product.publicJwk])
				: productId === 'other'
					? staticResolver([other.publicJwk])
					: null,
		audience: AUD,
		replayStore: createMemoryReplayStore({ now: clock.now }),
		now: clock.now,
		...overrides,
	});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const sign = (clock, overrides = {}) =>
	signAssertion({
		signer: product.signer,
		productId: 'notes',
		audience: AUD,
		now: clock.now,
		randomBytes: seededRandom(),
		...overrides,
	});

describe('client assertions', () => {
	it('signs and verifies iss=sub=productId', async () => {
		const clock = createClock();
		const token = await sign(clock);
		const { productId, claims } = await verify(clock, token);
		expect(productId).toBe('notes');
		expect(claims).toMatchObject({ iss: 'notes', sub: 'notes', aud: AUD });
		expect(claims.exp - claims.iat).toBe(60);
	});

	it('rejects replay within the lifetime', async () => {
		const clock = createClock();
		const replayStore = createMemoryReplayStore({ now: clock.now });
		const token = await sign(clock);
		await verify(clock, token, { replayStore });
		await expectCode(verify(clock, token, { replayStore }), 'replay');
	});

	it('rejects expiry, future iat, lifetime > 5 min, and ttl out of range at signing', async () => {
		const clock = createClock();
		const token = await sign(clock);
		clock.advance(91_000);
		await expectCode(verify(clock, token), 'expired');
		await expectCode(verify(createClock(), await sign(createClock(clock.now() + 600_000))), 'not_yet_valid');
		await expectCode(sign(clock, { ttlSeconds: 301 }), 'invalid_argument');
		const iat = Math.floor(clock.now() / 1000);
		const long = await signCompact({
			signer: product.signer,
			typ: 'ss-assertion+jwt',
			payload: { iss: 'notes', sub: 'notes', aud: AUD, jti: 'j'.repeat(20), iat, exp: iat + 301 },
		});
		await expectCode(verify(clock, long), 'lifetime_too_long');
	});

	it('rejects unknown product, impersonating another product, wrong aud, sub != iss, tampering and short jti', async () => {
		const clock = createClock();
		await expectCode(verify(clock, await sign(clock, { productId: 'unknown' })), 'issuer');
		// signed by notes but claims other → other's keys don't know this kid
		await expectCode(verify(clock, await sign(clock, { productId: 'other' })), 'unknown_kid');
		await expectCode(sign(clock, { productId: 'Bad_Id' }), 'invalid_argument');
		await expectCode(verify(clock, await sign(clock), { audience: 'https://portal.test/other' }), 'audience');
		const token = await sign(clock);
		await expectCode(verify(clock, tamperSignature(token)), 'signature');
		await expectCode(
			verify(
				clock,
				tamperSegment(token, 1, (p) => ({ ...p, iss: 'other', sub: 'other' })),
			),
			'unknown_kid',
		);
		await expectCode(
			verify(
				clock,
				tamperSegment(token, 1, (p) => ({ ...p, iss: undefined })),
			),
			'issuer',
		);
		const iat = Math.floor(clock.now() / 1000);
		const base = { iss: 'notes', sub: 'notes', aud: AUD, jti: 'j'.repeat(20), iat, exp: iat + 60 };
		/** @param {Record<string, unknown>} payload */
		const raw = (payload) => signCompact({ signer: product.signer, typ: 'ss-assertion+jwt', payload });
		await expectCode(verify(clock, await raw({ ...base, sub: 'someone' })), 'subject');
		await expectCode(verify(clock, await raw({ ...base, jti: 'short' })), 'malformed');
		await expectCode(verify(clock, await raw({ ...base, aud: [AUD] })), 'audience');
		await expectCode(verify(clock, await sign(clock), { replayStore: undefined }), 'invalid_argument');
	});

	it('rejects a product key revoked in the product resolver', async () => {
		const clock = createClock();
		const { createKeyResolver, createJwks } = await import('../src/index.js');
		const token = await sign(clock);
		await expectCode(
			verify(clock, token, {
				keyResolverForProduct: () =>
					createKeyResolver({ jwks: createJwks([product.publicJwk]), revokedKids: ['product-key-1'] }),
			}),
			'revoked_key',
		);
	});
});

describe('memory replay store', () => {
	it('records until expiry, prunes, and fails closed when full', async () => {
		const clock = createClock();
		const store = createMemoryReplayStore({ now: clock.now, maxEntries: 2 });
		expect(store.seen('a', clock.now() + 1000)).toBe(false);
		expect(store.seen('a', clock.now() + 1000)).toBe(true);
		expect(store.seen('b', clock.now() + 5000)).toBe(false);
		expect(store.seen('c', clock.now() + 5000)).toBe(true); // full → fail closed
		clock.advance(1000);
		expect(store.seen('a', clock.now() + 1000)).toBe(false); // expired entry pruned and reusable
		expect(store.size()).toBe(2);
		const consume = consumeWith(createMemoryReplayStore({ now: clock.now }));
		expect(await consume('j', clock.now() + 1000)).toBe(true);
		expect(await consume('j', clock.now() + 1000)).toBe(false);
	});
});
