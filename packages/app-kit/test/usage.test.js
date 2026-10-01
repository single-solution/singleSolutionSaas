import { describe, expect, it } from 'vitest';
import { backoffDelay, createMemoryStores, createUsage } from '../src/index.js';
import { WEBSITE, createTestLogger, entitle, seededRandom, setup } from './helpers.js';

const input = (/** @type {string} */ key, quantity = 1) => ({
	websiteId: WEBSITE,
	subscriptionId: 'sub_1',
	unit: 'redemption',
	quantity,
	idempotencyKey: key,
	occurredAt: '2026-10-01T10:00:00Z',
});

describe('usage', () => {
	it('records durably and counts exactly once across retries and duplicate records', async () => {
		const { portal, product, clock } = await setup();
		expect(await product.usage.record(input('r1', 2))).toEqual({ ok: true, duplicate: false });
		expect(await product.usage.record(input('r1', 2))).toEqual({ ok: true, duplicate: true });
		await product.usage.record(input('r2'));
		portal.setDown(true);
		expect(await product.usage.flush()).toMatchObject({ sent: 0, failed: 2 });
		portal.setDown(false);
		// backoff: not due yet
		expect(await product.usage.flush()).toMatchObject({ batches: 0 });
		clock.advance(2000);
		expect(await product.usage.flush()).toMatchObject({ sent: 2, batches: 1 });
		expect(await product.usage.flush()).toMatchObject({ batches: 0 });
		expect(await product.usage.record(input('r1', 2))).toEqual({ ok: true, duplicate: true });
		expect([...portal.usage.keys()].sort()).toEqual(['r1', 'r2']);
		expect(portal.usage.get('r1')).toMatchObject({ quantity: 2, unit: 'redemption', occurredAt: '2026-10-01T10:00:00.000Z' });
		expect(await product.usage.stats()).toEqual({ pending: 0, sent: 2, dead: 0 });
	});

	it('acknowledges Portal duplicates, dead-letters rejections and retries missing results', async () => {
		const clock = { t: 0, now: () => clock.t };
		const stores = createMemoryStores({ now: clock.now });
		const { logger, entries } = createTestLogger();
		/** @type {any[]} */
		const batches = [];
		const usage = createUsage({
			queue: stores.usageQueue,
			portal: {
				usage: async (records, options) => {
					batches.push({ records, options });
					return {
						results: records.flatMap((r) =>
							r.idempotencyKey === 'dup'
								? [{ idempotencyKey: 'dup', status: 'duplicate' }]
								: r.idempotencyKey === 'bad'
									? [{ idempotencyKey: 'bad', status: 'rejected' }]
									: r.idempotencyKey === 'lost'
										? []
										: [{ idempotencyKey: r.idempotencyKey, status: 'accepted' }],
						),
					};
				},
			},
			now: clock.now,
			randomBytes: seededRandom(),
			logger,
			units: null,
		});
		for (const key of ['ok', 'dup', 'bad', 'lost']) await usage.record(input(key));
		expect(await usage.flush()).toEqual({ sent: 1, duplicates: 1, rejected: 1, failed: 1, batches: 1 });
		expect(batches[0].options.idempotencyKey).toMatch(/^usage-[0-9a-f]{48}$/);
		expect(await usage.stats()).toEqual({ pending: 1, sent: 2, dead: 1 });
		expect(entries.some((e) => e.msg.includes('rejected'))).toBe(true);
		clock.t += 1000;
		expect(await usage.flush()).toMatchObject({ failed: 1 });
	});

	it('sends in batches', async () => {
		const clock = { now: () => 0 };
		const stores = createMemoryStores(clock);
		/** @type {number[]} */
		const sizes = [];
		const usage = createUsage({
			queue: stores.usageQueue,
			portal: {
				usage: async (records) => {
					sizes.push(records.length);
					return { results: records.map((r) => ({ idempotencyKey: r.idempotencyKey, status: 'accepted' })) };
				},
			},
			now: clock.now,
			randomBytes: seededRandom(),
			logger: createTestLogger().logger,
			batchSize: 2,
		});
		for (const key of ['a', 'b', 'c', 'd', 'e']) await usage.record(input(key));
		expect(await usage.flush()).toMatchObject({ sent: 5, batches: 3 });
		expect(sizes).toEqual([2, 2, 1]);
	});

	it('validates records', async () => {
		const { product } = await setup();
		await expect(product.usage.record({ ...input('x'), unit: 'seat' })).rejects.toMatchObject({ code: 'invalid_usage' });
		await expect(product.usage.record({ ...input('x'), unit: 'Bad' })).rejects.toMatchObject({ code: 'invalid_usage' });
		await expect(product.usage.record({ ...input('x'), quantity: 0 })).rejects.toMatchObject({ code: 'invalid_usage' });
		await expect(product.usage.record({ ...input('x'), quantity: 1.5 })).rejects.toMatchObject({ code: 'invalid_usage' });
		await expect(product.usage.record({ ...input('x'), idempotencyKey: '' })).rejects.toMatchObject({ code: 'invalid_usage' });
		await expect(product.usage.record({ ...input('x'), websiteId: '' })).rejects.toMatchObject({ code: 'invalid_usage' });
		await expect(product.usage.record({ ...input('x'), subscriptionId: '' })).rejects.toMatchObject({ code: 'invalid_usage' });
		await expect(product.usage.record({ ...input('x'), occurredAt: 'nope' })).rejects.toMatchObject({ code: 'invalid_usage' });
		const rest = /** @type {any} */ ({ ...input('now') });
		delete rest.occurredAt;
		expect(await product.usage.record(rest)).toEqual({ ok: true, duplicate: false });
	});

	it('fills a missing subscriptionId from the entitlement', async () => {
		const { portal, product } = await setup();
		const { subscriptionId: _omit, ...rest } = input('nosub');
		expect(_omit).toBe('sub_1');
		await expect(product.usage.record(rest)).rejects.toMatchObject({ code: 'invalid_usage' });
		await entitle(portal);
		expect(await product.usage.record(rest)).toEqual({ ok: true, duplicate: false });
		await product.usage.flush();
		expect(portal.usage.get('nosub')).toMatchObject({ subscriptionId: 'sub_0123456789abcdefghjkmnpq' });
	});

	it('computes capped exponential backoff with jitter', () => {
		const random = () => 0;
		expect(backoffDelay(1, { baseMs: 1000, maxMs: 60_000, random })).toBe(1000);
		expect(backoffDelay(3, { baseMs: 1000, maxMs: 60_000, random })).toBe(4000);
		expect(backoffDelay(30, { baseMs: 1000, maxMs: 60_000, random })).toBe(60_000);
		expect(backoffDelay(1, { baseMs: 1000, maxMs: 60_000, random: () => 1 })).toBe(1200);
	});
});
