/** adapters/ and the composition helpers: tokens, keyset filters, platform wiring, settings and the composed request handler. */
import { describe, expect, it } from 'vitest';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { generateSigningKey } from '@ss/protocol';
import { afterPair, beforePair, createRepositories, isDuplicateKey } from '../adapters/db.js';
import { createPlatform, loadManifest, loadStrings } from '../adapters/platform.js';
import { createReportTokens, stableId } from '../adapters/tokens.js';
import { buildRoutes, createGrades, failure, invalid, pageContext, wireEvents } from '../api/routes.js';
import { ELEMENT_KEYS, settingsFrom } from '../api/settings.js';
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
	it('reads the page values of a query and maps failures to problems', () => {
		expect(pageContext({ itemId: 'itm_1', tier: 'good' })).toEqual({ itemId: 'itm_1', tier: 'good', collection: null });
		expect(pageContext({ itemId: 'a b', tier: 'Bad', collection: 'c' })).toEqual({ itemId: null, tier: null, collection: 'c' });
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
		// no environment at all: an unconnected product (in-memory control store) that only serves its connect endpoint
		const unconnected = await createPlatform({ env: {}, root: ROOT });
		expect(unconnected.product.connected()).toBe(false);
		await unconnected.close?.();
	});

	it('composes the request handler from the platform and the routes', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'grades-serve-1' });
		const app = await createPlatform({
			env: {},
			root: ROOT,
			overrides: { portalUrl: 'http://127.0.0.1:9', signingKey: `${privateJwk.kid}:${privateJwk.d}`, logger: noopLogger },
		});
		const grades = wireEvents(createGrades(app));
		const handle = createRequestHandler(grades.product, buildRoutes(grades));
		try {
			const manifest = await handle(new Request('http://127.0.0.1/.well-known/ss-app.json'));
			expect((await manifest.json()).product.slug).toBe('grades');
			const posted = await handle(new Request('http://127.0.0.1/v1/tier-assignments', { method: 'POST', body: '{}' }));
			expect(posted.status).toBe(401);
		} finally {
			await app.close();
		}
	});
});
