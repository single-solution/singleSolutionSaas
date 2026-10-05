import { describe, expect, it } from 'vitest';
import { checkEvent } from '../src/index.js';
import { WEBSITE, entitle, setup, websiteKey } from './helpers.js';

/**
 * Copy of `value` without `key`.
 * @param {Record<string, any>} value
 * @param {string} key
 * @returns {Record<string, any>}
 */
const omitKey = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const envelope = (/** @type {Record<string, any>} */ overrides = {}) => ({
	id: 'evt_0123456789abcdefghjkmnpq',
	type: 'order.placed@1',
	websiteId: WEBSITE,
	env: 'live',
	occurredAt: '2026-10-01T10:00:00Z',
	idempotencyKey: 'order-1',
	actor: { type: 'system' },
	data: {
		orderId: 'ord_1',
		currency: 'EUR',
		amounts: { subtotal: 100, total: 100 },
		lines: [{ itemId: 'itm_1', quantity: 1, unitAmount: 100 }],
	},
	...overrides,
});

describe('events.handle', () => {
	it('verifies, dispatches and deduplicates Portal deliveries', async () => {
		const { portal, product } = await setup();
		/** @type {any[]} */
		const seen = [];
		const off = product.events.on('order.placed', (/** @type {any} */ event, /** @type {any} */ meta) => {
			seen.push([event.id, meta.source]);
		});
		product.events.on('*', () => {
			seen.push(['*']);
		});
		const delivery = await portal.signEvent(envelope());
		expect(await product.events.handle({ headers: delivery.headers, rawBody: delivery.body })).toEqual({
			status: 200,
			body: { received: true },
		});
		// exact replay of the same signed delivery
		expect(await product.events.handle({ headers: delivery.headers, rawBody: delivery.body })).toEqual({
			status: 401,
			body: { error: 'unauthorized' },
		});
		// a re-signed retry with the same event id
		const retry = await portal.signEvent({ ...envelope(), context: { source: 'portal' } });
		expect(await product.events.handle({ headers: retry.headers, rawBody: new TextEncoder().encode(retry.body) })).toEqual({
			status: 200,
			body: { received: true, duplicate: true },
		});
		expect(seen).toEqual([['evt_0123456789abcdefghjkmnpq', 'portal'], ['*']]);
		off();
	});

	it('accepts platform-scoped control events (no websiteId) and refuses scope mismatches', async () => {
		const { portal, product } = await setup();
		/** @type {any[]} */
		const seen = [];
		product.events.on('manifest.accepted', (/** @type {any} */ event) => {
			seen.push([event.scope, event.websiteId, event.data.version]);
		});
		const platformEnvelope = omitKey(
			envelope({
				id: 'evt_1123456789abcdefghjkmnpq',
				type: 'manifest.accepted@1',
				scope: 'platform',
				data: { appId: 'app_test', version: '1.5.0' },
			}),
			'websiteId',
		);
		const delivery = await portal.signEvent(platformEnvelope);
		expect(await product.events.handle({ headers: delivery.headers, rawBody: delivery.body })).toEqual({
			status: 200,
			body: { received: true },
		});
		const retry = await portal.signEvent({ ...platformEnvelope, context: { source: 'portal' } });
		expect(await product.events.handle({ headers: retry.headers, rawBody: retry.body })).toEqual({
			status: 200,
			body: { received: true, duplicate: true },
		});
		expect(seen).toEqual([['platform', undefined, '1.5.0']]);
		// the former sentinel-website form of manifest.accepted@1 is refused
		const legacy = await portal.signEvent(
			envelope({
				id: 'evt_2123456789abcdefghjkmnpq',
				type: 'manifest.accepted@1',
				data: { appId: 'app_test', version: '1.5.0' },
			}),
		);
		expect((await product.events.handle({ headers: legacy.headers, rawBody: legacy.body })).status).toBe(400);
	});

	it('rejects unsigned, tampered, malformed and invalid events', async () => {
		const { portal, product } = await setup();
		const delivery = await portal.signEvent(envelope());
		expect((await product.events.handle({ headers: {}, rawBody: delivery.body })).status).toBe(401);
		expect(
			(await product.events.handle({ headers: delivery.headers, rawBody: delivery.body.replace('order-1', 'order-2') }))
				.status,
		).toBe(401);
		const garbage = await portal.signEvent('not json');
		expect(await product.events.handle({ headers: garbage.headers, rawBody: garbage.body })).toEqual({
			status: 400,
			body: { error: 'invalid_event' },
		});
		const invalid = await portal.signEvent(envelope({ data: { nope: true } }));
		expect((await product.events.handle({ headers: invalid.headers, rawBody: invalid.body })).status).toBe(400);
	});

	it('answers 500 and allows the retry when a handler fails', async () => {
		const { portal, product } = await setup();
		let fail = true;
		product.events.on('order.placed@1', () => {
			if (fail) throw new Error('db down');
		});
		const first = await portal.signEvent(envelope());
		expect(await product.events.handle({ headers: first.headers, rawBody: first.body })).toEqual({
			status: 500,
			body: { error: 'handler_failed' },
		});
		fail = false;
		const retry = await portal.signEvent({ ...envelope(), context: { source: 'portal' } });
		expect(await product.events.handle({ headers: retry.headers, rawBody: retry.body })).toEqual({
			status: 200,
			body: { received: true },
		});
	});

	it('refreshes entitlements on entitlement.changed and revokes keys on key.revoked', async () => {
		const { portal, product } = await setup();
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		await entitle(portal, { version: 2 });
		const changed = await portal.signEvent(envelope({ id: 'evt_1', type: 'entitlement.changed@1', data: { version: 2 } }));
		expect((await product.events.handle({ headers: changed.headers, rawBody: changed.body })).status).toBe(200);
		expect(await product.entitlements.forWebsite(WEBSITE)).toMatchObject({ version: 2 });

		const key = await websiteKey(portal, { kind: 'sk', keyId: 'key_7' });
		expect((await product.keys.verify(`Bearer ${key}`)).ok).toBe(true);
		const revoked = await portal.signEvent(envelope({ id: 'evt_2', type: 'key.revoked@1', data: { keyId: 'key_7' } }));
		expect((await product.events.handle({ headers: revoked.headers, rawBody: revoked.body })).status).toBe(200);
		expect(await product.keys.verify(`Bearer ${key}`)).toMatchObject({ ok: false, code: 'invalid_credentials' });
		const many = await portal.signEvent(envelope({ id: 'evt_3', type: 'key.revoked@1', data: { keyIds: ['key_8', 'key_9'] } }));
		expect((await product.events.handle({ headers: many.headers, rawBody: many.body })).status).toBe(200);
		expect(product.keys.isRevoked('key_9')).toBe(true);
		const resource = await portal.signEvent(envelope({ id: 'evt_4', type: 'resource.changed@1', data: { kind: 'database' } }));
		expect((await product.events.handle({ headers: resource.headers, rawBody: resource.body })).status).toBe(200);
	});

	it('validates control events and product events without schemas', () => {
		expect(checkEvent(envelope({ type: 'key.revoked@1', data: {} })).ok).toBe(false);
		expect(checkEvent(envelope({ type: 'key.revoked@1', data: { keyIds: [''] } })).ok).toBe(false);
		expect(checkEvent(envelope({ type: 'entitlement.changed@1', data: { version: 1.5 } })).ok).toBe(false);
		expect(checkEvent(envelope({ type: 'entitlement.changed@1', data: {} })).ok).toBe(true);
		expect(checkEvent(envelope({ type: 'coupon_box.applied@1', data: { any: 1 } })).ok).toBe(true);
		expect(checkEvent(envelope({ type: 'custom.thing@1', data: { any: 1 } })).ok).toBe(true);
		expect(checkEvent({ nope: 1 }).ok).toBe(false);
		const { product } = { product: null };
		expect(product).toBeNull();
	});

	it('requires a type and a function for on()', async () => {
		const { product } = await setup();
		expect(() => product.events.on(/** @type {any} */ (1), () => {})).toThrow(TypeError);
	});
});
