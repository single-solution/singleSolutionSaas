import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateEntitlementDocument } from '@ss/contracts';
import {
	JWKS_RETRY_MS,
	JWKS_TTL_MS,
	identitySection,
	jwksDue,
	keysOfJwks,
	normaliseJwk,
	parseIssuer,
	presentIssuer,
} from '../../../src/modules/identity/core/issuer.js';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/**
 * A public JWK of a fresh key pair.
 * @param {'ed25519' | 'ec' | 'rsa'} type
 * @param {string} kid
 */
const publicJwk = (type, kid) => {
	const pair =
		type === 'ed25519'
			? generateKeyPairSync('ed25519')
			: type === 'ec'
				? generateKeyPairSync('ec', { namedCurve: 'P-256' })
				: generateKeyPairSync('rsa', { modulusLength: 2048 });
	return { ...pair.publicKey.export({ format: 'jwk' }), kid };
};
const ED = publicJwk('ed25519', 'ed-1');
const EC = publicJwk('ec', 'ec-1');
const RSA = publicJwk('rsa', 'rsa-1');

describe('identity issuer core', () => {
	it('normalises public signature keys and refuses everything else', () => {
		expect(normaliseJwk(ED)).toMatchObject({
			ok: true,
			key: { kty: 'OKP', crv: 'Ed25519', kid: 'ed-1', alg: 'EdDSA', use: 'sig' },
		});
		expect(normaliseJwk(EC)).toMatchObject({ ok: true, key: { kty: 'EC', alg: 'ES256' } });
		expect(normaliseJwk({ ...RSA, alg: 'RS256', use: 'sig' })).toMatchObject({ ok: true, key: { kty: 'RSA', alg: 'RS256' } });
		const smallRsa = { ...generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' }), kid: 's' };
		/** @type {Array<[unknown, string]>} */
		const refused = [
			[null, 'not an object'],
			[{ ...ED, d: 'x' }, 'private key material'],
			[{ ...ED, kty: 'oct' }, 'unsupported key type'],
			[{ ...ED, kid: undefined }, 'kid missing'],
			[{ ...ED, use: 'enc' }, 'not a signature key'],
			[{ ...ED, alg: 'ES256' }, 'unsupported algorithm'],
			[{ ...ED, crv: 'X25519' }, 'not an Ed25519 key'],
			[{ ...EC, y: undefined }, 'not a P-256 key'],
			[{ ...RSA, e: '' }, 'not an RSA key'],
			[smallRsa, 'RSA keys need at least 2048 bits'],
			[{ ...ED, x: 'AAAA' }, 'not a valid public key'],
		];
		for (const [jwk, reason] of refused) expect(normaliseJwk(jwk)).toEqual({ ok: false, reason });
	});

	it('keeps the usable keys of a JWKS (≤ 5, first kid wins)', () => {
		const many = Array.from({ length: 7 }, (_, i) => ({ ...ED, kid: `k${i}` }));
		expect(keysOfJwks({ keys: [{ ...ED, d: 'x' }, ED, { ...EC, kid: 'ed-1' }, ...many] })).toMatchObject({
			ok: true,
			skipped: 5,
		});
		expect(
			keysOfJwks({ keys: [ED, ...many] }).ok && /** @type {any} */ (keysOfJwks({ keys: [ED, ...many] })).keys,
		).toHaveLength(5);
		expect(keysOfJwks({ keys: [{ kty: 'oct', kid: 'x' }] })).toEqual({ ok: false, reason: 'no usable signature key' });
		expect(keysOfJwks([])).toEqual({ ok: false, reason: 'not a JWKS document' });
	});

	it('parses issuer bodies', () => {
		expect(parseIssuer({ issuer: 'https://login.example.com/', publicJwks: [ED] })).toMatchObject({
			ok: true,
			value: { issuer: 'https://login.example.com/', jwksUrl: null, audience: null, claimMap: { subject: 'sub' } },
		});
		expect(
			parseIssuer({
				issuer: 'acme',
				jwksUrl: 'https://login.example.com/.well-known/jwks.json',
				audience: 'shop',
				claimMap: { subject: 'uid', email: 'mail', phone: 'https://example.com/claims/phone' },
			}),
		).toMatchObject({ ok: true, value: { audience: 'shop', claimMap: { subject: 'uid', email: 'mail' } } });
		/** @param {unknown} body */
		const paths = (body) => {
			const parsed = parseIssuer(body);
			return parsed.ok ? [] : parsed.errors.map((e) => e.path);
		};
		expect(paths(7)).toEqual(['']);
		expect(paths({ issuer: '', extra: 1 })).toEqual(['/extra', '/issuer', '/jwksUrl']);
		expect(paths({ issuer: 'a', jwksUrl: 'https://x.example/j', publicJwks: [ED] })).toEqual(['/jwksUrl']);
		expect(paths({ issuer: 'a', jwksUrl: 'ftp://x.example/j' })).toEqual(['/jwksUrl']);
		expect(paths({ issuer: 'a', publicJwks: [] })).toEqual(['/publicJwks']);
		expect(paths({ issuer: 'a', publicJwks: [ED, { ...ED }] })).toEqual(['/publicJwks/1/kid']);
		expect(paths({ issuer: 'a', publicJwks: [{ ...ED, d: 'x' }] })).toEqual(['/publicJwks/0']);
		expect(paths({ issuer: 'a', publicJwks: [ED], audience: ' ' })).toEqual(['/audience']);
		expect(paths({ issuer: 'a', publicJwks: [ED], claimMap: 'sub' })).toEqual(['/claimMap']);
		expect(paths({ issuer: 'a', publicJwks: [ED], claimMap: { subject: '1 x', other: 'y', email: '' } })).toEqual([
			'/claimMap/subject',
			'/claimMap/other',
		]);
	});

	it('builds the document section, schedules JWKS refreshes and presents issuers', () => {
		const key = /** @type {any} */ (normaliseJwk(ED)).key;
		expect(identitySection(null)).toBeNull();
		expect(identitySection({ issuer: 'a', keys: [], claimMap: { subject: 'sub' } })).toBeNull();
		const section = identitySection({ issuer: 'a', keys: [key], audience: 'shop', claimMap: { subject: 'sub' } });
		expect(section).toEqual({ issuer: 'a', jwks: [key], audience: 'shop', claimMap: { subject: 'sub' } });
		const now = Date.parse('2026-10-01T10:00:00Z');
		expect(jwksDue({ jwksUrl: null }, now)).toBe(false);
		expect(jwksDue({ jwksUrl: 'https://x', keysFetchedAt: null }, now)).toBe(true);
		expect(jwksDue({ jwksUrl: 'https://x', keysFetchedAt: new Date(now - JWKS_TTL_MS + 1) }, now)).toBe(false);
		expect(jwksDue({ jwksUrl: 'https://x', keysFetchedAt: new Date(now - JWKS_TTL_MS) }, now)).toBe(true);
		expect(jwksDue({ jwksUrl: 'https://x', keysFailedAt: new Date(now - JWKS_RETRY_MS + 1) }, now)).toBe(false);
		expect(presentIssuer({ _id: 'web_1', issuer: 'a', claimMap: { subject: 'sub' } })).toMatchObject({
			websiteId: 'web_1',
			source: 'inline',
			keys: [],
			keysFetchedAt: null,
			createdAt: null,
		});
	});
});

describe('identity issuers (routes and service)', () => {
	/**
	 * @param {{ jwks?: () => { status: number, body: string } | Error }} [options]
	 */
	const setup = async ({ jwks } = {}) => {
		/** @type {string[]} */
		const fetched = [];
		const fetch = /** @type {any} */ (
			async (/** @type {string} */ url) => {
				fetched.push(url);
				const answer = jwks?.() ?? { status: 200, body: JSON.stringify({ keys: [ED, EC] }) };
				if (answer instanceof Error) throw answer;
				return { status: answer.status, headers: {}, body: Buffer.from(answer.body), url };
			}
		);
		const h = await boot({ identity: { issuers: { fetch } } });
		const owner = await h.signupOwner('o@example.com');
		const created = await owner.admin.post(`/v1/merchants/${owner.merchantId}/websites`, { domain: 'shop.example.com' });
		const websiteId = created.json.website.websiteId;
		const path = `/v1/merchants/${owner.merchantId}/websites/${websiteId}/identity`;
		return { h, owner, websiteId, path, fetched };
	};

	it('registers inline keys, exposes the document section, replaces and removes the issuer (audited, re-signed)', async () => {
		const { h, owner, websiteId, path } = await setup();
		expect((await owner.client.get(path)).json).toEqual({ issuer: null, request: null });
		expect(await h.service.identityFor(websiteId)).toBeNull();
		const put = await owner.client.send('PUT', path, {
			issuer: 'https://login.shop.example.com/',
			publicJwks: [ED, RSA],
			audience: 'shop-web',
			claimMap: { subject: 'sub', email: 'email' },
		});
		expect(put.status).toBe(200);
		expect(put.json.issuer).toMatchObject({
			websiteId,
			source: 'inline',
			audience: 'shop-web',
			keys: [
				{ kid: 'ed-1', kty: 'OKP', alg: 'EdDSA' },
				{ kid: 'rsa-1', kty: 'RSA', alg: 'RS256' },
			],
		});
		const section = await h.service.identityFor(websiteId);
		expect(section).toMatchObject({
			issuer: 'https://login.shop.example.com/',
			audience: 'shop-web',
			claimMap: { email: 'email' },
		});
		expect(JSON.stringify(section)).not.toContain('"d"');
		// the section validates inside a canonical document
		const doc = {
			subscriptionId: 'sub_0123456789abcdefghjkmnpq',
			websiteId,
			merchantId: owner.merchantId,
			domain: 'shop.example.com',
			allowSubdomains: false,
			env: 'live',
			productSlug: 'loyalty',
			priceBookVersion: '2026-10-01',
			version: 1,
			issuedAt: '2026-10-01T10:00:00Z',
			validFrom: '2026-10-01T10:00:00Z',
			validUntil: '2026-10-01T10:10:00Z',
			elements: {},
			features: {},
			config: {},
			runtime: { state: 'active' },
			resources: [],
			dataScope: { prefix: 'ss_loyalty_' },
			identity: section,
		};
		expect(validateEntitlementDocument(doc).ok).toBe(true);
		expect(h.commerce.invalidated).toEqual([websiteId]);

		const replaced = await owner.client.send('PUT', path, { issuer: 'acme', publicJwks: [EC] });
		expect(replaced.json.issuer).toMatchObject({ issuer: 'acme', audience: null, keys: [{ kid: 'ec-1' }] });
		expect((await owner.client.get(path)).json.issuer.issuer).toBe('acme');
		const audits = await h.db
			.collection('platform_audit')
			.find({ action: { $regex: '^website\\.identity' } })
			.toArray();
		expect(audits.map((a) => a.action)).toEqual(['website.identity_set', 'website.identity_updated']);

		expect((await owner.client.post(`${path}/refresh`)).status).toBe(409); // inline keys: nothing to fetch
		expect((await owner.client.del(path)).json).toEqual({ websiteId, removed: true });
		expect((await owner.client.del(path)).status).toBe(404);
		expect((await owner.client.post(`${path}/refresh`)).status).toBe(404);
		expect(await h.service.identityFor(websiteId)).toBeNull();
		expect(h.commerce.invalidated).toHaveLength(3);
	});

	it('validates bodies and keeps other merchants out', async () => {
		const { h, owner, path } = await setup();
		const bad = await owner.client.send('PUT', path, { issuer: 'a', publicJwks: [{ ...ED, d: 'secret' }] });
		expect(bad.status).toBe(422);
		expect(bad.json.errors).toEqual([{ path: '/publicJwks/0', message: 'private key material' }]);
		const other = await h.signupOwner('x@example.com');
		expect((await other.client.get(path)).status).toBe(403);
		const foreign = path.replace(owner.merchantId, other.merchantId);
		expect((await other.client.get(foreign)).status).toBe(404);
		expect(await h.service.identityFor(/** @type {any} */ (7))).toBeNull();
	});

	it('fetches a JWKS URL on save, refreshes it hourly and keeps the last good keys on failure', async () => {
		/** @type {Array<{ status: number, body: string } | Error>} */
		const answers = [];
		const { h, owner, websiteId, path, fetched } = await setup({
			jwks: () => answers.shift() ?? { status: 200, body: JSON.stringify({ keys: [ED, EC] }) },
		});
		const jwksUrl = 'https://login.shop.example.com/.well-known/jwks.json';

		answers.push({ status: 500, body: '' });
		const refused = await owner.client.send('PUT', path, { issuer: 'acme', jwksUrl });
		expect(refused.status).toBe(422);
		expect(refused.json.errors[0].message).toContain('500');
		answers.push({ status: 200, body: 'not json' });
		expect((await owner.client.send('PUT', path, { issuer: 'acme', jwksUrl })).json.errors[0].message).toContain('not JSON');
		answers.push(Object.assign(new Error('timeout'), { name: 'NetError', code: 'timeout', reason: 'deadline' }));
		const network = await owner.client.send('PUT', path, { issuer: 'acme', jwksUrl });
		expect(network.status).toBe(422);
		const ssrf = await owner.client.send('PUT', path, { issuer: 'acme', jwksUrl: 'https://10.0.0.5/jwks' });
		expect(ssrf.json.errors[0].message).toContain('destination refused');

		const saved = await owner.client.send('PUT', path, { issuer: 'acme', jwksUrl });
		expect(saved.json.issuer).toMatchObject({
			source: 'jwks_url',
			jwksUrl,
			keys: [{ kid: 'ed-1' }, { kid: 'ec-1' }],
			lastError: null,
		});
		const calls = fetched.length;
		expect((await h.service.identityFor(websiteId))?.jwks).toHaveLength(2);
		expect(fetched.length).toBe(calls); // fresh: no refetch

		h.clock.advance(JWKS_TTL_MS);
		answers.push({ status: 503, body: '' });
		expect((await h.service.identityFor(websiteId))?.jwks).toHaveLength(2); // failure keeps the last good keys
		expect((await owner.client.get(path)).json.issuer.lastError).toContain('503');
		expect(fetched.length).toBe(calls + 1);
		await h.service.identityFor(websiteId);
		expect(fetched.length).toBe(calls + 1); // retry back-off
		h.clock.advance(JWKS_RETRY_MS);
		answers.push({ status: 200, body: JSON.stringify({ keys: [RSA] }) });
		expect((await h.service.identityFor(websiteId))?.jwks.map((k) => k.kid)).toEqual(['rsa-1']);

		const refreshed = await owner.client.post(`${path}/refresh`);
		expect(refreshed.json.issuer).toMatchObject({ lastError: null, keys: [{ kid: 'ed-1' }, { kid: 'ec-1' }] });
	});

	it('forgets the issuer when the website is removed', async () => {
		const { h, owner, websiteId, path } = await setup();
		await owner.client.send('PUT', path, { issuer: 'acme', publicJwks: [ED] });
		expect(await h.service.identityFor(websiteId)).not.toBeNull();
		await owner.admin.del(`/v1/merchants/${owner.merchantId}/websites/${websiteId}`, { confirm: 'shop.example.com' });
		expect(await h.service.identityFor(websiteId)).toBeNull();
	});

	it('does not fail a change when documents cannot be re-signed', async () => {
		const h = await boot({ commerce: { fail: true } });
		const owner = await h.signupOwner('o@example.com');
		const created = await owner.admin.post(`/v1/merchants/${owner.merchantId}/websites`, { domain: 'shop.example.com' });
		const path = `/v1/merchants/${owner.merchantId}/websites/${created.json.website.websiteId}/identity`;
		expect((await owner.client.send('PUT', path, { issuer: 'acme', publicJwks: [ED] })).status).toBe(200);
		expect(h.entries.some((e) => e.msg.includes('not re-signed'))).toBe(true);
	});
});
