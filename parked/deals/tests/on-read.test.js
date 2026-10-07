/**
 * No timers: price locks and quotes are judged against their expiry when they are used, a TTL index removes old
 * quotes inside MongoDB, and there is no background task.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDEXES } from '../adapters/db.js';
import { lockClaims } from '../core/locks.js';
import { createHarness, T0, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => h?.close());

describe('no periodic work', () => {
	it('declares the quote TTL index and registers no background task', () => {
		expect(INDEXES).toContainEqual(
			expect.objectContaining({ collection: 'quotes', keys: { purgeAt: 1 }, expireAfterSeconds: 0 }),
		);
		expect(h.deals.product.background).not.toHaveProperty('every');
		expect(/** @type {any} */ (h.deals).tasks).toBeUndefined();
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
