import { beforeAll, describe, expect, it } from 'vitest';
import {
	consumeWith,
	createJwks,
	createKeyResolver,
	createMemoryReplayStore,
	issueLaunch,
	launchViolation,
	verifyLaunch,
} from '../src/index.js';
import { signCompact } from '../src/jws.js';
import {
	T0,
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
const AUD = 'chat';
const SESSION_END = new Date(T0 + 12 * 3_600_000).toISOString();
const branding = { name: 'Single Solution', accent: '#4f46e5', logoUrl: 'https://portal.test/branding/logo?v=1' };
const support = { email: 'help@portal.test', phone: '+1 555 0100', whatsapp: '+1 555 0101' };
const merchant = {
	id: 'mer_1',
	name: 'Shop',
	websites: [
		{ websiteId: 'web_1', domain: 'shop.com' },
		{ websiteId: 'web_2', domain: 'www.shop.com' },
	],
	websiteId: 'web_2',
};
const admin = { id: 'adm_1', name: 'Ann', role: /** @type {const} */ ('support'), websiteId: null };

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
		kind: 'merchant',
		sessionExpiresAt: SESSION_END,
		branding,
		support,
		merchant,
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

/**
 * Sign arbitrary launch claims with the Portal key.
 * @param {Record<string, unknown>} payload
 */
const signRaw = (payload) => signCompact({ signer: portal.signer, typ: 'ss-launch+jwt', payload });

describe('launches', () => {
	it('issues a 60 s single-use merchant launch and verifies it', async () => {
		const clock = createClock();
		const { token, claims } = await issue(clock);
		expect(claims.exp - claims.iat).toBe(60);
		expect(claims.sub).toBe('mer_1');
		expect(claims).not.toHaveProperty('admin');
		expect(decodeSegment(token, 0)).toEqual({ alg: 'EdDSA', kid: 'portal-1', typ: 'ss-launch+jwt' });
		const verified = await verify(clock, token);
		expect(verified).toMatchObject({
			kind: 'merchant',
			sub: 'mer_1',
			merchant,
			branding,
			support,
			sessionExpiresAt: SESSION_END,
		});
		expect(verified.jti.length).toBeGreaterThan(10);
	});

	it('issues an admin launch with or without a website', async () => {
		const clock = createClock();
		const defaults = await issue(clock, { kind: 'admin', merchant: undefined, admin });
		expect(await verify(clock, defaults.token)).toMatchObject({ kind: 'admin', sub: 'adm_1', admin });
		const picked = await issue(clock, {
			kind: 'admin',
			merchant: undefined,
			admin: { ...admin, role: 'owner', websiteId: 'web_9' },
			support: { email: '', phone: '' },
			branding: { ...branding, logoUrl: null },
			jti: 'launch-jti-0001',
		});
		expect(picked.claims.jti).toBe('launch-jti-0001');
		expect((await verify(clock, picked.token)).admin).toEqual({ ...admin, role: 'owner', websiteId: 'web_9' });
	});

	it('rejects a replayed jti', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		const consume = consumeWith(createMemoryReplayStore({ now: clock.now }));
		await verify(clock, token, { consume });
		await expectCode(verify(clock, token, { consume }), 'replay');
	});

	it('rejects expired, not-yet-valid and over-long launches, and ended Portal sessions', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		clock.advance(66_000);
		await expectCode(verify(clock, token), 'expired');
		const future = createClock(clock.now() + 3_600_000);
		const { token: fromFuture } = await issue(future);
		await expectCode(verify(clock, fromFuture), 'not_yet_valid');
		const long = await signRaw({ ...(await issue(clock)).claims, exp: Math.floor(clock.now() / 1000) + 3600 });
		await expectCode(verify(clock, long), 'lifetime_too_long');
		const ended = await signRaw({ ...(await issue(clock)).claims, sessionExpiresAt: new Date(clock.now() - 1).toISOString() });
		await expectCode(verify(clock, ended), 'expired');
		await expectCode(issue(clock, { sessionExpiresAt: new Date(clock.now()).toISOString() }), 'invalid_launch');
	});

	it('rejects wrong audience, issuer, kid, signature, type and tampering', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		await expectCode(verify(clock, token, { audience: 'growth' }), 'audience');
		await expectCode(verify(clock, token, { issuer: 'https://evil.test' }), 'issuer');
		await expectCode(verify(clock, token, { keyResolver: staticResolver([]) }), 'unknown_kid');
		await expectCode(verify(clock, token, { keyResolver: staticResolver([attacker.publicJwk]) }), 'signature');
		await expectCode(verify(clock, tamperSignature(token)), 'signature');
		await expectCode(
			verify(
				clock,
				tamperSegment(token, 1, (p) => ({ ...p, merchant: { ...p.merchant, websiteId: 'web_1' } })),
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
		await expectCode(verify(clock, (await issue(clock, { signer: attacker.signer })).token), 'signature');
		await expectCode(verify(clock, (await issue(clock, { audience: 'growth' })).token), 'audience');
	});

	it('rejects a revoked signing key', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
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
		await expectCode(verify(clock, await signRaw({ ...claims, jti: undefined })), 'malformed');
		await expectCode(verify(clock, await signRaw({ ...claims, exp: undefined })), 'malformed');
		await expectCode(verify(clock, await signRaw({ ...claims, iat: undefined })), 'malformed');
		await expectCode(verify(clock, await signRaw({ ...claims, nbf: 'x' })), 'malformed');
		await expectCode(verify(clock, await signRaw({ ...claims, exp: claims.iat })), 'malformed');
		await expectCode(verify(clock, await signRaw({ ...claims, nbf: claims.iat + 30 })), 'not_yet_valid');
		await expectCode(verify(clock, await signRaw({ ...claims, kind: 'finance' })), 'invalid_launch');
		await expectCode(verify(clock, await signRaw({ ...claims, sub: 'mer_2' })), 'invalid_launch');
		await expectCode(verify(clock, await signRaw({ ...claims, admin })), 'invalid_launch');
	});
});

describe('launch rules', () => {
	/** @type {Array<[string, Record<string, unknown>]>} */
	const refused = [
		['an unknown kind', { kind: 'root' }],
		['a merchant launch without merchant', { merchant: undefined }],
		['a merchant that is not an object', { merchant: 'mer_1' }],
		['a merchant without a name', { merchant: { ...merchant, name: '' } }],
		['a merchant without websites', { merchant: { ...merchant, websites: [] } }],
		['a website entry without a domain', { merchant: { ...merchant, websites: [{ websiteId: 'web_2' }] } }],
		['a website outside the list', { merchant: { ...merchant, websiteId: 'web_3' } }],
		['both merchant and admin', { admin }],
		['an admin launch without admin', { kind: 'admin', merchant: undefined }],
		['an admin without an id', { kind: 'admin', merchant: undefined, admin: { ...admin, id: '' } }],
		['a finance admin', { kind: 'admin', merchant: undefined, admin: { ...admin, role: 'finance' } }],
		['an admin website that is not a string', { kind: 'admin', merchant: undefined, admin: { ...admin, websiteId: 7 } }],
		['a session end that is not ISO UTC', { sessionExpiresAt: '2026-10-01 12:00' }],
		['a session end that is no date', { sessionExpiresAt: '2026-19-45T99:00:00Z' }],
		['missing branding', { branding: undefined }],
		['branding without a name', { branding: { ...branding, name: '' } }],
		['a bad accent', { branding: { ...branding, accent: 'indigo' } }],
		['a bad logo URL', { branding: { ...branding, logoUrl: 'javascript:alert(1)' } }],
		['a logo URL with userinfo', { branding: { ...branding, logoUrl: 'https://u:p@x.test/logo' } }],
		['a logo URL that is not a URL', { branding: { ...branding, logoUrl: 'not a url' } }],
		['missing support', { support: null }],
		['support without phone', { support: { email: 'a@b.c' } }],
		['support with a bad whatsapp', { support: { ...support, whatsapp: 5 } }],
	];
	it.each(refused)('refuses to issue %s', async (_name, extra) => {
		const clock = createClock();
		await expectCode(issue(clock, extra), 'invalid_launch');
	});

	it('launchViolation explains each rule and returns null for valid claims', () => {
		const base = { kind: 'merchant', sub: 'mer_1', merchant, sessionExpiresAt: SESSION_END, branding, support };
		expect(launchViolation(base)).toBeNull();
		expect(launchViolation({ ...base, merchant: { ...merchant, websiteId: 'x' } })).toBe(
			'merchant.websiteId must be one of merchant.websites',
		);
		expect(launchViolation({ ...base, kind: 'admin', merchant: undefined, admin: { ...admin, role: 'finance' } })).toBe(
			'admin.role must be owner or support',
		);
		expect(launchViolation({ ...base, kind: 'admin', sub: 'adm_1', merchant: undefined, admin })).toBeNull();
	});
});
