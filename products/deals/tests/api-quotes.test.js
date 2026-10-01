/**
 * API on MongoDB: quotes (overnight windows in a non-UTC zone, catalog enrichment, stacking, hints), commits with
 * uses / stock / per-customer limits, releases (API and order.cancelled@1), product events, metered usage, the
 * configured rate limit, bring-your-own identity and price locks (honoured, stale, refused, customer-bound).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
import { createHarness, T0, WEBSITE } from './harness.js';

const ORIGIN = { origin: 'https://shop.example.com' };
const HOUR = 3_600_000;
/** Friday 2 October 2026 19:30 in Berlin (UTC+2). */
const FRIDAY_EVENING = Date.parse('2026-10-02T17:30:00Z');
/** Saturday 01:30 in Berlin: still Friday's 18:00–02:00 window. */
const SATURDAY_NIGHT = Date.parse('2026-10-02T23:30:00Z');
/** Saturday 19:30 in Berlin: weekend, no window. */
const SATURDAY_EVENING = Date.parse('2026-10-03T17:30:00Z');

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
const issuer = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });

const eveningDeal = {
	kind: 'item',
	name: 'Weekday evenings: 15% off shoes',
	scope: { collections: ['shoes'] },
	action: { type: 'percent', percent: 15 },
	schedule: { windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '18:00', end: '02:00' }] },
};
const cart = (/** @type {Record<string, any>} */ extra = {}) => ({
	currency: 'EUR',
	lines: [
		{ lineId: 'a', itemId: 'itm_runner', quantity: 1, unitAmount: 10_000 },
		{ lineId: 'b', itemId: 'itm_socks', quantity: 2, unitAmount: 1000, collections: ['socks'] },
	],
	...extra,
});

beforeAll(async () => {
	h = await createHarness({ config: { quote_api: { time_zone: 'Europe/Berlin', rate_per_minute: 1000 } } });
	await h.entitle({ identity: issuer.section });
	expect(
		(
			await h.call('PUT', '/v1/items/itm_runner', {
				body: { collections: ['shoes'], brand: 'acme', price: 10_000, cost: 4000, currency: 'EUR' },
			})
		).status,
	).toBe(200);
});
afterAll(async () => h?.close());

describe('quotes in the website zone', () => {
	/** @type {string} */
	let dealId;
	it('applies a weekday-evening deal (overnight window, Europe/Berlin) only inside its window', async () => {
		const created = await h.call('POST', '/v1/deals', { body: eveningDeal });
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		dealId = created.json.id;
		expect(created.json).toMatchObject({ kind: 'item', class: 'item', status: 'active', version: 1 });

		h.clock.set(T0); // Friday 14:00 Berlin — outside
		const afternoon = await h.call('POST', '/v1/quotes', { body: cart() });
		expect(afternoon.status, JSON.stringify(afternoon.json)).toBe(201);
		expect(afternoon.json.discountTotal).toBe(0);

		for (const at of [FRIDAY_EVENING, SATURDAY_NIGHT]) {
			h.clock.set(at);
			const inside = await h.call('POST', '/v1/quotes', { body: cart() });
			expect(inside.json.deals.map((/** @type {any} */ d) => d.dealId)).toEqual([dealId]);
			// the runner is a shoe because the synced catalog says so (the cart line sent no collections)
			expect(inside.json.lines[0]).toMatchObject({ lineId: 'a', discount: 1500, total: 8500 });
			expect(inside.json.discountTotal).toBe(1500);
			expect(inside.json.timeZone).toBe('Europe/Berlin');
		}
		h.clock.set(SATURDAY_EVENING);
		const weekend = await h.call('POST', '/v1/quotes', { body: cart() });
		expect(weekend.json.discountTotal).toBe(0);
	});

	it('meters one quote per stored quote and refuses carts that break the configured bounds', async () => {
		await h.deals.product.usage.flush();
		const before = [...h.portal.usage.values()].filter((r) => r.unit === 'quote').length;
		expect(before).toBeGreaterThanOrEqual(4);
		const invalid = await h.call('POST', '/v1/quotes', { body: { currency: 'eur', lines: [] } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/currency', '/lines']);
		expect((await h.call('POST', '/v1/quotes', { body: cart(), idempotencyKey: null })).status).toBe(428);
	});

	it('stacks a cart deal (free shipping over a threshold) with the item deal and hints at the next threshold', async () => {
		h.clock.set(FRIDAY_EVENING);
		const shipping = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'cart',
				name: 'Free shipping over 100.00',
				conditions: { minSubtotal: 10_000 },
				action: { type: 'free_shipping' },
			},
		});
		expect(shipping.status).toBe(201);
		const tiered = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'cart',
				name: 'Spend more, save more',
				class: 'exclusive',
				action: {
					type: 'tiered',
					basis: 'subtotal',
					tiers: [
						{ min: 20_000, percent: 5 },
						{ min: 50_000, percent: 10 },
					],
				},
			},
		});
		expect(tiered.status).toBe(201);
		const quote = await h.call('POST', '/v1/quotes', { body: cart({ shippingAmount: 595, paymentMethod: 'card' }) });
		// 8500 + 2000 = 10500 after item deals ≥ 10000 → free shipping; the tier is not reached yet
		expect(quote.json.shipping).toEqual({ amount: 595, discount: 595, free: true });
		expect(quote.json.total).toBe(10_500);
		expect(quote.json.hints[0]).toMatchObject({ dealId: tiered.json.id, basis: 'subtotal', remaining: 9500 });
		expect(quote.json.couponsAllowed).toBe(true);
		expect(quote.json.loyaltyAllowed).toBe(true);
		// an exclusive tier beats the item deal when it saves more (best for the customer)
		const big = await h.call('POST', '/v1/quotes', {
			body: { currency: 'EUR', lines: [{ itemId: 'itm_runner', quantity: 6, unitAmount: 10_000 }] },
		});
		// item deal: 9000 off; exclusive tier on 60000: 10% = 6000 — the item deal (+ free shipping) wins
		expect(big.json.deals.map((/** @type {any} */ d) => d.dealId).sort()).toEqual([dealId, shipping.json.id].sort());
		expect(big.json.discountTotal).toBe(9000);
		await h.call('POST', `/v1/deals/${tiered.json.id}/pause`);
		await h.call('POST', `/v1/deals/${shipping.json.id}/pause`);
	});
});

describe('commit, limits and release', () => {
	it('commits a quote: counts uses and stock, publishes deals.applied@1, replays for the same order', async () => {
		h.clock.set(FRIDAY_EVENING);
		const flash = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'flash',
				name: 'Flash: socks',
				scope: { collections: ['socks'] },
				action: { type: 'amount_off', amount: 200 },
				schedule: { endsAt: new Date(FRIDAY_EVENING + 2 * HOUR).toISOString() },
				limits: { stockUnits: 3, perCustomer: 1 },
			},
		});
		expect(flash.status, JSON.stringify(flash.json)).toBe(201);
		const quote = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_1' } }) });
		expect(quote.json.lines[1]).toMatchObject({ lineId: 'b', discount: 400 });
		const committed = await h.call('POST', `/v1/quotes/${quote.json.id}/commit`, {
			body: { orderId: 'ord_1', expectedTotal: quote.json.total },
		});
		expect(committed.status, JSON.stringify(committed.json)).toBe(201);
		expect(committed.json).toMatchObject({ status: 'committed', orderId: 'ord_1', customerId: 'cus_1', discountTotal: 1900 });
		const replay = await h.call('POST', `/v1/quotes/${quote.json.id}/commit`, { body: { orderId: 'ord_1' } });
		expect(replay.status).toBe(200);
		expect((await h.call('POST', `/v1/quotes/${quote.json.id}/commit`, { body: { orderId: 'ord_2' } })).json.type).toMatch(
			/quote_committed$/,
		);
		const deal = await h.call('GET', `/v1/deals/${flash.json.id}`);
		expect(deal.json.usage).toEqual({ uses: 1, units: 2 });
		const applied = h.published('deals.applied@1');
		expect(applied.at(-1)?.data).toMatchObject({ quoteId: quote.json.id, orderId: 'ord_1', discountTotal: 1900 });

		// the same customer cannot use the flash sale again (per-customer limit 1), others still can (1 unit left)
		const again = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_1' } }) });
		expect(again.json.lines[1].discount).toBe(0);
		const other = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_2' } }) });
		// only one unit left in stock: one sock discounted
		expect(other.json.lines[1].discount).toBe(200);
		const done = await h.call('POST', `/v1/quotes/${other.json.id}/commit`, { body: { orderId: 'ord_2' } });
		expect(done.status).toBe(201);
		const exhausted = h.published('deals.exhausted@1');
		expect(exhausted.at(-1)?.data).toMatchObject({ dealId: flash.json.id, reason: 'stock_units', units: 3 });

		// a quote made before the stock ran out cannot commit
		const third = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_3' } }) });
		expect(third.json.lines[1].discount).toBe(0);

		// release gives the uses and units back once; order.cancelled@1 does the same for the other order
		const released = await h.call('POST', `/v1/quotes/${quote.json.id}/release`);
		expect(released.json.status).toBe('released');
		expect((await h.call('POST', `/v1/quotes/${quote.json.id}/release`)).status).toBe(409);
		expect((await h.call('GET', `/v1/deals/${flash.json.id}`)).json.usage).toEqual({ uses: 1, units: 1 });
		expect((await h.deliver('order.cancelled@1', { orderId: 'ord_2' })).status).toBe(200);
		expect((await h.call('GET', `/v1/deals/${flash.json.id}`)).json.usage).toEqual({ uses: 0, units: 0 });
		await h.call('DELETE', `/v1/deals/${flash.json.id}`);
	});

	it('refuses a stale commit when a deal ran out in between, an expired quote and a different total', async () => {
		h.clock.set(FRIDAY_EVENING);
		const limited = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'item',
				name: 'One use only',
				scope: { items: ['itm_socks'] },
				action: { type: 'percent', percent: 10 },
				limits: { totalUses: 1 },
			},
		});
		const first = await h.call('POST', '/v1/quotes', { body: cart() });
		const second = await h.call('POST', '/v1/quotes', { body: cart() });
		expect(
			(await h.call('POST', `/v1/quotes/${second.json.id}/commit`, { body: { orderId: 'ord_x', expectedTotal: 1 } })).json
				.type,
		).toMatch(/total_mismatch$/);
		expect((await h.call('POST', `/v1/quotes/${first.json.id}/commit`, { body: { orderId: 'ord_a' } })).status).toBe(201);
		const stale = await h.call('POST', `/v1/quotes/${second.json.id}/commit`, { body: { orderId: 'ord_b' } });
		expect(stale.status).toBe(409);
		expect(stale.json.type).toMatch(/deal_exhausted$/);
		// nothing was counted twice and the quote can still be retried
		expect((await h.call('GET', `/v1/deals/${limited.json.id}`)).json.usage.uses).toBe(1);
		const old = await h.call('POST', '/v1/quotes', { body: cart() });
		h.clock.advance(2 * HOUR);
		expect((await h.call('POST', `/v1/quotes/${old.json.id}/commit`, { body: { orderId: 'ord_old' } })).json.type).toMatch(
			/quote_expired$/,
		);
		expect((await h.call('POST', '/v1/quotes/qte_unknown/commit', { body: { orderId: 'ord_c' } })).status).toBe(404);
		expect((await h.call('GET', `/v1/quotes/${old.json.id}`)).json).toMatchObject({ id: old.json.id, status: 'open' });
		await h.call('DELETE', `/v1/deals/${limited.json.id}`);
	});
});

describe('browser quotes, identity and price locks', () => {
	const NOW_S = () => Math.floor(h.clock.now() / 1000);
	it('quotes from the browser (pk_) with the shopper from SS-Identity, ignoring browser customer fields', async () => {
		h.clock.set(FRIDAY_EVENING);
		const login = issuer.sign({
			iss: issuer.section.issuer,
			aud: 'shop-web',
			sub: 'cus_web',
			iat: NOW_S(),
			exp: NOW_S() + 900,
		});
		const quote = await h.call('POST', '/v1/quotes', {
			key: h.pk,
			headers: { ...ORIGIN, 'ss-identity': login },
			body: cart({ customer: { id: 'cus_spoofed', segments: ['vip'] } }),
		});
		expect(quote.status, JSON.stringify(quote.json)).toBe(201);
		expect(quote.json.customerId).toBe('cus_web');
		const anonymous = await h.call('POST', '/v1/quotes', { key: h.pk, headers: ORIGIN, body: cart() });
		expect(anonymous.json.customerId).toBeNull();
		// pk_ keys cannot commit
		expect(
			(await h.call('POST', `/v1/quotes/${quote.json.id}/commit`, { key: h.pk, headers: ORIGIN, body: { orderId: 'o' } }))
				.status,
		).toBe(403);
	});

	it('honours a locked price after the deal window closed, and reprices once the lock expired', async () => {
		h.clock.set(Date.parse('2026-10-02T23:50:00Z')); // Saturday 01:50 Berlin: 10 minutes left in Friday's window
		const quote = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_lock' } }) });
		expect(quote.json.lines[0].discount).toBe(1500);
		const lock = quote.json.locks.find((/** @type {any} */ l) => l.lineId === 'a');
		expect(lock.token).toMatch(/^pl1\./);
		h.clock.advance(12 * 60_000); // 02:02 — window closed, lock (15 min) still valid
		const closed = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_lock' } }) });
		expect(closed.json.lines[0].discount).toBe(0);
		const honoured = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_lock' }, locks: [lock.token] }) });
		expect(honoured.json.lines[0]).toMatchObject({ discount: 1500, locked: true });
		expect(honoured.json.locks.find((/** @type {any} */ l) => l.lineId === 'a').token).toBe(lock.token);
		// bound to the customer it was issued for
		const other = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_other' }, locks: [lock.token] }) });
		expect(other.json.lines[0].discount).toBe(0);
		expect(other.json.stale).toEqual([{ lineId: 'a', reason: 'mismatch_customer' }]);
		h.clock.advance(10 * 60_000); // lock expired
		const expired = await h.call('POST', '/v1/quotes', { body: cart({ customer: { id: 'cus_lock' }, locks: [lock.token] }) });
		expect(expired.json.lines[0].discount).toBe(0);
		expect(expired.json.stale).toEqual([{ lineId: 'a', reason: 'expired' }]);
		// tampered tokens are ignored
		const forged = await h.call('POST', '/v1/quotes', { body: cart({ locks: [`${lock.token.slice(0, -2)}xx`] }) });
		expect(forged.json.stale).toEqual([]);
	});

	it('refuses expired locks when configured (price_locks.on_expired = reject)', async () => {
		h.clock.set(FRIDAY_EVENING);
		const quote = await h.call('POST', '/v1/quotes', { body: cart() });
		const token = quote.json.locks[0].token;
		await h.entitle({ identity: issuer.section, config: { price_locks: { on_expired: 'reject', ttl_minutes: 5 } } });
		h.clock.advance(20 * 60_000);
		const refused = await h.call('POST', '/v1/quotes', { body: cart({ locks: [token] }) });
		expect(refused.status).toBe(409);
		expect(refused.json.type).toMatch(/price_lock_expired$/);
		await h.entitle({ identity: issuer.section });
	});

	it('rate limits quotes per website with the configured limit (429 + Retry-After)', async () => {
		h.clock.set(FRIDAY_EVENING + 5 * 60_000);
		await h.entitle({ identity: issuer.section, config: { quote_api: { time_zone: 'Europe/Berlin', rate_per_minute: 10 } } });
		/** @type {number[]} */
		const statuses = [];
		/** @type {Headers | null} */
		let last = null;
		for (let i = 0; i < 12; i += 1) {
			const result = await h.call('POST', '/v1/quotes', { body: cart() });
			statuses.push(result.status);
			last = result.headers;
		}
		expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
		expect(last?.get('retry-after')).toBeTruthy();
		h.clock.advance(2 * 60_000);
		await h.entitle({ identity: issuer.section });
		const fresh = await h.call('POST', '/v1/quotes', { body: cart() });
		expect(fresh.status).toBe(201);
		expect(fresh.headers.get('ratelimit-limit')).toBe('1000');
		expect(WEBSITE).toMatch(/^web_/);
	});
});
