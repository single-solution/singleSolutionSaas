import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateStatusResponse, validateWebsitesPage } from '@ss/contracts';
import { closeMongoClients } from '../../../src/infra/db.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import {
	FINANCE_ADMIN,
	HOUR,
	M1,
	M2,
	OWNER_ADMIN,
	PRODUCT,
	PRODUCT2,
	SUPPORT_ADMIN,
	W1,
	W2,
	W3,
	bootCommerce,
	priceList,
} from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const ADMIN = Object.freeze({ type: 'admin', id: 'adm_owner', role: 'owner', name: 'Olivia' });
const MIN = 60_000;

/** @param {{ status: number, json: any }} res */
const codeOf = (res) => [
	res.status,
	String(res.json?.type ?? '')
		.split('/')
		.pop(),
];

/**
 * A harness with Coupons priced (codes 1 credit/h, box 0.5 credit/h, box needs codes) and on W1.
 * @param {string} dbName
 */
const setUp = async (dbName) => {
	const clock = createClock(T0);
	const h = await bootCommerce({ mongo, dbName, clock });
	await h.prices(PRODUCT, 1, { codes: 1000, box: 500 });
	await h.service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
	h.world.notices.splice(0);
	const coupons = await h.productAuth(PRODUCT);
	/**
	 * @param {string} method @param {string} path @param {unknown} [body]
	 */
	const product = async (method, path, body) =>
		h.call(method, path, { headers: await coupons(), ...(body === undefined ? {} : { body }) });
	/** @param {string} websiteId @param {Record<string, unknown>} body */
	const features = (websiteId, body) => product('PUT', `/v1/product/websites/${websiteId}/features`, body);
	/** @param {string} websiteId */
	const status = (websiteId) => product('GET', `/v1/product/websites/${websiteId}/status`);
	return { h, clock, product, features, status };
};

describe('price reports (PLAN 0.4.12 row 2)', () => {
	it('accepts a higher version whole, applies it at once and writes Activity as reported by the product', async () => {
		const { h, product } = await setUp('cc_prices');
		const report = priceList(2, { codes: 1500, box: 500 });
		expect(await product('PUT', '/v1/product/prices', report)).toMatchObject({ status: 200, json: { version: 2 } });
		expect(await h.service.priceListVersion(PRODUCT)).toBe(2);
		expect((await h.service.currentPriceList(PRODUCT))?.features).toMatchObject([
			{ key: 'codes', price: 1500 },
			{ key: 'box', price: 500 },
		]);
		const [entry] = await h.portal.shared.audit.list({ action: 'product.prices_changed' });
		expect(entry).toMatchObject({
			actor: { type: 'product', id: PRODUCT },
			target: { type: 'product', id: PRODUCT },
			after: { productId: PRODUCT, version: 2, changes: [{ key: 'codes', before: 1000, after: 1500 }], dropped: [] },
		});
		// a dropped feature stops being charged; a new one starts at its price
		await product('PUT', '/v1/product/prices', priceList(3, { codes: 1500, extra: 0 }));
		const entries = await h.portal.shared.audit.list({ action: 'product.prices_changed' });
		expect(entries.find((e) => e.after.version === 3)?.after).toMatchObject({
			changes: [{ key: 'extra', before: null, after: 0 }],
			dropped: ['box'],
		});
	});

	it('refuses the whole report: bad shape or price (422), version not higher (409), no product (401)', async () => {
		const { h, product } = await setUp('cc_prices_refused');
		const negative = priceList(2, { codes: -1 });
		expect(codeOf(await product('PUT', '/v1/product/prices', negative))).toEqual([422, 'validation_failed']);
		const fraction = priceList(2, { codes: 1.5 });
		expect(codeOf(await product('PUT', '/v1/product/prices', fraction))).toEqual([422, 'validation_failed']);
		expect(codeOf(await product('PUT', '/v1/product/prices', { version: 2 }))).toEqual([422, 'validation_failed']);
		expect(codeOf(await product('PUT', '/v1/product/prices', priceList(1, { codes: 5 })))).toEqual([409, 'conflict']);
		expect(await h.service.priceListVersion(PRODUCT)).toBe(1);
		expect((await h.call('PUT', '/v1/product/prices', { body: priceList(9, { codes: 1 }) })).status).toBe(401);
		expect(await h.service.priceListVersion(PRODUCT2)).toBe(0);
		expect(await h.service.currentPriceList(PRODUCT2)).toBeNull();
	});
});

describe('feature reports (PLAN 0.4.12 row 3)', () => {
	it('accepts the switches with the Portal clock, charges them and writes Activity with the stored admin name', async () => {
		const { h, clock, features } = await setUp('cc_features');
		await h.credit(M1, 100_000);
		clock.set(T0 + 30 * MIN);
		const accepted = await features(W1, { version: 1, on: ['codes', 'box'], adminId: SUPPORT_ADMIN, adminName: 'Not my name' });
		expect(accepted).toMatchObject({ status: 200, json: { version: 1 } });
		const doc = await h.db.collection('commerce_products').findOne({ _id: /** @type {any} */ (`${W1}:${PRODUCT}`) });
		expect(doc).toMatchObject({
			on: ['box', 'codes'],
			featuresVersion: 1,
			reportedBy: SUPPORT_ADMIN,
			reportedAt: new Date(T0 + 30 * MIN),
		});
		const entry = (await h.portal.shared.audit.list({ action: 'product.features_changed' }))[0];
		expect(entry).toMatchObject({
			actor: { type: 'admin', id: SUPPORT_ADMIN, name: 'Sam' },
			merchantId: M1,
			target: { type: 'website', id: W1 },
			before: { on: [] },
			after: { productId: PRODUCT, version: 1, on: ['box', 'codes'] },
		});
		clock.set(T0 + 2 * HOUR + 5 * MIN);
		expect((await h.service.billingSummary(M1)).balance).toBe(100_000 - 3 * 1500);
		// switching off: the started hour is kept
		expect((await features(W1, { version: 2, on: [], adminId: OWNER_ADMIN, adminName: 'x' })).status).toBe(200);
		clock.set(T0 + 5 * HOUR);
		expect((await h.service.billingSummary(M1)).balance).toBe(100_000 - 3 * 1500);
	});

	it('refuses the whole report for every rule of row 3', async () => {
		const { h, product, features } = await setUp('cc_features_refused');
		const body = (/** @type {Record<string, unknown>} */ over = {}) => ({
			version: 1,
			on: ['codes'],
			adminId: OWNER_ADMIN,
			adminName: 'Olivia',
			...over,
		});
		// bad shape
		expect(codeOf(await features(W1, { version: 1 }))).toEqual([422, 'validation_failed']);
		// an unknown key
		const unknown = await features(W1, body({ on: ['nope'] }));
		expect(codeOf(unknown)).toEqual([422, 'validation_failed']);
		expect(unknown.json.errors).toEqual([{ path: '/on/0', message: 'nope is not a feature of coupons' }]);
		// a feature that is no longer priced
		await product('PUT', '/v1/product/prices', priceList(2, { codes: 1000 }));
		const unpriced = await features(W1, body({ on: ['codes', 'box'] }));
		expect(unpriced.json.errors).toEqual([{ path: '/on/1', message: 'box has no price' }]);
		await product('PUT', '/v1/product/prices', priceList(3, { codes: 1000, box: 500 }));
		// a dependency off
		const dependency = await features(W1, body({ on: ['box'] }));
		expect(dependency.json.errors).toEqual([{ path: '/on/0', message: 'box needs codes, which is off' }]);
		// a website × product that never existed
		expect(codeOf(await features(W2, body()))).toEqual([404, 'website_not_found']);
		// adminId not a current Owner or Support admin
		expect(codeOf(await features(W1, body({ adminId: 'adm_ghost000000000000000000' })))).toEqual([422, 'validation_failed']);
		h.world.admins.set(SUPPORT_ADMIN, { adminId: SUPPORT_ADMIN, name: 'Sam', role: 'support', status: 'removed' });
		expect(codeOf(await features(W1, body({ adminId: SUPPORT_ADMIN })))).toEqual([422, 'validation_failed']);
		expect(codeOf(await features(W1, body({ adminId: FINANCE_ADMIN })))).toEqual([403, 'forbidden']);
		// accepted once, then a version not higher
		expect((await features(W1, body())).status).toBe(200);
		expect(codeOf(await features(W1, body()))).toEqual([409, 'conflict']);
		// a deleted website
		h.world.websites.set(W1, { websiteId: W1, merchantId: M1, domain: 'shop.example.com', status: 'removed' });
		expect(codeOf(await features(W1, body({ version: 2 })))).toEqual([404, 'website_not_found']);
		expect(await h.portal.shared.audit.list({ action: 'product.features_changed' })).toHaveLength(1);
	});

	it('is accepted while stopped, suspended or removed; nothing is charged then and a re-add starts all off', async () => {
		const { h, clock, features } = await setUp('cc_features_states');
		await h.credit(M1, 10_000);
		await h.service.removeProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		expect((await features(W1, { version: 1, on: ['codes'], adminId: OWNER_ADMIN, adminName: 'O' })).status).toBe(200);
		clock.set(T0 + 3 * HOUR);
		expect((await h.service.billingSummary(M1)).balance).toBe(10_000);
		await h.service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		const card = (await h.service.productsForWebsite(M1, W1))[0];
		expect(card).toMatchObject({ featuresOn: [], featuresVersion: 1, hourlyCost: 0 });
		await h.service.onMerchantStatus({ merchantId: M1, status: 'suspended' });
		expect((await features(W1, { version: 2, on: ['codes'], adminId: OWNER_ADMIN, adminName: 'O' })).status).toBe(200);
		clock.set(T0 + 6 * HOUR);
		expect((await h.service.billingSummary(M1)).balance).toBe(10_000);
	});
});

describe('status (PLAN 0.4.12 row 4)', () => {
	it('settles first and answers every status: active, grace, stopped, suspended, removed; 404 otherwise', async () => {
		const { h, clock, features, status } = await setUp('cc_status');
		await h.credit(M1, 2000);
		await features(W1, { version: 1, on: ['codes'], adminId: OWNER_ADMIN, adminName: 'O' });
		clock.set(T0 + 30 * MIN);
		const active = await status(W1);
		expect(active.json).toEqual({
			websiteId: W1,
			merchantId: M1,
			merchantName: 'One',
			domain: 'shop.example.com',
			status: 'active',
			graceEndsAt: null,
			todayMillicredits: 1000,
			featuresVersion: 1,
			validUntil: new Date(T0 + 35 * MIN).toISOString(),
		});
		expect(validateStatusResponse(active.json).ok).toBe(true);
		// the status fetch is a use: it settles the merchant, finds grace and tells the products once
		clock.set(T0 + HOUR + 10 * MIN);
		const grace = await status(W1);
		expect(grace.json).toMatchObject({ status: 'grace', graceEndsAt: '2026-10-04T11:00:00.000Z', todayMillicredits: 2000 });
		expect(h.world.notices).toEqual([{ productId: PRODUCT, body: { type: 'status.changed', websiteId: W1 } }]);
		expect((await status(W1)).json.status).toBe('grace');
		expect(h.world.notices).toHaveLength(1);
		// validUntil never passes the end of grace
		clock.set(Date.parse('2026-10-04T10:58:00Z'));
		expect((await status(W1)).json.validUntil).toBe('2026-10-04T11:00:00.000Z');
		clock.set(Date.parse('2026-10-04T11:30:00Z'));
		expect((await status(W1)).json).toMatchObject({ status: 'stopped', graceEndsAt: null, todayMillicredits: 11_000 });
		expect(h.world.notices).toHaveLength(2);
		// credits that bring the balance above 0 restart the products at once
		await h.credit(M1, 200_000);
		expect(h.world.notices).toHaveLength(3);
		expect((await status(W1)).json.status).toBe('active');
		// suspended, then removed
		await h.service.onMerchantStatus({ merchantId: M1, status: 'suspended' });
		h.world.merchants.set(M1, { merchantId: M1, name: 'One', status: 'suspended' });
		expect((await status(W1)).json.status).toBe('suspended');
		expect(h.world.notices).toHaveLength(4);
		await h.service.removeProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		expect((await status(W1)).json.status).toBe('removed');
		// a website × product that never existed, and a deleted website
		expect(codeOf(await status(W2))).toEqual([404, 'website_not_found']);
		h.world.websites.set(W1, { websiteId: W1, merchantId: M1, domain: 'shop.example.com', status: 'removed' });
		expect(codeOf(await status(W1))).toEqual([404, 'website_not_found']);
	});
});

describe('websites of a product (row 5) and per-product numbers', () => {
	it('lists the websites that have the product, removed excluded, paged; counts websites and credits earned', async () => {
		const { h, clock, features } = await setUp('cc_websites');
		await h.credit(M1, 500_000);
		await h.service.addProduct({ merchantId: M1, websiteId: W2, productId: PRODUCT, actor: ADMIN });
		await h.service.addProduct({ merchantId: M2, websiteId: W3, productId: PRODUCT, actor: ADMIN });
		await h.service.addProduct({ merchantId: M2, websiteId: W3, productId: PRODUCT2, actor: ADMIN });
		await h.service.removeProduct({ merchantId: M1, websiteId: W2, productId: PRODUCT, actor: ADMIN });
		await features(W1, { version: 1, on: ['codes'], adminId: OWNER_ADMIN, adminName: 'O' });
		const page = await h.service.websitesOfProduct({ productId: PRODUCT, cursor: null });
		expect(page).toEqual({
			items: [
				{ websiteId: W1, domain: 'shop.example.com', merchantId: M1, merchantName: 'One', status: 'active' },
				{ websiteId: W3, domain: 'two.example.org', merchantId: M2, merchantName: 'Two', status: 'active' },
			],
			cursor: null,
		});
		expect(validateWebsitesPage(page).ok).toBe(true);
		await expect(h.service.websitesOfProduct({ productId: PRODUCT, cursor: '***' })).rejects.toMatchObject({
			code: 'bad_request',
		});
		const after = await h.service.websitesOfProduct({
			productId: PRODUCT,
			cursor: Buffer.from(`${W1}:${PRODUCT}`).toString('base64url'),
		});
		expect(after.items.map((i) => i.websiteId)).toEqual([W3]);
		const view = await h.service.productWebsitesView({ productId: PRODUCT, cursor: null });
		expect(view.items[0]).toMatchObject({ websiteId: W1, featuresOn: ['codes'], dailyCost: 24_000 });

		// day 1: 14 hours; day 2 (today): 3 hours so far
		clock.set(T0 + 16 * HOUR + 30 * MIN);
		const numbers = await h.service.productNumbers(PRODUCT);
		expect(numbers).toMatchObject({ productId: PRODUCT, websites: 2, earnedThisMonth: 17_000 });
		expect(numbers.days).toHaveLength(30);
		expect(numbers.days.slice(-2)).toEqual([
			{ day: '2026-10-01', amount: 14_000 },
			{ day: '2026-10-02', amount: 3000 },
		]);
		const all = await h.service.allProductNumbers();
		expect(all.map((n) => [n.productId, n.websites, n.earnedThisMonth])).toEqual([
			[PRODUCT, 2, 17_000],
			[PRODUCT2, 1, 0],
		]);
		expect(await h.service.productNumbers('unknown')).toMatchObject({ productId: 'unknown', websites: 0, earnedThisMonth: 0 });
	});

	it('notices never fail a change: a product that cannot be told is logged', async () => {
		const { h } = await setUp('cc_notices');
		h.world.failNotices = true;
		const removed = await h.service.removeProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		expect(removed.status).toBe('removed');
		expect(h.logs.some((e) => e.msg === 'status.changed not queued')).toBe(true);
		// removing works even when the product cannot be reached; a re-add restores the same tokens
		h.world.failNotices = false;
		await h.service.addProduct({ merchantId: M1, websiteId: W1, productId: PRODUCT, actor: ADMIN });
		expect(h.world.notices).toEqual([{ productId: PRODUCT, body: { type: 'status.changed', websiteId: W1 } }]);
		expect(h.world.tokens.filter((t) => t.websiteId === W1)).toHaveLength(2);
		expect(await h.service.productOnWebsite(W1, PRODUCT)).toEqual({
			websiteId: W1,
			productId: PRODUCT,
			merchantId: M1,
			status: 'added',
		});
		expect(await h.service.productOnWebsite(W2, PRODUCT)).toBeNull();
		expect(await h.service.merchantWebsitesWithProduct(M1, PRODUCT)).toEqual([W1]);
		expect(await h.service.productsOnWebsiteCount(W1)).toBe(1);
		await expect(
			h.service.removeProduct({ merchantId: M1, websiteId: W3, productId: PRODUCT, actor: ADMIN }),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});
