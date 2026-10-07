/**
 * API on MongoDB: deal management (validation from configured bounds, kinds switched by their element, limits,
 * merge patch, lifecycle), the catalog mirror (API and events), offers and price locks for product pages, the deals
 * page, reporting and the dashboard API (SSO). Data lands in the merchant database only (`ss_deals_*`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDashboard } from '../api/dashboard.js';
import { createHarness, MERCHANT, T0, WEBSITE, WEBSITE_2 } from './harness.js';

const ORIGIN = { origin: 'https://shop.example.com' };
const HOUR = 3_600_000;

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({ config: { item_deals: { max_active: 3, max_percent: 50 } } });
});
afterAll(async () => h?.close());

const percentDeal = (/** @type {Record<string, any>} */ extra = {}) => ({
	kind: 'item',
	name: '20% off shoes',
	scope: { collections: ['shoes'] },
	action: { type: 'percent', percent: 20 },
	...extra,
});

describe('deals', () => {
	it('creates, lists (cursor), reads, patches, pauses, resumes and archives deals', async () => {
		h.clock.set(T0);
		const a = await h.call('POST', '/v1/deals', { body: percentDeal({ badge: { label: 'Shoe week' } }) });
		expect(a.status, JSON.stringify(a.json)).toBe(201);
		expect(a.headers.get('location')).toBe(`/v1/deals/${a.json.id}`);
		expect(a.json).toMatchObject({
			badge: { label: 'Shoe week', tone: 'accent' },
			combinesWithCoupons: true,
			usage: { uses: 0, units: 0 },
		});
		expect(a.json.state).toMatchObject({ active: true, phase: 'active', timeZone: 'UTC' });
		const b = await h.call('POST', '/v1/deals', { body: percentDeal({ name: 'Second' }) });
		const page1 = await h.call('GET', '/v1/deals?limit=1');
		expect(page1.json.items).toHaveLength(1);
		expect(page1.headers.get('link')).toContain('rel="next"');
		const page2 = await h.call('GET', `/v1/deals?limit=1&cursor=${page1.json.nextCursor}`);
		expect(page2.json.items[0].id).not.toBe(page1.json.items[0].id);
		expect((await h.call('GET', `/v1/deals?kind=cart`)).json.items).toEqual([]);

		const patched = await h.call('PATCH', `/v1/deals/${a.json.id}`, { body: { action: { percent: 25 }, badge: null } });
		expect(patched.status, JSON.stringify(patched.json)).toBe(200);
		expect(patched.json).toMatchObject({ action: { type: 'percent', percent: 25 }, version: 2, badge: { label: null } });
		expect((await h.call('PATCH', `/v1/deals/${a.json.id}`, { body: { kind: 'cart' } })).json.errors[0]).toMatchObject({
			path: '/kind',
			code: 'immutable',
		});
		expect(
			(await h.call('PATCH', `/v1/deals/${a.json.id}`, { body: { action: { percent: 80 } } })).json.errors[0],
		).toMatchObject({
			path: '/action/percent',
			code: 'percent_invalid',
		});
		expect((await h.call('PATCH', `/v1/deals/${a.json.id}`, { body: [] })).status).toBe(422);
		expect((await h.call('PATCH', '/v1/deals/dl_missing', { body: { name: 'x' } })).status).toBe(404);

		expect((await h.call('POST', `/v1/deals/${a.json.id}/pause`)).json.status).toBe('paused');
		expect((await h.call('POST', `/v1/deals/${a.json.id}/pause`)).json.status).toBe('paused');
		expect((await h.call('GET', `/v1/deals?status=paused`)).json.items.map((/** @type {any} */ d) => d.id)).toEqual([
			a.json.id,
		]);
		expect((await h.call('POST', `/v1/deals/${a.json.id}/resume`)).json.status).toBe('active');
		expect((await h.call('DELETE', `/v1/deals/${b.json.id}`)).json).toEqual({ id: b.json.id, status: 'archived' });
		expect((await h.call('DELETE', `/v1/deals/${b.json.id}`)).status).toBe(404);
		expect((await h.call('GET', `/v1/deals/${b.json.id}`)).json.status).toBe('archived');
		expect((await h.call('GET', '/v1/deals/dl_missing')).status).toBe(404);
		// audit entries in the merchant database
		expect(await h.collection('audit').countDocuments({ websiteId: WEBSITE, action: 'deal.created' })).toBeGreaterThanOrEqual(
			2,
		);
	});

	it('validates against the configured bounds and limits deals per kind', async () => {
		const invalid = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'item',
				name: ' ',
				action: { type: 'percent', percent: 60 },
				schedule: { windows: [{ start: '25:00', end: '02:00', days: ['someday'] }], timeZone: 'Mars/Base' },
				scope: { when: 'item.amount >' },
				class: 'nope',
				extra: 1,
			},
		});
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.map((/** @type {any} */ e) => `${e.path}:${e.code}`)).toEqual(
			expect.arrayContaining([
				'/extra:unknown_field',
				'/name:text_invalid',
				'/class:class_unknown',
				'/schedule/timeZone:time_zone_invalid',
				'/schedule/windows/0/start:time_invalid',
				'/schedule/windows/0/days:days_invalid',
				'/scope/when:condition_invalid',
				'/action/percent:percent_invalid',
			]),
		);
		// max_active = 3 (one open deal so far: the second was archived)
		expect((await h.call('POST', '/v1/deals', { body: percentDeal({ name: 'Third' }) })).status).toBe(201);
		expect((await h.call('POST', '/v1/deals', { body: percentDeal({ name: 'Fourth' }) })).status).toBe(201);
		const over = await h.call('POST', '/v1/deals', { body: percentDeal({ name: 'Fifth' }) });
		expect(over.status).toBe(409);
		expect(over.json.type).toMatch(/deal_limit_reached$/);
		const check = await h.call('POST', '/v1/deals:check', {
			body: percentDeal({
				scope: { when: 'item.amount > 1000 and cart.quantity >= 2' },
				schedule: { windows: [{ start: '18:00', end: '02:00' }] },
			}),
			idempotencyKey: null,
		});
		expect(check.json).toMatchObject({ valid: true, errors: [], schedule: { active: false, phase: 'outside_window' } });
		expect(check.json.conditions['/scope/when'].paths).toEqual(['cart.quantity', 'item.amount']);
		// a kind whose element is off cannot be created (and its deals never apply)
		await h.entitle({ elements: { bundles: false } });
		const bundle = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'bundle',
				name: 'Any 3',
				bundle: { type: 'mix_and_match', scope: { collections: ['socks'] }, quantity: 3 },
				action: { type: 'fixed_price', amount: 2000 },
			},
		});
		expect(bundle.status).toBe(403);
		expect(bundle.json.type).toMatch(/kind_disabled$/);
		await h.entitle();
		// pk_ keys cannot manage deals
		expect((await h.call('GET', '/v1/deals', { key: h.pk, headers: ORIGIN })).status).toBe(403);
	});
});

describe('catalog mirror', () => {
	it('upserts, reads, lists, batches and removes items; events keep prices and stock fresh', async () => {
		const put = await h.call('PUT', '/v1/items/itm_shoe', {
			body: {
				title: 'Trail shoe',
				collections: ['shoes'],
				brand: 'acme',
				attributes: { size: ['42', '43'], colour: 'red' },
				price: 12_000,
				currency: 'EUR',
				variants: [{ variantId: 'var_42', price: 11_000, attributes: { size: '42' } }],
			},
		});
		expect(put.status, JSON.stringify(put.json)).toBe(200);
		expect(put.json).toMatchObject({
			itemId: 'itm_shoe',
			attributes: { size: ['42', '43'], colour: ['red'] },
			variants: [{ variantId: 'var_42', price: 11_000 }],
		});
		expect((await h.call('PUT', '/v1/items/itm_shoe', { body: { itemId: 'other' } })).json.errors[0].code).toBe(
			'path_mismatch',
		);
		expect((await h.call('PUT', '/v1/items/bad%20id', { body: {} })).status).toBe(422);
		const batch = await h.call('POST', '/v1/items:batch', {
			body: {
				items: [
					{ itemId: 'itm_sock', collections: ['socks'], price: 900, currency: 'EUR', stock: 0 },
					{ itemId: 'itm_hat', price: -1 },
				],
			},
		});
		expect(batch.json.results.map((/** @type {any} */ r) => r.status)).toEqual(['upserted', 'rejected']);
		expect((await h.call('POST', '/v1/items:batch', { body: { items: [] } })).status).toBe(422);
		const list = await h.call('GET', '/v1/items?limit=1');
		expect(list.json.hasMore).toBe(true);
		expect((await h.call('GET', '/v1/items/itm_none')).status).toBe(404);

		// events from the Event Hub
		expect(
			(await h.deliver('price.changed@1', { itemId: 'itm_shoe', price: { amount: 11_500, currency: 'EUR' } })).status,
		).toBe(200);
		expect(
			(
				await h.deliver('price.changed@1', {
					itemId: 'itm_shoe',
					variantId: 'var_43',
					price: { amount: 11_900, currency: 'EUR' },
				})
			).status,
		).toBe(200);
		expect(
			(
				await h.deliver('price.changed@1', {
					itemId: 'itm_shoe',
					variantId: 'var_42',
					price: { amount: 10_500, currency: 'EUR' },
				})
			).status,
		).toBe(200);
		expect((await h.deliver('price.changed@1', { itemId: 'itm_new', price: { amount: 700, currency: 'EUR' } })).status).toBe(
			200,
		);
		await h.deliver('inventory.changed@1', { itemId: 'itm_shoe', locationId: 'loc_a', quantity: 4 });
		await h.deliver('inventory.changed@1', { itemId: 'itm_shoe', variantId: 'var_42', locationId: 'loc_b', quantity: 3 });
		await h.deliver('inventory.changed@1', { itemId: 'itm_fresh', quantity: 2 });
		const shoe = (await h.call('GET', '/v1/items/itm_shoe')).json;
		expect(shoe).toMatchObject({ price: 11_500, stock: 7 });
		expect(shoe.variants.find((/** @type {any} */ v) => v.variantId === 'var_42')).toMatchObject({ price: 10_500, stock: 3 });
		expect(shoe.variants.find((/** @type {any} */ v) => v.variantId === 'var_43')).toMatchObject({ price: 11_900 });
		expect((await h.call('GET', '/v1/items/itm_fresh')).json.stock).toBe(2);
		// item.* events: upserts with the fields they carry, deletes, analytics ignored, invalid data ignored
		await h.deliver('item.updated@1', { itemId: 'itm_new', title: 'New thing', collections: ['gifts'] });
		await h.deliver('item.viewed@1', { itemId: 'itm_new' });
		await h.deliver('item.updated@1', { itemId: 'itm_new', price: 'free' });
		expect((await h.call('GET', '/v1/items/itm_new')).json).toMatchObject({
			title: 'New thing',
			collections: ['gifts'],
			price: 700,
		});
		await h.deliver('item.deleted@1', { itemId: 'itm_new' });
		expect((await h.call('GET', '/v1/items/itm_new')).status).toBe(404);
		expect((await h.call('DELETE', '/v1/items/itm_hat')).status).toBe(404);
		expect((await h.call('DELETE', '/v1/items/itm_fresh')).json).toEqual({ itemId: 'itm_fresh', deleted: true });
		// websites without a subscription are ignored
		await h.portal.removeEntitlement(WEBSITE_2);
		expect(
			(await h.deliver('price.changed@1', { itemId: 'x', price: { amount: 1, currency: 'EUR' } }, { websiteId: WEBSITE_2 }))
				.status,
		).toBeLessThan(500);
	});
});

describe('offers, price locks and the deals page', () => {
	it('shows badges, pills, strike-through prices and countdowns for product cards and pages', async () => {
		h.clock.set(T0);
		const flash = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'flash',
				name: 'Flash: acme',
				scope: { brands: ['acme'] },
				action: { type: 'amount_off', amount: 1000 },
				schedule: { endsAt: new Date(T0 + 3 * HOUR).toISOString() },
				limits: { stockUnits: 5 },
			},
		});
		expect(flash.status, JSON.stringify(flash.json)).toBe(201);
		const card = await h.call('POST', '/v1/deals', {
			body: {
				kind: 'cart',
				name: 'Pay by bank: 3% off',
				conditions: { paymentMethods: ['bank_transfer'] },
				action: { type: 'percent', percent: 3 },
			},
		});
		expect(card.status).toBe(201);
		const offers = await h.call('GET', '/v1/offers?items=itm_shoe,itm_shoe:var_42,itm_missing&currency=EUR', {
			key: h.pk,
			headers: ORIGIN,
		});
		expect(offers.status, JSON.stringify(offers.json)).toBe(200);
		const [item, variant] = offers.json.items;
		// 11500 − 25 % (shoes, priority tie → best) vs flash 1000: best for the customer, one item deal per line by default
		expect(item.unitAmount).toBe(11_500);
		expect(item.price).toBeLessThan(11_500);
		expect(item.badge).toBeTruthy();
		expect(variant).toMatchObject({ variantId: 'var_42', unitAmount: 10_500 });
		expect(offers.json.missing).toEqual([{ itemId: 'itm_missing', variantId: null, reason: 'unknown_item' }]);
		expect((await h.call('GET', '/v1/offers', { key: h.pk, headers: ORIGIN })).json).toEqual({
			currency: null,
			items: [],
			missing: [],
		});

		const evaluated = await h.call('POST', '/v1/offers:evaluate', {
			key: h.pk,
			headers: ORIGIN,
			body: {
				currency: 'EUR',
				items: [
					{ itemId: 'itm_other', unitAmount: 5000, brand: 'acme' },
					{ itemId: 'itm_shoe', currency: 'USD' },
				],
			},
			idempotencyKey: null,
		});
		expect(evaluated.status).toBe(422);
		const ok = await h.call('POST', '/v1/offers:evaluate', {
			key: h.pk,
			headers: ORIGIN,
			body: { currency: 'EUR', items: [{ itemId: 'itm_other', unitAmount: 5000, brand: 'acme' }] },
			idempotencyKey: null,
		});
		expect(ok.json.items[0]).toMatchObject({
			price: 4000,
			discount: 1000,
			percentOff: 20,
			countdown: { endsAt: new Date(T0 + 3 * HOUR).toISOString() },
		});
		expect(ok.json.items[0].deals[0]).toMatchObject({ id: flash.json.id, stockLeft: 5 });
		expect(ok.json.items[0].pills.map((/** @type {any} */ p) => p.conditional)).toEqual([false]);
		// cart deal pills when configured
		await h.entitle({ config: { badges: { show_cart_deals: true } } });
		const pills = await h.call('POST', '/v1/offers:evaluate', {
			body: { currency: 'EUR', items: [{ itemId: 'itm_other', unitAmount: 5000, brand: 'acme' }] },
			idempotencyKey: null,
		});
		expect(pills.json.items[0].pills.map((/** @type {any} */ p) => [p.dealId, p.conditional])).toEqual([
			[flash.json.id, false],
			[card.json.id, true],
		]);
		await h.entitle();
		// unknown currencies, unpriced items
		await h.call('PUT', '/v1/items/itm_free', { body: { title: 'No price' } });
		const missing = await h.call('POST', '/v1/offers:evaluate', {
			body: { items: [{ itemId: 'itm_free' }, { itemId: 'itm_shoe' }, { itemId: 'itm_x', unitAmount: 5 }], currency: 'USD' },
			idempotencyKey: null,
		});
		expect(missing.json.missing.map((/** @type {any} */ m) => m.reason)).toEqual(['unpriced', 'currency_mismatch']);
		await h.call('DELETE', `/v1/deals/${card.json.id}`);
	});

	it('lists live and upcoming deals with item previews on the deals page', async () => {
		h.clock.set(T0 + 60_000);
		await h.entitle({ config: { item_deals: { max_active: 10, max_percent: 50 } } });
		const upcoming = await h.call('POST', '/v1/deals', {
			body: percentDeal({
				name: 'Weekend socks',
				scope: { collections: ['socks'] },
				action: { type: 'percent', percent: 10 },
				schedule: { windows: [{ days: ['sat', 'sun'], start: '00:00', end: '00:00' }] },
			}),
		});
		expect(upcoming.status, JSON.stringify(upcoming.json)).toBe(201);
		const page = await h.call('GET', '/v1/deals-page', { key: h.pk, headers: ORIGIN });
		expect(page.status, JSON.stringify(page.json)).toBe(200);
		const names = page.json.items.map((/** @type {any} */ d) => d.name);
		expect(names).toContain('Weekend socks');
		const weekend = page.json.items.find((/** @type {any} */ d) => d.name === 'Weekend socks');
		expect(weekend.schedule).toMatchObject({ active: false, nextStart: '2026-10-03T00:00:00.000Z' });
		// out of stock socks are hidden
		expect(weekend.items).toEqual([]);
		const shoes = page.json.items.find((/** @type {any} */ d) => d.kind === 'item' && d.items.length > 0);
		expect(shoes.items[0]).toMatchObject({ itemId: 'itm_shoe', currency: 'EUR' });
		await h.entitle({ config: { deals_page: { page_size: 1, sort: 'ending_soon', show_upcoming: false } } });
		const first = await h.call('GET', '/v1/deals-page');
		expect(first.json.items).toHaveLength(1);
		expect(first.json.items[0].kind).toBe('flash');
		expect(first.json.items.some((/** @type {any} */ d) => d.name === 'Weekend socks')).toBe(false);
		const second = await h.call('GET', `/v1/deals-page?cursor=${first.json.nextCursor}`);
		expect(second.json.items[0].id).not.toBe(first.json.items[0].id);
		await h.entitle({ config: { deals_page: { sort: 'newest', items_per_deal: 1 } } });
		const newest = await h.call('GET', '/v1/deals-page');
		expect(newest.json.items[0].name).toBe('Weekend socks');
		const items = await h.call('GET', `/v1/deals-page/${shoes.id}/items?limit=1`);
		expect(items.json.items[0].itemId).toBe('itm_shoe');
		expect((await h.call('GET', '/v1/deals-page/dl_nope/items')).status).toBe(404);
		await h.entitle();
	});
	it('issues and verifies price locks for product pages', async () => {
		const issued = await h.call('POST', '/v1/price-locks', {
			key: h.pk,
			headers: ORIGIN,
			body: { currency: 'EUR', items: [{ itemId: 'itm_other', unitAmount: 5000, brand: 'acme' }] },
		});
		expect(issued.status, JSON.stringify(issued.json)).toBe(201);
		const lock = issued.json.items[0].lock;
		expect(lock.token).toMatch(/^pl1\./);
		const verified = await h.call('POST', '/v1/price-locks:verify', {
			key: h.pk,
			headers: ORIGIN,
			body: { token: lock.token },
			idempotencyKey: null,
		});
		expect(verified.json).toMatchObject({ valid: true, itemId: 'itm_other', price: 4000, units: 10 });
		expect((await h.call('POST', '/v1/price-locks:verify', { body: { token: 'pl1.x.y' }, idempotencyKey: null })).json).toEqual(
			{ valid: false, reason: 'invalid' },
		);
		expect((await h.call('POST', '/v1/price-locks:verify', { body: {}, idempotencyKey: null })).status).toBe(422);
		expect((await h.call('POST', '/v1/price-locks', { body: { items: [] } })).status).toBe(422);
		// later: the first lock (15 min) expired; a lock issued while the sale ran (600 min) still holds its price
		h.clock.set(T0 + HOUR);
		await h.entitle({ config: { price_locks: { ttl_minutes: 600 } } });
		const fresh = (
			await h.call('POST', '/v1/price-locks', {
				body: { currency: 'EUR', items: [{ itemId: 'itm_other', unitAmount: 5000, brand: 'acme' }] },
			})
		).json.items[0].lock;
		h.clock.set(T0 + 4 * HOUR);
		const expired = await h.call('POST', '/v1/quotes', {
			body: {
				currency: 'EUR',
				lines: [{ itemId: 'itm_other', quantity: 1, unitAmount: 5000, brand: 'acme' }],
				locks: [lock.token],
			},
		});
		expect(expired.json.lines[0]).toMatchObject({ locked: false, discount: 0 });
		expect(expired.json.stale).toEqual([{ lineId: '1', reason: 'expired' }]);
		const none = (
			await h.call('POST', '/v1/price-locks', {
				body: { currency: 'EUR', items: [{ itemId: 'itm_other', unitAmount: 5000, brand: 'acme' }] },
			})
		).json.items[0].lock;
		expect(none).toBeNull(); // the flash sale ended: nothing to lock
		const honoured = await h.call('POST', '/v1/quotes', {
			body: {
				currency: 'EUR',
				lines: [{ itemId: 'itm_other', quantity: 2, unitAmount: 5000, brand: 'acme' }],
				locks: [fresh.token],
			},
		});
		expect(honoured.json.lines[0]).toMatchObject({ locked: true, discount: 2000 });
		// a changed base price: honoured (never above the new list price) or repriced
		const cheaper = await h.call('POST', '/v1/quotes', {
			body: {
				currency: 'EUR',
				lines: [{ itemId: 'itm_other', quantity: 1, unitAmount: 3000, brand: 'acme' }],
				locks: [fresh.token],
			},
		});
		expect(cheaper.json.lines[0]).toMatchObject({ discount: 0, total: 3000 });
		await h.entitle({ config: { price_locks: { ttl_minutes: 600, on_base_price_change: 'reprice' } } });
		const repriced = await h.call('POST', '/v1/quotes', {
			body: {
				currency: 'EUR',
				lines: [{ itemId: 'itm_other', quantity: 1, unitAmount: 6000, brand: 'acme' }],
				locks: [fresh.token],
			},
		});
		expect(repriced.json.stale).toEqual([{ lineId: '1', reason: 'base_price_changed' }]);
		await h.entitle();
	});
});

describe('reporting and dashboard', () => {
	it('reports orders with deals, discount, uplift and margin', async () => {
		const withDeal = await h.call('POST', '/v1/quotes', {
			body: { currency: 'EUR', customer: { id: 'cus_r' }, lines: [{ itemId: 'itm_shoe', quantity: 1, unitAmount: 11_500 }] },
		});
		expect(withDeal.json.discountTotal).toBeGreaterThan(0);
		await h.call('POST', `/v1/quotes/${withDeal.json.id}/commit`, { body: { orderId: 'ord_r1' } });
		const plain = await h.call('POST', '/v1/quotes', {
			body: { currency: 'EUR', lines: [{ itemId: 'itm_plain', quantity: 1, unitAmount: 4000 }] },
		});
		await h.call('POST', `/v1/quotes/${plain.json.id}/commit`, { body: { orderId: 'ord_r2' } });
		h.clock.advance(60_000);
		const report = await h.call('GET', '/v1/reports');
		expect(report.status).toBe(200);
		expect(report.json).toMatchObject({ orders: 2, ordersWithDeals: 1 });
		expect(report.json.averageOrder.withoutDeals).toBe(4000);
		expect(report.json.upliftPercent).toBeGreaterThan(0);
		expect(report.json.deals[0]).toMatchObject({ uses: 1 });
		const one = await h.call(
			'GET',
			`/v1/reports/deals/${report.json.deals[0].dealId}?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`,
		);
		expect(one.json.report.orders).toBe(1);
		expect((await h.call('GET', '/v1/reports/deals/dl_none')).status).toBe(404);
		expect((await h.call('GET', '/v1/reports', { key: h.pk, headers: ORIGIN })).status).toBe(403);
	});

	const launch = async (/** @type {any} */ kind, extra = {}) => {
		const { token } = await h.portal.issueLaunch({
			kind,
			subject: 'usr_merchant',
			user: { id: 'usr_merchant' },
			scope: { merchantId: MERCHANT, websiteId: WEBSITE },
			...extra,
		});
		const sso = await h.handle(new Request(`https://deals.example.com/sso?launch=${encodeURIComponent(token)}`));
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!session) throw new Error(`no session (${sso.status})`);
		return session;
	};

	it('serves the dashboard API to SSO sessions', async () => {
		const session = await launch('merchant');
		const bearer = { key: session };
		const overview = await h.call('GET', '/v1/dashboard/overview', bearer);
		expect(overview.status, JSON.stringify(overview.json)).toBe(200);
		expect(overview.json.live).toBeGreaterThanOrEqual(1);
		const created = await h.call('POST', '/v1/dashboard/deals', {
			...bearer,
			body: {
				kind: 'cart',
				name: 'Dashboard deal',
				action: { type: 'amount_off', amount: 500 },
				conditions: { minSubtotal: 20_000 },
			},
		});
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		expect((await h.call('POST', '/v1/dashboard/deals', { ...bearer, body: { kind: 'cart' } })).status).toBe(422);
		const paused = await h.call('POST', `/v1/dashboard/deals/${created.json.id}/status`, {
			...bearer,
			body: { status: 'paused' },
		});
		expect(paused.json.status).toBe('paused');
		expect(
			(await h.call('POST', `/v1/dashboard/deals/${created.json.id}/status`, { ...bearer, body: { status: 'x' } })).status,
		).toBe(422);
		expect((await h.call('POST', '/v1/dashboard/deals/dl_none/status', { ...bearer, body: { status: 'paused' } })).status).toBe(
			404,
		);
		const preview = await h.call('POST', '/v1/dashboard/quotes:preview', {
			...bearer,
			body: { currency: 'EUR', lines: [{ itemId: 'itm_shoe', quantity: 1, unitAmount: 11_500 }] },
			idempotencyKey: null,
		});
		expect(preview.json).toMatchObject({ id: null, status: 'preview' });
		expect(preview.json.ineligible[created.json.id]).toBe('inactive');
		expect((await h.call('POST', '/v1/dashboard/quotes:preview', { ...bearer, body: {}, idempotencyKey: null })).status).toBe(
			422,
		);
		const audited = await h.collection('audit').findOne({ websiteId: WEBSITE, action: 'deal.paused', target: created.json.id });
		expect(audited?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		// staff (admin launch) act as staff; without a website the dashboard API asks for one
		const staff = { key: await launch('admin') };
		await h.call('POST', `/v1/dashboard/deals/${created.json.id}/status`, { ...staff, body: { status: 'active' } });
		const byStaff = await h.collection('audit').findOne({ websiteId: WEBSITE, action: 'deal.active', target: created.json.id });
		expect(byStaff?.actor).toMatchObject({ type: 'staff', id: 'usr_merchant' });
		const noWebsite = { key: await launch('admin', { scope: { merchantId: MERCHANT } }) };
		expect((await h.call('POST', '/v1/dashboard/deals', { ...noWebsite, body: {} })).status).toBe(400);
		expect((await h.call('GET', '/v1/dashboard/overview', noWebsite)).status).toBe(400);
		expect((await h.call('GET', '/v1/session', bearer)).json).toMatchObject({ kind: 'merchant', role: 'merchant' });
	});

	it('resolves the dashboard pages for merchant and admin launches', async () => {
		expect((await resolveDashboard({ deals: h.deals, sessionId: null })).state).toBe('signin');
		const live = await resolveDashboard({ deals: h.deals, sessionId: await launch('merchant') });
		expect(live.state).toBe('ready');
		if (live.state !== 'ready') return;
		expect(live.data).toMatchObject({ canWrite: true, websiteId: WEBSITE });
		expect((await live.data.deals()).length).toBeGreaterThan(0);
		const first = (await live.data.deals())[0];
		expect((await live.data.deal(/** @type {any} */ (first).id))?.id).toBe(/** @type {any} */ (first).id);
		expect(live.portalLink).toContain(`/websites/${WEBSITE}/subscriptions/`);
		expect((await live.data.overview()).report).toBeTruthy();
		const admin = await launch('admin', { scope: { merchantId: MERCHANT } });
		expect((await resolveDashboard({ deals: h.deals, sessionId: admin })).state).toBe('pick_website');
		await h.entitle({ elements: { quote_api: false } });
		expect((await resolveDashboard({ deals: h.deals, sessionId: await launch('merchant') })).state).toBe('not_subscribed');
		await h.entitle();
	});
});
