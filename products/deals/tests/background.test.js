/**
 * Free-tier hosting model (one daily cron): the heartbeat also runs, throttled, after requests
 * (`product.background.every`), and price locks are judged against their expiry when they are read — no job involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEARTBEAT_EVERY_MS } from '../api/routes.js';
import { lockClaims } from '../core/locks.js';
import { createHarness, T0, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => h?.close());

const heartbeats = () =>
	h.portal.calls.filter((/** @type {any} */ call) => call.method === 'POST' && call.path === '/v1/product/heartbeat').length;

describe('background maintenance', () => {
	it('is registered for the deployment and sends the heartbeat when triggered (at most once per interval)', async () => {
		expect(h.deals.tasks.maintenance.name).toBe('maintenance');
		const before = heartbeats();
		expect(await h.deals.tasks.maintenance.trigger()).toBe(true);
		expect(heartbeats()).toBe(before + 1);
		expect(await h.deals.tasks.maintenance.trigger()).toBe(false);
		expect(heartbeats()).toBe(before + 1);
		h.clock.advance(HEARTBEAT_EVERY_MS);
		expect(await h.deals.tasks.maintenance.trigger()).toBe(true);
		expect(heartbeats()).toBe(before + 2);
		h.clock.set(T0);
	});
});

describe('price locks expire on read', () => {
	it('reports a lock as expired once its time is up, without any sweep', async () => {
		const claims = lockClaims({
			websiteId: WEBSITE,
			currency: 'EUR',
			itemId: 'itm_lock',
			variantId: null,
			unitAmount: 5000,
			unitPrice: 4000,
			units: 1,
			dealIds: ['dl_lock'],
			classes: ['item'],
			customerId: null,
			ttlMinutes: 10,
			now: h.clock.now(),
		});
		const token = h.app.locks.sign(claims);
		const verify = () => h.call('POST', '/v1/price-locks:verify', { body: { token }, idempotencyKey: null });
		expect((await verify()).json).toMatchObject({ valid: true, reason: null });
		h.clock.advance(11 * 60_000);
		expect((await verify()).json).toMatchObject({ valid: false, reason: 'expired' });
		h.clock.set(T0);
	});
});
