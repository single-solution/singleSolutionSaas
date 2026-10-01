/** Adapters: sealing, JWT signing/verification, hashing, message delivery, the site registry, platform wiring, the job. */
import { describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import {
	createSealer,
	generateSigningKeyPair,
	hmac,
	newId,
	randomSecret,
	safeEqual,
	sealSecret,
	sha256,
	signJwt,
	verifyJwt,
} from '../adapters/crypto.js';
import { createMessenger, reportsFailure } from '../adapters/messaging.js';
import { createPlatform } from '../adapters/platform.js';
import { createSiteRegistry } from '../adapters/registry.js';
import { cronAuthorized, runMaintenance } from '../jobs/maintenance.js';
import { ROOT, mongoUri } from './harness.js';

const A = Buffer.from('a'.repeat(32));
const B = Buffer.from('b'.repeat(32));

describe('sealing', () => {
	it('opens only for the same website, purpose and key; previous secrets open as stale', () => {
		const sealer = createSealer({ secrets: [A] });
		const sealed = sealer.seal({ websiteId: 'web_1', purpose: 'signing', kid: 'k1', plaintext: Buffer.from('secret') });
		expect(sealed).toMatchObject({ alg: 'A256GCM', sk: sealer.currentId });
		expect(JSON.stringify(sealed)).not.toContain('secret');
		expect(sealer.open(sealed, { websiteId: 'web_1', purpose: 'signing', kid: 'k1' })).toEqual({
			plaintext: Buffer.from('secret'),
			stale: false,
		});
		expect(sealer.open(sealed, { websiteId: 'web_2', purpose: 'signing', kid: 'k1' })).toBeNull();
		expect(sealer.open(sealed, { websiteId: 'web_1', purpose: 'pepper', kid: 'k1' })).toBeNull();
		expect(sealer.open(sealed, { websiteId: 'web_1', purpose: 'signing', kid: 'k2' })).toBeNull();
		expect(sealer.open({ ...sealed, ct: 'AAAA' }, { websiteId: 'web_1', purpose: 'signing', kid: 'k1' })).toBeNull();
		expect(
			sealer.open({ ...sealed, alg: /** @type {any} */ ('none') }, { websiteId: 'web_1', purpose: 'signing', kid: 'k1' }),
		).toBeNull();
		expect(createSealer({ secrets: [B] }).open(sealed, { websiteId: 'web_1', purpose: 'signing', kid: 'k1' })).toBeNull();
		expect(createSealer({ secrets: [B, A] }).open(sealed, { websiteId: 'web_1', purpose: 'signing', kid: 'k1' })).toEqual({
			plaintext: Buffer.from('secret'),
			stale: true,
		});
		expect(() => createSealer({ secrets: [] })).toThrow();
	});

	it('derives the sealing secret from SIGNUPS_SEAL_SECRET or the product signing key', async () => {
		expect(sealSecret({ secret: 's'.repeat(32), signingKey: null }).toString()).toBe('s'.repeat(32));
		const { privateJwk } = await generateSigningKey({ kid: 'x' });
		const derived = sealSecret({ secret: 'short', signingKey: JSON.stringify(privateJwk) });
		expect(derived).toHaveLength(32);
		expect(sealSecret({ signingKey: /** @type {any} */ (privateJwk) }).equals(derived)).toBe(true);
		expect(() => sealSecret({ signingKey: '{}' })).toThrow(/SIGNUPS_SEAL_SECRET/);
	});
});

describe('JWT and hashes', () => {
	it('signs EdDSA tokens that verify only with the right key and refuses unsafe headers', () => {
		const { publicJwk, privateJwk } = generateSigningKeyPair('kid-1');
		expect(publicJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'kid-1' });
		expect(publicJwk).not.toHaveProperty('d');
		const token = signJwt(privateJwk, { sub: 'cus_1' });
		expect(verifyJwt(token, [publicJwk])).toEqual({ ok: true, claims: { sub: 'cus_1' } });
		const other = generateSigningKeyPair('kid-1').publicJwk;
		expect(verifyJwt(token, [other])).toEqual({ ok: false, code: 'signature' });
		expect(verifyJwt(token, [{ ...publicJwk, kid: 'kid-2' }])).toEqual({ ok: false, code: 'unknown_key' });
		const b64 = (/** @type {unknown} */ v) => Buffer.from(JSON.stringify(v)).toString('base64url');
		const [, payload, sig] = token.split('.');
		expect(verifyJwt(`${b64({ alg: 'HS256', kid: 'kid-1' })}.${payload}.${sig}`, [publicJwk])).toEqual({
			ok: false,
			code: 'algorithm',
		});
		expect(verifyJwt(`${b64({ alg: 'EdDSA', kid: 'kid-1', jwk: publicJwk })}.${payload}.${sig}`, [publicJwk])).toEqual({
			ok: false,
			code: 'malformed',
		});
		expect(verifyJwt(`${b64({ alg: 'EdDSA', kid: 'kid-1' })}.${b64([1])}.${sig}`, [publicJwk])).toEqual({
			ok: false,
			code: 'malformed',
		});
		expect(verifyJwt(`${b64('x')}.${payload}.${sig}`, [publicJwk])).toEqual({ ok: false, code: 'malformed' });
		expect(verifyJwt('a.b', [publicJwk])).toEqual({ ok: false, code: 'malformed' });
		expect(verifyJwt('!!.@@.##', [publicJwk])).toEqual({ ok: false, code: 'malformed' });
		expect(verifyJwt('YQ.YQ.YQ', [publicJwk])).toEqual({ ok: false, code: 'malformed' });
		expect(verifyJwt(42, [publicJwk])).toEqual({ ok: false, code: 'malformed' });
		expect(verifyJwt(token, [{ ...publicJwk, x: 'bad' }])).toEqual({ ok: false, code: 'signature' });
	});

	it('hashes, compares in constant time and makes ids and secrets', () => {
		expect(hmac(A, 'x')).toMatch(/^[0-9a-f]{64}$/);
		expect(hmac(A, 'x')).not.toBe(hmac(B, 'x'));
		expect(sha256('x')).toHaveLength(64);
		expect(safeEqual('abc', 'abc')).toBe(true);
		expect(safeEqual('abc', 'abd')).toBe(false);
		expect(safeEqual('abc', 'ab')).toBe(false);
		expect(newId('cus')).toMatch(/^cus_[0-9a-z]{26}$/);
		expect(randomSecret(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});

describe('messaging', () => {
	it('recognises gateways that answer 2xx for a failed send', () => {
		for (const body of [{ error: 'x' }, { sent: 'false' }, { sent: 0 }, { success: false }, { status: 'Failed ' }])
			expect(reportsFailure(body)).toBe(true);
		for (const body of [{ sent: 'true' }, { error: null }, { error: '' }, { status: 'queued' }, 'OK', null, [1]])
			expect(reportsFailure(body)).toBe(false);
	});
	it('maps connector failures without logging the message', async () => {
		const warn = vi.fn();
		const message = {
			channel: 'sms',
			to: '+1',
			text: 'secret 123',
			purpose: 'otp',
			lang: 'en',
			reference: 'r',
			idempotencyKey: 'k',
			variables: { code: '123' },
		};
		const ok = createMessenger({ connectors: { messaging: async () => ({ send: async () => ({ id: 'm' }) }) }, log: { warn } });
		expect(await ok.send('web_1', message)).toEqual({ ok: true });
		const refused = createMessenger({
			connectors: { messaging: async () => ({ send: async () => ({ sent: false }) }) },
			log: { warn },
		});
		expect(await refused.send('web_1', message)).toEqual({ ok: false, code: 'delivery_failed' });
		const missing = createMessenger({
			connectors: {
				messaging: async () => {
					throw Object.assign(new Error('x'), { code: 'not_implemented' });
				},
			},
		});
		expect(await missing.send('web_1', message)).toEqual({ ok: false, code: 'resource_missing' });
		const down = createMessenger({
			connectors: {
				messaging: async () => ({
					send: async () => {
						throw new Error('boom');
					},
				}),
			},
			log: { warn },
		});
		expect(await down.send('web_1', message)).toEqual({ ok: false, code: 'delivery_failed' });
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret 123');
	});
});

describe('site registry', () => {
	it('remembers websites in memory or in the control database (and retries failed writes)', async () => {
		const memory = createSiteRegistry();
		await memory.remember('web_b');
		await memory.remember('web_a');
		await memory.remember('web_a');
		expect(await memory.list()).toEqual(['web_a', 'web_b']);
		let fail = true;
		const updateOne = vi.fn(async () => {
			if (fail) {
				fail = false;
				throw new Error('down');
			}
		});
		const stored = createSiteRegistry({ collection: { updateOne, find: () => ({ toArray: async () => [{ _id: 'web_z' }] }) } });
		await stored.remember('web_c');
		await stored.remember('web_c');
		expect(updateOne).toHaveBeenCalledTimes(2);
		expect(await stored.list()).toEqual(['web_c', 'web_z']);
	});
});

describe('platform and job', () => {
	it('refuses to start without the required environment and wires a control database when configured', async () => {
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(
			/SS_PORTAL_URL, SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH/,
		);
		const { privateJwk } = await generateSigningKey({ kid: 'p' });
		const app = await createPlatform({
			env: {
				SS_PORTAL_URL: 'https://portal.test',
				SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
				SS_REGISTRATION_TOKEN_HASH: 'a'.repeat(64),
				SS_PRODUCT_DB_URI: mongoUri('signups_control_test'),
				SIGNUPS_SEAL_SECRET_PREVIOUS: 'p'.repeat(40),
				CRON_SECRET: 'short',
			},
			root: ROOT,
		});
		expect(app.cronSecret).toBeNull();
		expect(app.base).toBe('https://signups.example.com');
		await app.registry.remember('web_control');
		expect(await app.registry.list()).toContain('web_control');
		await app.close();
	});

	it('runs maintenance per website, isolating failures, behind a constant-time cron secret', async () => {
		const onError = vi.fn();
		const result = await runMaintenance({
			websiteIds: ['web_a', 'web_b', 'web_c'],
			siteFor: async (id) => (id === 'web_c' ? null : { id }),
			run: async (site) => {
				if (site.id === 'web_b') throw new Error('boom');
				return { deletions: 1 };
			},
			onError,
		});
		expect(result).toEqual({
			websites: 2,
			results: [
				{ websiteId: 'web_a', deletions: 1 },
				{ websiteId: 'web_b', error: 'failed' },
			],
		});
		expect(onError).toHaveBeenCalledWith('web_b', expect.any(Error));
		expect(
			(
				await runMaintenance({
					websiteIds: ['x'],
					siteFor: async () => {
						throw new Error('y');
					},
					run: async () => ({}),
				})
			).results,
		).toEqual([{ websiteId: 'x', error: 'failed' }]);
		expect(cronAuthorized('Bearer secret-value', 'secret-value')).toBe(true);
		expect(cronAuthorized('Bearer nope', 'secret-value')).toBe(false);
		expect(cronAuthorized(null, 'secret-value')).toBe(false);
		expect(cronAuthorized('Bearer x', null)).toBe(false);
	});
});
