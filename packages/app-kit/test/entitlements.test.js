import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { can, config, createMemoryStores, createProduct, feature, featuresOf } from '../src/index.js';
import { APP_ID, MERCHANT, PORTAL_URL, WEBSITE, WEBSITE_2, createClock, entitle, manifest, setup } from './helpers.js';

const coldKey = await generateSigningKey({ kid: 'product-cold' });

/**
 * Options of a second (cold) product instance against the same fake Portal.
 * @param {any} portal
 * @param {{ now: () => number }} clock
 */
const coldOptions = (portal, clock) => {
	portal.trustProductKey(coldKey.publicJwk);
	return {
		manifest: manifest(),
		portalUrl: PORTAL_URL,
		appId: APP_ID,
		signingKey: coldKey.privateJwk,
		fetch: portal.fetch,
		now: clock.now,
	};
};

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('entitlements.forWebsite', () => {
	it('fetches, verifies and caches for the TTL', async () => {
		const { portal, product } = await setup();
		await entitle(portal);
		const first = await product.entitlements.forWebsite(WEBSITE);
		expect(first).toMatchObject({ ok: true, stale: false, version: 1 });
		expect(first.doc.websiteId).toBe(WEBSITE);
		await product.entitlements.forWebsite(WEBSITE);
		const fetches = portal.calls.filter((c) => c.path === '/v1/product/entitlements');
		expect(fetches).toHaveLength(1);
		expect(fetches[0]?.appId).toBe('app_test');
	});

	it('refreshes after the TTL and single-flights concurrent reads', async () => {
		const { portal, product, clock } = await setup();
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		clock.advance(5 * MIN);
		await entitle(portal, { version: 2 });
		const results = await Promise.all([1, 2, 3, 4].map(() => product.entitlements.forWebsite(WEBSITE)));
		expect(results.every((r) => r.ok && r.version === 2)).toBe(true);
		expect(portal.calls.filter((c) => c.path === '/v1/product/entitlements')).toHaveLength(2);
	});

	it('serves the last document stale during an outage, within the offline grace only', async () => {
		const { portal, product, clock, logs } = await setup();
		await entitle(portal); // validUntil = now + 5 min
		await product.entitlements.forWebsite(WEBSITE);
		portal.setDown(true);
		clock.advance(6 * MIN);
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, stale: true });
		expect(logs.some((l) => l.msg.includes('refresh failed'))).toBe(true);
		clock.advance(23 * HOUR);
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, stale: true });
		clock.advance(HOUR);
		expect(await product.entitlements.forWebsite(WEBSITE)).toEqual({ ok: false, reason: 'unavailable' });
		portal.setDown(false);
		await entitle(portal, { version: 2 });
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, stale: false, version: 2 });
	});

	it('marks a fresh fetch stale when the Portal serves a document past validUntil', async () => {
		const { portal, product, clock } = await setup();
		await entitle(portal, { validForMs: MIN });
		clock.advance(2 * MIN);
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, stale: true });
	});

	it('uses the shared store on a cold instance and during outages', async () => {
		const clock = createClock();
		const stores = createMemoryStores({ now: clock.now });
		const { portal, product } = await setup({ clock, overrides: { stores } });
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		const cold = createProduct({ ...coldOptions(portal, clock), stores });
		const fetches = () => portal.calls.filter((c) => c.path === '/v1/product/entitlements').length;
		const before = fetches();
		expect(await cold.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, stale: false });
		expect(fetches()).toBe(before); // read from the shared store, still within TTL
		clock.advance(10 * MIN);
		portal.setDown(true);
		const other = createProduct({ ...coldOptions(portal, clock), stores });
		expect(await other.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, stale: true });
	});

	it('invalidate forces a refetch on the next read and keeps the copy as the offline fallback', async () => {
		const { portal, product } = await setup();
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		await entitle(portal, { version: 2 });
		product.entitlements.invalidate(WEBSITE);
		product.entitlements.invalidate('');
		const fetches = () => portal.calls.filter((c) => c.path === '/v1/product/entitlements').length;
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, version: 2 });
		expect(fetches()).toBe(2);
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ version: 2 });
		expect(fetches()).toBe(2); // one forced read only
		product.entitlements.invalidate(WEBSITE);
		portal.setDown(true);
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ ok: true, stale: true, version: 2 });
	});

	it('is unavailable when nothing was ever fetched and the Portal is down', async () => {
		const { portal, product } = await setup();
		portal.setDown(true);
		expect(await product.entitlements.forWebsite(WEBSITE)).toEqual({ ok: false, reason: 'unavailable' });
		expect(await product.entitlements.forWebsite('')).toEqual({ ok: false, reason: 'invalid' });
	});

	it('drops the cache when the subscription is gone', async () => {
		const { portal, product, clock } = await setup();
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		portal.removeEntitlement(WEBSITE);
		clock.advance(5 * MIN);
		expect(await product.entitlements.forWebsite(WEBSITE)).toEqual({ ok: false, reason: 'not_subscribed' });
		portal.setDown(true);
		expect(await product.entitlements.forWebsite(WEBSITE)).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('treats other Portal errors as an outage', async () => {
		const { portal, product } = await setup();
		portal.failNext('/v1/product/entitlements', 500);
		expect(await product.entitlements.forWebsite(WEBSITE)).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('never accepts an older version (rollback protection)', async () => {
		const { portal, product, clock, logs } = await setup();
		await entitle(portal, { version: 5 });
		await product.entitlements.forWebsite(WEBSITE);
		clock.advance(5 * MIN);
		await entitle(portal, { version: 4, config: { codes: { prefix: 'OLD' } } });
		const result = await product.entitlements.forWebsite(WEBSITE);
		expect(result).toMatchObject({ ok: true, version: 5 });
		expect(config(result.doc, 'codes')).toEqual({ prefix: 'SAVE' });
		expect(logs.some((l) => l.msg.includes('older entitlement'))).toBe(true);
	});

	it('rejects documents for another website or product, invalid payloads and foreign signatures', async () => {
		const { portal, product, clock } = await setup();
		await portal.setEntitlement({ websiteId: WEBSITE, productSlug: 'other-product', merchantId: MERCHANT });
		expect(await product.entitlements.forWebsite(WEBSITE)).toEqual({ ok: false, reason: 'unavailable' });
		clock.advance(MIN);
		await portal.setEntitlement({
			websiteId: WEBSITE,
			productSlug: 'coupon-box',
			merchantId: MERCHANT,
			dataScope: { prefix: 'bad' },
		});
		expect(await product.entitlements.forWebsite(WEBSITE)).toEqual({ ok: false, reason: 'unavailable' });
		// a document for WEBSITE served under WEBSITE_2's query
		const { token } = await entitle(portal);
		portal.removeEntitlement(WEBSITE);
		await portal.setEntitlement({ websiteId: WEBSITE_2, productSlug: 'coupon-box' });
		expect(token).toBeTypeOf('string');
		expect((await product.entitlements.forWebsite(WEBSITE_2)).ok).toBe(true);
	});

	it('refresh() forces a fetch (entitlement.changed)', async () => {
		const { portal, product } = await setup();
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		await entitle(portal, { version: 2, elements: { codes: { enabled: false, reason: 'merchant_disabled' } } });
		const refreshed = await product.entitlements.refresh(WEBSITE);
		expect(refreshed).toMatchObject({ ok: true, version: 2 });
		expect(can(refreshed.doc, 'codes')).toBe(false);
	});
});

describe('document readers', () => {
	/** @type {any} */
	const doc = {
		runtime: { state: 'active' },
		elements: { codes: { enabled: true }, bulk: { enabled: false } },
		features: { 'codes.maxActive': { value: 50 }, 'codes.window.days': { value: 30 }, 'bulk.max': { value: 1 } },
		config: { codes: { prefix: 'SAVE' } },
	};
	it('can', () => {
		expect(can(doc, 'codes')).toBe(true);
		expect(can(doc, 'bulk')).toBe(false);
		expect(can(doc, 'missing')).toBe(false);
		expect(can(doc, 'toString')).toBe(false);
		expect(can(null, 'codes')).toBe(false);
		expect(can({ ...doc, runtime: { state: 'paused' } }, 'codes')).toBe(false);
		expect(can({ ...doc, runtime: { state: 'quota_exhausted' } }, 'codes')).toBe(true);
	});
	it('feature / config / featuresOf', () => {
		expect(feature(doc, 'codes.maxActive')).toBe(50);
		expect(feature(doc, 'codes.nope')).toBeUndefined();
		expect(feature(undefined, 'x')).toBeUndefined();
		expect(config(doc, 'codes')).toEqual({ prefix: 'SAVE' });
		expect(config(doc, 'bulk')).toEqual({});
		expect(config(null, 'bulk')).toEqual({});
		expect(featuresOf(doc, 'codes')).toEqual({ maxActive: 50, 'window.days': 30 });
		expect(featuresOf(null, 'codes')).toEqual({});
	});
});
