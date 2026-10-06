/** adapters/ and the composition helpers: tokens, keyset filters, platform wiring, settings and the plain server. */
import { describe, expect, it } from 'vitest';
import { noopLogger } from '@ss/app-kit';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { afterPair, beforePair, createRepositories, isDuplicateKey } from '../adapters/db.js';
import { createPlatform, loadManifest, loadStrings } from '../adapters/platform.js';
import { createReportTokens, stableId } from '../adapters/tokens.js';
import { failure, invalid, pageContext } from '../api/routes.js';
import { ELEMENT_KEYS, settingsFrom } from '../api/settings.js';
import { startServer } from '../serve.js';
import { ROOT } from './harness.js';

describe('tokens', () => {
	it('derives stable ids and issues report tokens whose hash is stored', () => {
		expect(stableId('a')).toBe(stableId('a'));
		expect(stableId('a')).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(stableId('a')).not.toBe(stableId('b'));
		const tokens = createReportTokens({ randomBytes: (n) => new Uint8Array(n).fill(7) });
		const { token, hash } = tokens.issue();
		expect(token).toMatch(/^grr_[A-Za-z0-9_-]{43}$/);
		expect(tokens.hashOf(token)).toBe(hash);
		expect(hash).not.toContain(token.slice(4));
		expect(tokens.hashOf('grr_short')).toBeNull();
		expect(tokens.hashOf(5)).toBeNull();
		expect(createReportTokens().issue().token).not.toBe(createReportTokens().issue().token);
	});
});

describe('db helpers', () => {
	it('builds keyset filters and recognises duplicate keys', () => {
		expect(beforePair('addedAt', '2026|unt_1')).toEqual({
			$or: [{ addedAt: { $lt: '2026' } }, { addedAt: '2026', id: { $lt: 'unt_1' } }],
		});
		expect(beforePair('addedAt', 'bad')).toEqual({});
		expect(beforePair('addedAt', null)).toEqual({});
		expect(afterPair('itemId', 'variantKey', 'a|_')).toEqual({
			$or: [{ itemId: { $gt: 'a' } }, { itemId: 'a', variantKey: { $gt: '_' } }],
		});
		expect(afterPair('itemId', 'variantKey', 'a|b|c')).toEqual({});
		expect(isDuplicateKey({ code: 11000 })).toBe(true);
		expect(isDuplicateKey(new Error('x'))).toBe(false);
		expect(() => createRepositories(/** @type {any} */ ({ websiteId: '', collection: () => ({}) }))).toThrow(TypeError);
	});
});

describe('route helpers', () => {
	it('reads the Loader page context and maps failures to problems', () => {
		expect(pageContext({ ctx: JSON.stringify({ itemId: 'itm_1', path: '/' }), tier: 'good' })).toEqual({
			itemId: 'itm_1',
			tier: 'good',
			token: null,
			collection: null,
		});
		expect(pageContext({ ctx: '[1]', itemId: 'a b', tier: 'Bad', collection: 'c', token: 'grr_x' })).toEqual({
			itemId: null,
			tier: null,
			token: 'grr_x',
			collection: 'c',
		});
		expect(pageContext({ ctx: '{' })).toEqual({ itemId: null, tier: null, token: null, collection: null });
		expect(pageContext({ ctx: 'x'.repeat(3000) }).itemId).toBeNull();
		expect(invalid([{ path: '/a', code: 'bad_value' }])).toMatchObject({
			code: 'validation_failed',
			errors: [{ path: '/a', code: 'bad_value', message: 'bad value' }],
		});
		expect(failure({ reason: 'validation_failed' })).toMatchObject({ code: 'validation_failed', errors: [] });
		expect(failure({ reason: 'not_found', detail: 'No.' })).toMatchObject({ code: 'not_found', detail: 'No.' });
		expect(failure({ reason: 'unit_limit' })).toMatchObject({ code: 'unit_limit', detail: 'unit limit' });
		expect(failure({ reason: 'tier_unknown', errors: [{ path: '/tier', code: 'tier_unknown' }] })).toMatchObject({
			code: 'tier_unknown',
			errors: [{ path: '/tier', code: 'tier_unknown', message: 'tier unknown' }],
		});
	});
});

describe('settings', () => {
	it('applies defaults, the website time zone and language', () => {
		const settings = settingsFrom({
			can: () => true,
			config: () => ({}),
			website: { timeZone: 'Asia/Karachi', language: 'ur-PK' },
		});
		expect(ELEMENT_KEYS).toEqual(['tiers', 'showcase', 'filters', 'warranty', 'mapping', 'inspection']);
		expect(settings.timeZone).toBe('Asia/Karachi');
		expect(settings.language).toBe('ur-PK');
		expect(settings.tiers.map((tier) => tier.key)).toEqual(['new', 'excellent', 'good', 'fair']);
		expect(settings.defaultTier).toBeNull();
		expect(settings.vocabularies.map((v) => v.key)).toEqual(['schema_org', 'shopping_feed']);
		expect(settings.checklists.map((c) => c.key)).toEqual(['standard']);
		expect(settingsFrom({ can: () => false, config: () => null, website: { timeZone: 'Mars/Base' } }).timeZone).toBe('UTC');
		expect(settingsFrom({ can: () => true, config: () => ({}) })).toMatchObject({ timeZone: 'UTC', language: null });
	});
});

describe('platform', () => {
	it('loads the manifest with inline features and the string catalogs', async () => {
		const manifest = await loadManifest(ROOT);
		expect(manifest.elements.every((/** @type {any} */ element) => element.features?.type === 'object')).toBe(true);
		const strings = await loadStrings(ROOT);
		expect(strings.en?.['tiers.title']).toBe('Grades');
	});

	it('refuses to start without the Portal variables', async () => {
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(/PORTAL_URL, SIGNING_KEY, REGISTRATION_TOKEN_HASH/);
	});

	it('serves over plain http and https-less hosts through serve.js', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'grades-serve-1' });
		const server = await startServer({
			port: 0,
			root: ROOT,
			env: {
				PORTAL_URL: 'http://127.0.0.1:9',
				SIGNING_KEY: `${privateJwk.kid}:${privateJwk.d}`,
				REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_grades_serve_0123456789abcdef'),
			},
			overrides: { logger: noopLogger },
		});
		try {
			const health = await fetch(`${server.url}/healthz`);
			expect(health.status).toBe(200);
			const manifest = await fetch(`${server.url}/.well-known/ss-app.json`);
			expect((await manifest.json()).product.slug).toBe('grades');
			const posted = await fetch(`${server.url}/v1/tier-assignments`, { method: 'POST', body: '{}' });
			expect(posted.status).toBe(401);
		} finally {
			await server.close();
		}
	});
});
