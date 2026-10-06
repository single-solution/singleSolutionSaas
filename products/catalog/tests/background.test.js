/** Free-tier scheduling: the background sweep after requests, and reservation expiry honoured at read time. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SWEEP_BACKGROUND_LIMIT, SWEEP_INTERVAL_MS } from '../jobs/sweep.js';
import { HOUR, WEBSITE, WEBSITE_2, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {string} */
let variantId;
/** @type {string} */
let itemId;

beforeAll(async () => {
	h = await createHarness();
	const created = await h.call('POST', '/v1/items', {
		body: { title: 'Mug', status: 'active', variants: [{ sku: 'MUG-1', price: 900, quantity: 5 }] },
	});
	expect(created.status, JSON.stringify(created.json)).toBe(201);
	variantId = created.json.variants[0].id;
	itemId = created.json.id;
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** Current stock of the mug. */
const quantity = async () => (await h.call('GET', `/v1/items/${itemId}`)).json.variants[0].quantity;
/** @param {number} n */
const reserve = (n) => h.call('POST', '/v1/stock-reservations', { body: { lines: [{ variantId, quantity: n }] } });
/** @param {string} id */
const stored = (id) => h.collection('stock_moves').findOne({ websiteId: WEBSITE, id });

describe('reservation expiry at read time', () => {
	it('reads an expired reservation as expired and gives its stock back on access, before any sweep', async () => {
		const held = await reserve(2);
		expect(held.status, JSON.stringify(held.json)).toBe(201);
		expect(await quantity()).toBe(3);
		h.clock.advance(HOUR);
		expect((await stored(held.json.id))?.status).toBe('held');
		const read = await h.call('GET', `/v1/stock-reservations/${held.json.id}`);
		expect(read.json.status).toBe('expired');
		expect((await stored(held.json.id))?.status).toBe('expired');
		expect(await quantity()).toBe(5);
		// reading it again changes nothing
		expect((await h.call('GET', `/v1/stock-reservations/${held.json.id}`)).json.status).toBe('expired');
		expect(await quantity()).toBe(5);
	});

	it('releases expired reservations before a new one takes stock, and on an idempotent replay', async () => {
		const first = await reserve(5);
		expect(first.status).toBe(201);
		expect(await quantity()).toBe(0);
		h.clock.advance(HOUR);
		// the expired hold no longer blocks a new reservation
		const second = await h.call('POST', '/v1/stock-reservations', {
			idempotencyKey: 'bg-second',
			body: { lines: [{ variantId, quantity: 4 }] },
		});
		expect(second.status, JSON.stringify(second.json)).toBe(201);
		expect((await stored(first.json.id))?.status).toBe('expired');
		expect(await quantity()).toBe(1);
		h.clock.advance(HOUR);
		// the same Idempotency-Key after the kit's replay record is gone reaches the service: it reports the expiry
		const site = /** @type {any} */ (await h.catalog.siteFor(WEBSITE));
		const replay = await h.catalog.variants.reserve(site, { lines: [{ variantId, quantity: 4 }] }, { key: 'bg-second' });
		expect(replay).toMatchObject({ ok: true, created: false, reservation: { id: second.json.id, status: 'expired' } });
		expect(await quantity()).toBe(5);
	});
});

describe('background sweep', () => {
	it('is registered per website and sweeps that website when triggered (throttled per interval)', async () => {
		expect(h.catalog.tasks.sweep.name).toBe('sweep');
		expect(SWEEP_INTERVAL_MS).toBe(5 * 60_000);
		expect(SWEEP_BACKGROUND_LIMIT).toBeGreaterThan(0);
		const held = await reserve(1);
		h.clock.advance(HOUR);
		expect(await h.catalog.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		expect((await stored(held.json.id))?.status).toBe('expired');
		expect(await quantity()).toBe(5);
		expect(await h.catalog.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(false);
		expect(await h.catalog.tasks.sweep.trigger()).toBe(false);
		h.clock.advance(SWEEP_INTERVAL_MS);
		expect(await h.catalog.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		// a website this deployment has no entitlement for is skipped quietly
		expect(await h.catalog.tasks.sweep.trigger({ websiteId: WEBSITE_2 })).toBe(true);
	});
});
