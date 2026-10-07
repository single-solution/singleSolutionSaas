import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FEATURE_SOURCES, RUNTIME_STATES, validateEntitlementDocument } from '@ss/contracts';
import { SOURCE_NAMES, toDocument } from '../src/document.js';
import { contentHash, resolveEntitlement } from '../src/resolve.js';
import { HEALTHY, NOW, coupons, deepFreeze } from './fixtures.js';

const SUB_ID = 'sub_0123456789abcdefghjk';
const SUB = deepFreeze({
	id: SUB_ID,
	plan: 'pro',
	priceBookVersion: '2026-06-01',
	websiteId: 'web_0123456789ab',
	merchantId: 'mer_0123456789ab',
});
const META = deepFreeze({
	websiteId: 'web_0123456789ab',
	merchantId: 'mer_0123456789ab',
	domain: 'shop.example.com',
	allowSubdomains: false,
	env: /** @type {const} */ ('live'),
	version: 7,
	issuedAt: '2026-10-01T12:00:00Z',
	validFrom: '2026-10-01T12:00:00Z',
	validUntil: '2026-10-01T12:15:00Z',
	resources: [{ kind: 'database', ref: 'db_main', status: 'connected' }],
	dataScope: { prefix: 'ss_coupons_' },
});

/**
 * @param {Partial<Parameters<typeof resolveEntitlement>[0]>} [overrides]
 */
const resolve = (overrides = {}) =>
	resolveEntitlement({ product: coupons, subscription: SUB, now: NOW, runtime: { resources: HEALTHY }, ...overrides });

/**
 * @param {ReturnType<typeof toDocument>} result
 * @returns {import('@ss/contracts').EntitlementDocument}
 */
const documentOf = (result) => {
	if (!result.ok) throw new Error(`expected a document, got ${JSON.stringify(result)}`);
	return result.document;
};

describe('toDocument', () => {
	it('produces a schema-valid document with Portal metadata', () => {
		const doc = documentOf(toDocument(resolve(), META));
		expect(validateEntitlementDocument(doc).ok).toBe(true);
		expect(doc).toMatchObject({
			subscriptionId: SUB_ID,
			websiteId: 'web_0123456789ab',
			productSlug: 'coupons',
			planCode: 'pro',
			priceBookVersion: '2026-06-01',
			version: 7,
			runtime: { state: 'active' },
			resources: [{ kind: 'database', ref: 'db_main', status: 'connected' }],
			dataScope: { prefix: 'ss_coupons_' },
		});
		expect(doc.elements.codes).toEqual({ enabled: true });
		expect(doc.features['codes.maxActive']).toEqual({ value: 50, source: 'plan_default', locked: false });
		expect(doc.config.codes?.maxActive).toBe(50);
		expect(Object.keys(doc.features['codes.maxActive'] ?? {})).not.toContain('lockedBy');
	});

	it('carries the website identity issuer when given (and omits it otherwise)', () => {
		const identity = {
			issuer: 'https://login.shop.example.com/',
			jwks: [
				{
					kty: /** @type {const} */ ('OKP'),
					crv: /** @type {const} */ ('Ed25519'),
					x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
					kid: 'k1',
				},
			],
			claimMap: { subject: 'sub' },
		};
		const doc = documentOf(toDocument(resolve(), { ...META, identity }));
		expect(doc.identity).toEqual(identity);
		expect(documentOf(toDocument(resolve(), { ...META, identity: null }))).not.toHaveProperty('identity');
		const bad = toDocument(resolve(), { ...META, identity: { ...identity, jwks: [] } });
		expect(bad.ok).toBe(false);
	});

	it('carries the website defaults when given (and omits them when absent or empty)', () => {
		const website = { timeZone: 'Europe/Berlin', language: 'de-DE', currency: 'EUR' };
		expect(documentOf(toDocument(resolve(), { ...META, website })).website).toEqual(website);
		expect(documentOf(toDocument(resolve(), { ...META, website: {} }))).not.toHaveProperty('website');
		expect(documentOf(toDocument(resolve(), { ...META, website: null }))).not.toHaveProperty('website');
		expect(toDocument(resolve(), { ...META, website: { timeZone: 'Mars/Olympus' } }).ok).toBe(false);
	});

	it.each(/** @type {const} */ (['active', 'paused', 'suspended', 'spend_cap']))('round-trips runtime state %s', (state) => {
		const resolved = resolve({
			subscription: { ...SUB, status: state === 'spend_cap' ? 'active' : state },
			runtime: { resources: HEALTHY, spendCap: state === 'spend_cap' },
		});
		const doc = documentOf(toDocument(resolved, META));
		expect(RUNTIME_STATES).toContain(doc.runtime.state);
		expect(doc.runtime).toEqual(state === 'active' ? { state } : { state, reason: state });
		expect(doc.elements.codes).toEqual(state === 'active' ? { enabled: true } : { enabled: false, reason: state });
	});

	it('never produces a document for cancelled subscriptions', () => {
		expect(toDocument(resolve({ subscription: { ...SUB, status: 'cancelled' } }), META)).toEqual({
			ok: false,
			reason: 'cancelled',
		});
	});

	it('maps every source to contracts FEATURE_SOURCES', () => {
		expect(Object.values(SOURCE_NAMES).sort()).toEqual([...FEATURE_SOURCES].sort());
		const resolved = resolve({
			layers: {
				platform: { features: { 'codes.apiRate': { value: 90 } } },
				website: { features: { 'codes.layout': { value: 'modal' } } },
				admin: { features: { 'codes.bulk': { value: true, locked: true } } },
			},
			runtime: { resources: HEALTHY },
		});
		const doc = documentOf(toDocument(resolved, META));
		expect(
			Object.fromEntries(
				['codes.pattern', 'codes.maxActive', 'codes.apiRate', 'codes.layout', 'codes.bulk'].map((k) => [
					k,
					doc.features[k]?.source,
				]),
			),
		).toEqual({
			'codes.pattern': 'product_default',
			'codes.maxActive': 'plan_default',
			'codes.apiRate': 'platform_policy',
			'codes.layout': 'website_override',
			'codes.bulk': 'admin_override',
		});
		expect(doc.features['codes.bulk']).toEqual({ value: true, source: 'admin_override', locked: true });
	});

	it('encodes element reasons compactly and keeps quota exhaustion on the feature', () => {
		const resolved = resolve({
			subscription: { ...SUB, plan: 'starter' },
			layers: { website: { elements: { apply_box: false, bulk: true } } },
			runtime: { resources: { ai: 'failing' }, usage: { 'codes.redemptions': 100 } },
		});
		const doc = documentOf(toDocument(resolved, META));
		expect(doc.elements).toEqual({
			ai_copy: { enabled: false, reason: 'not_in_plan' },
			apply_box: { enabled: false, reason: 'website_override' },
			codes: { enabled: true },
			reports: { enabled: false, reason: 'plan_default' },
		});
		expect(doc.features['codes.redemptions']).toEqual({
			value: 100,
			source: 'product_default',
			locked: false,
			reason: 'quota_exhausted',
		});
		const missing = documentOf(toDocument(resolve({ runtime: { resources: { ai: 'revoked' } } }), META));
		expect(missing.elements.ai_copy).toEqual({ enabled: false, reason: 'resource_missing:ai' });
		expect(missing.elements.reports).toEqual({ enabled: false, reason: 'resource_missing:database' });
		const dep = documentOf(toDocument(resolve({ layers: { admin: { elements: { codes: false } } } }), META));
		expect(dep.elements.apply_box).toEqual({ enabled: false, reason: 'dependency:codes' });
		expect(dep.elements.codes).toEqual({ enabled: false, reason: 'admin_override' });
		const clamped = documentOf(
			toDocument(resolve({ layers: { website: { features: { 'codes.maxActive': { value: 99999 } } } } }), META),
		);
		expect(clamped.features['codes.maxActive']).toEqual({
			value: 1000,
			source: 'website_override',
			locked: false,
			reason: 'clamped',
		});
		const unlimited = documentOf(
			toDocument(resolve({ layers: { admin: { features: { 'codes.redemptions': { value: null } } } } }), META),
		);
		expect(unlimited.features['codes.redemptions']?.value).toBeNull();
	});

	it('omits planCode without a plan and honours an explicit priceBookVersion', () => {
		const doc = documentOf(
			toDocument(resolve({ subscription: { id: SUB_ID, plan: null } }), { ...META, priceBookVersion: '2026-01-01' }),
		);
		expect('planCode' in doc).toBe(false);
		expect(doc.priceBookVersion).toBe('2026-01-01');
	});

	it('returns problems for mismatched identity, invalid metadata and bad validity windows', () => {
		expect(
			toDocument(resolve(), { ...META, subscriptionId: 'sub_zzzzzzzzzzzz', productSlug: 'other', planCode: 'starter' }),
		).toEqual({
			ok: false,
			problems: [
				{ path: '/subscriptionId', keyword: 'mismatch', message: 'subscriptionId does not match the resolved entitlement' },
				{ path: '/productSlug', keyword: 'mismatch', message: 'productSlug does not match the resolved entitlement' },
				{ path: '/planCode', keyword: 'mismatch', message: 'planCode does not match the resolved entitlement' },
			],
		});
		expect(toDocument(resolve(), { ...META, subscriptionId: SUB_ID, productSlug: 'coupons', planCode: 'pro' }).ok).toBe(true);
		const bad = toDocument(resolve(), { ...META, domain: 'Not A Domain', version: 0 });
		expect(bad.ok).toBe(false);
		expect('problems' in bad && bad.problems.map((p) => p.path)).toEqual(expect.arrayContaining(['/domain', '/version']));
		const window = toDocument(resolve(), { ...META, validUntil: '2026-10-01T11:00:00Z' });
		expect('problems' in window && window.problems.map((p) => p.keyword)).toContain('validityWindow');
		const badId = toDocument(resolve({ subscription: { ...SUB, id: 'sub_1' } }), META);
		expect('problems' in badId && badId.problems.map((p) => p.path)).toContain('/subscriptionId');
	});

	it('any resolver output maps to a schema-valid document (property)', () => {
		const layerNames = /** @type {const} */ (['platform', 'website', 'admin']);
		const elementKeys = Object.keys(coupons.elements);
		const featureValues = {
			'codes.maxActive': fc.oneof(fc.nat(20000), fc.constant(null)),
			'codes.redemptions': fc.oneof(fc.nat(500), fc.constant(null)),
			'codes.bulk': fc.boolean(),
			'codes.apiRate': fc.nat(500),
			'codes.layout': fc.constantFrom('inline', 'collapsible', 'modal', 'bogus'),
			'codes.headline': fc.string({ maxLength: 50 }),
			'codes.tags': fc.array(fc.string({ maxLength: 5 }), { maxLength: 4 }),
			'apply_box.delayMs': fc.nat(5000),
		};
		const layer = fc.record(
			{
				elements: fc.dictionary(fc.constantFrom(...elementKeys), fc.record({ enabled: fc.boolean(), locked: fc.boolean() })),
				features: fc.record(
					Object.fromEntries(
						Object.entries(featureValues).map(([k, arb]) => [k, fc.record({ value: arb, locked: fc.boolean() })]),
					),
					{ requiredKeys: [] },
				),
			},
			{ requiredKeys: [] },
		);
		const status = fc.constantFrom('connected', 'missing', 'failing', 'revoked');
		fc.assert(
			fc.property(
				fc.record(Object.fromEntries(layerNames.map((n) => [n, layer])), { requiredKeys: [] }),
				fc.constantFrom('starter', 'pro', null),
				fc.constantFrom('active', 'trialing', 'paused', 'suspended'),
				fc.boolean(),
				fc.record({ database: status, ai: status }),
				fc.nat(200),
				fc
					.string({ minLength: 10, maxLength: 20 })
					.map((s) => `sub_${[...s].map((c) => '0123456789abcdefghjkmnpqrstvwxyz'[c.charCodeAt(0) % 32]).join('')}`),
				(layers, plan, status, spendCap, resources, used, subscriptionId) => {
					const resolved = resolveEntitlement({
						product: coupons,
						subscription: { id: subscriptionId, plan, status },
						layers: /** @type {never} */ (layers),
						runtime: {
							spendCap,
							resources,
							usage: { 'codes.redemptions': used },
						},
						now: NOW,
					});
					const result = toDocument(resolved, META);
					if (!result.ok) throw new Error(JSON.stringify(result));
					expect(validateEntitlementDocument(result.document).ok).toBe(true);
				},
			),
			{ numRuns: 150 },
		);
	});
});

describe('contentHash', () => {
	it('matches the resolver hash and ignores diagnostics', () => {
		const a = resolve();
		expect(contentHash(a)).toBe(a.contentHash);
		const withDiagnostics = { ...a, report: [], resolvedAt: 'x' };
		expect(contentHash(withDiagnostics)).toBe(a.contentHash);
		expect(contentHash(resolve({ layers: { admin: { features: { 'codes.bulk': { value: true } } } } }))).not.toBe(
			a.contentHash,
		);
		expect(contentHash(a, (t) => String(t.length))).toMatch(/^\d+$/);
	});
});
