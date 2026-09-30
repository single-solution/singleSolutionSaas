import { beforeAll, describe, expect, it } from 'vitest';
import { consumeWith, createMemoryReplayStore, issueLaunch, kindScopeViolation, verifyLaunch } from '../src/index.js';
import { signCompact } from '../src/jws.js';
import {
	createClock,
	decodeSegment,
	expectCode,
	makeKey,
	seededRandom,
	staticResolver,
	tamperSegment,
	tamperSignature,
} from './helpers.js';

const ISS = 'https://portal.test';
const AUD = 'app_coupons';

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
	issueLaunch({
		signer: portal.signer,
		issuer: ISS,
		audience: AUD,
		subject: 'usr_1',
		kind: 'merchant',
		user: { id: 'usr_1', email: 'a@example.com' },
		scope: { merchantId: 'mer_1', websiteId: 'web_1' },
		subscriptions: [{ id: 'sub_1', elements: ['codes'] }],
		now: clock.now,
		randomBytes: seededRandom(),
		...overrides,
	});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {string} token
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, token, overrides = {}) =>
	verifyLaunch({
		token,
		keyResolver: staticResolver([portal.publicJwk]),
		audience: AUD,
		issuer: ISS,
		consume: consumeWith(createMemoryReplayStore({ now: clock.now })),
		now: clock.now,
		...overrides,
	});

describe('launch tokens', () => {
	it('issues a 60 s single-use launch and verifies it', async () => {
		const clock = createClock();
		const { token, claims } = await issue(clock);
		expect(claims.exp - claims.iat).toBe(60);
		expect(decodeSegment(token, 0)).toEqual({ alg: 'EdDSA', kid: 'portal-1', typ: 'ss-launch+jwt' });
		const verified = await verify(clock, token);
		expect(verified).toMatchObject({
			kind: 'merchant',
			sub: 'usr_1',
			scope: { merchantId: 'mer_1' },
			subscriptions: [{ id: 'sub_1' }],
		});
		expect(verified.jti.length).toBeGreaterThan(10);
	});

	it('rejects a replayed jti', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		const consume = consumeWith(createMemoryReplayStore({ now: clock.now }));
		await verify(clock, token, { consume });
		await expectCode(verify(clock, token, { consume }), 'replay');
	});

	it('rejects expired, not-yet-valid and over-long tokens', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		clock.advance(66_000);
		await expectCode(verify(clock, token), 'expired');
		const future = createClock(clock.now() + 3_600_000);
		const { token: fromFuture } = await issue(future);
		await expectCode(verify(clock, fromFuture), 'not_yet_valid');
		const long = await signCompact({
			signer: portal.signer,
			typ: 'ss-launch+jwt',
			payload: { ...(await issue(clock)).claims, exp: Math.floor(clock.now() / 1000) + 3600 },
		});
		await expectCode(verify(clock, long), 'lifetime_too_long');
	});

	it('rejects wrong audience, issuer, kid, signature, type and tampering', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		await expectCode(verify(clock, token, { audience: 'app_other' }), 'audience');
		await expectCode(verify(clock, token, { issuer: 'https://evil.test' }), 'issuer');
		await expectCode(verify(clock, token, { keyResolver: staticResolver([]) }), 'unknown_kid');
		await expectCode(verify(clock, token, { keyResolver: staticResolver([attacker.publicJwk]) }), 'signature');
		await expectCode(verify(clock, tamperSignature(token)), 'signature');
		await expectCode(
			verify(
				clock,
				tamperSegment(token, 1, (p) => ({ ...p, scope: { merchantId: 'mer_2' } })),
			),
			'signature',
		);
		await expectCode(
			verify(
				clock,
				tamperSegment(token, 0, (h) => ({ ...h, alg: 'none' })),
			),
			'unsupported_alg',
		);
		await expectCode(
			verify(
				clock,
				tamperSegment(token, 0, (h) => ({ ...h, typ: 'JWT' })),
			),
			'wrong_type',
		);
		const forged = await (await issue(clock, { signer: attacker.signer })).token;
		await expectCode(verify(clock, forged), 'signature');
		const aud = await issueLaunch({ ...(await baseIssue(clock)), audience: 'app_other' });
		await expectCode(verify(clock, aud.token), 'audience');
	});

	it('rejects a revoked signing key', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		const { createKeyResolver, createJwks } = await import('../src/index.js');
		const keyResolver = createKeyResolver({ jwks: createJwks([portal.publicJwk]), revokedKids: ['portal-1'] });
		await expectCode(verify(clock, token, { keyResolver }), 'revoked_key');
	});

	it('requires consume and valid arguments', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		await expectCode(verify(clock, token, { consume: undefined }), 'invalid_argument');
		await expectCode(verify(clock, token, { audience: '' }), 'invalid_argument');
		await expectCode(issue(clock, { ttlSeconds: 301 }), 'invalid_argument');
		await expectCode(issue(clock, { ttlSeconds: 0 }), 'invalid_argument');
		await expectCode(issue(clock, { issuer: '' }), 'invalid_argument');
	});

	it('rejects malformed claims even when correctly signed', async () => {
		const clock = createClock();
		const { claims } = await issue(clock);
		/** @param {Record<string, unknown>} payload */
		const sign = (payload) => signCompact({ signer: portal.signer, typ: 'ss-launch+jwt', payload });
		await expectCode(verify(clock, await sign({ ...claims, sub: '' })), 'malformed');
		await expectCode(verify(clock, await sign({ ...claims, jti: undefined })), 'malformed');
		await expectCode(verify(clock, await sign({ ...claims, exp: undefined })), 'malformed');
		await expectCode(verify(clock, await sign({ ...claims, iat: undefined })), 'malformed');
		await expectCode(verify(clock, await sign({ ...claims, iat: 'x' })), 'malformed');
		await expectCode(verify(clock, await sign({ ...claims, nbf: 'x' })), 'malformed');
		await expectCode(verify(clock, await sign({ ...claims, exp: claims.iat })), 'malformed');
		await expectCode(verify(clock, await sign({ ...claims, nbf: claims.iat + 30 })), 'not_yet_valid');
		await expectCode(verify(clock, await sign({ ...claims, kind: 'root' })), 'kind_scope');
	});
});

/** @param {ReturnType<typeof createClock>} clock */
const baseIssue = async (clock) => ({
	signer: portal.signer,
	issuer: ISS,
	audience: AUD,
	subject: 'usr_1',
	kind: /** @type {const} */ ('merchant'),
	user: { id: 'usr_1' },
	scope: { merchantId: 'mer_1' },
	now: clock.now,
});

describe('launch kind/scope rules', () => {
	it.each([
		['merchant', { scope: { merchantId: 'm' } }],
		['demo', { scope: {} }],
		['admin', { scope: { merchantId: 'm', permissions: ['orders.read'] }, user: { id: 'staff_1', roles: ['support'] } }],
		['partner', { scope: { partnerId: 'p' } }],
		['developer', { scope: { developerId: 'd' } }],
		['impersonate', { scope: { merchantId: 'm' }, actor: 'staff_1', impersonationSeconds: 900 }],
	])('accepts a valid %s launch', async (kind, extra) => {
		const clock = createClock();
		const { token } = await issueLaunch({ ...(await baseIssue(clock)), kind: /** @type {any} */ (kind), ...extra });
		const claims = await verify(clock, token);
		expect(claims.kind).toBe(kind);
		if (kind === 'impersonate') {
			expect(claims.act).toEqual({ sub: 'staff_1' });
			expect(/** @type {number} */ (claims.impExp) - claims.iat).toBe(900);
		}
	});

	it.each([
		['merchant without merchantId', { kind: 'merchant', scope: {} }],
		['admin without scope', { kind: 'admin', scope: {} }],
		['demo with a real merchant', { kind: 'demo', scope: { merchantId: 'm' } }],
		['partner without partnerId', { kind: 'partner', scope: {} }],
		['developer without developerId', { kind: 'developer', scope: {} }],
		['impersonate without actor', { kind: 'impersonate', scope: { merchantId: 'm' } }],
		['impersonate without merchant', { kind: 'impersonate', scope: {}, actor: 'staff_1' }],
		[
			'impersonate longer than 1 h',
			{ kind: 'impersonate', scope: { merchantId: 'm' }, actor: 'staff_1', impersonationSeconds: 3601 },
		],
		[
			'impersonate with zero window',
			{ kind: 'impersonate', scope: { merchantId: 'm' }, actor: 'staff_1', impersonationSeconds: 0 },
		],
		['impersonate self', { kind: 'impersonate', scope: { merchantId: 'm' }, actor: 'usr_1' }],
		['unknown kind', { kind: 'root' }],
		['missing user id', { user: {} }],
	])('refuses to issue %s', async (_name, extra) => {
		const clock = createClock();
		await expectCode(issueLaunch({ ...(await baseIssue(clock)), .../** @type {any} */ (extra) }), 'kind_scope');
	});

	it.each([
		['merchant carrying act', { kind: 'merchant', act: { sub: 's' } }],
		['admin with no scope', { kind: 'admin', scope: undefined }],
		['impersonate w/o impExp', { kind: 'impersonate', act: { sub: 's' }, impExp: undefined }],
		['impersonate > 1 h', { kind: 'impersonate', act: { sub: 's' }, impExp: 99999999999 }],
		['impersonate with bad act', { kind: 'impersonate', act: 's', impExp: 1 }],
	])('rejects a signed launch with %s', async (_name, extra) => {
		const clock = createClock();
		const { claims } = await issueLaunch(await baseIssue(clock));
		const token = await signCompact({ signer: portal.signer, typ: 'ss-launch+jwt', payload: { ...claims, ...extra } });
		await expectCode(verify(clock, token), 'kind_scope');
	});

	it('rejects an impersonation launch after its window (defence in depth)', async () => {
		const clock = createClock();
		const { claims } = await issueLaunch({
			...(await baseIssue(clock)),
			kind: 'impersonate',
			actor: 'staff_1',
			impersonationSeconds: 1,
		});
		const token = await signCompact({ signer: portal.signer, typ: 'ss-launch+jwt', payload: claims });
		clock.advance(2000);
		await expectCode(verify(clock, token), 'expired');
	});

	it('kindScopeViolation returns null for valid claims', () => {
		expect(kindScopeViolation({ kind: 'demo', user: { id: 'u' }, scope: {} })).toBeNull();
		expect(kindScopeViolation({ kind: 'demo', user: { id: 'u' } })).toBe('scope is required');
	});
});
