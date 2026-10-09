import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { T0, createClock, startMongo } from '../../helpers.js';
import { HOUR, M1, M2, PRODUCT, PRODUCT2, STAFF, W1, W2, W3, bootCommerce } from './fixtures.js';

// Mongo-backed tests share the machine with other suites: allow for slow replica-set start-up and I/O.
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

let n = 0;
const idem = () => ({ 'idempotency-key': `k-${(n += 1)}` });

describe('commerce routes and tenant isolation', () => {
	it('enforces merchant, admin role (PLAN 0.2) and product boundaries on every route', async () => {
		const clock = createClock(T0);
		const h = await bootCommerce({ mongo, dbName: 'cm_routes', clock });
		await h.credit(M1, 100_000);
		const owner1 = await h.login({ kind: 'merchant', subject: M1 });
		const owner2 = await h.login({ kind: 'merchant', subject: M2 });
		const admin = await h.login({ kind: 'admin', subject: 'adm_owner' });
		const support = await h.login({ kind: 'admin', subject: 'adm_support' });

		// products on websites: Owner and Support add them; merchants only view (PLAN 0.2)
		const add = (
			/** @type {Record<string, string>} */ who,
			/** @type {string} */ merchant,
			/** @type {string} */ website,
			/** @type {unknown} */ body,
		) => h.call('POST', `/v1/merchants/${merchant}/websites/${website}/products`, { headers: { ...who, ...idem() }, body });
		expect((await add(owner1, M1, W1, { productId: PRODUCT })).status).toBe(403);
		const created = await add(admin, M1, W1, { productId: PRODUCT });
		expect(created.status).toBe(201);
		expect(created.json.product).toMatchObject({ productId: PRODUCT, name: 'Ecommerce', status: 'active', featuresOn: [] });
		expect((await add(support, M2, W3, { productId: PRODUCT })).status).toBe(201);
		expect((await add(admin, M1, W3, { productId: PRODUCT2 })).status).toBe(404); // W3 is M2's
		expect((await add(admin, M1, W2, { productId: 'Not an id' })).status).toBe(422);
		expect((await add(admin, M1, W2, { productId: 'unknown' })).status).toBe(409); // not connected
		h.world.products.set(PRODUCT2, { productId: PRODUCT2, name: 'Notice', status: 'inactive' });
		expect((await add(admin, M1, W2, { productId: PRODUCT2 })).status).toBe(409); // inactive: not offered
		h.world.products.set(PRODUCT2, { productId: PRODUCT2, name: 'Notice', status: 'active' });
		expect((await add(admin, M1, W2, { productId: PRODUCT2 })).status).toBe(201);
		expect((await add(admin, M1, W2, { productId: PRODUCT2 })).status).toBe(409); // already on the website
		expect(h.world.tokens.map((t) => `${t.websiteId}:${t.productId}`)).toEqual([
			`${W1}:${PRODUCT}`,
			`${W3}:${PRODUCT}`,
			`${W2}:${PRODUCT2}`,
		]);

		// cross-merchant access is refused before any lookup
		for (const [method, path] of /** @type {const} */ ([
			['GET', `/v1/merchants/${M1}/websites/${W1}/products`],
			['POST', `/v1/merchants/${M1}/websites/${W1}/products`],
			['DELETE', `/v1/merchants/${M1}/websites/${W1}/products/${PRODUCT}`],
			['GET', `/v1/merchants/${M1}/billing`],
			['GET', `/v1/merchants/${M1}/usage`],
			['GET', `/v1/merchants/${M1}/receipts`],
		])) {
			const res = await h.call(method, path, {
				headers: { ...owner2, ...(method === 'POST' ? idem() : {}) },
				...(method === 'POST' ? { body: { productId: PRODUCT } } : {}),
			});
			expect([method, path, res.status]).toEqual([method, path, 403]);
		}
		// own merchant: the cards of a website
		const cards = await h.call('GET', `/v1/merchants/${M1}/websites/${W1}/products`, { headers: owner1 });
		expect(cards.json.items).toMatchObject([{ productId: PRODUCT, status: 'active', hourlyCost: 0, dailyCost: 0 }]);
		expect((await h.call('GET', `/v1/merchants/${M2}/websites/${W3}/products`, { headers: owner2 })).json.items).toHaveLength(
			1,
		);
		// removing: Owner and Support; merchants cannot
		const remove = (/** @type {Record<string, string>} */ who, /** @type {string} */ productId) =>
			h.call('DELETE', `/v1/merchants/${M1}/websites/${W2}/products/${productId}`, { headers: who });
		expect((await remove(owner1, PRODUCT2)).status).toBe(403);
		expect((await remove(support, PRODUCT2)).json).toEqual({ websiteId: W2, productId: PRODUCT2, status: 'removed' });
		expect((await remove(support, PRODUCT2)).status).toBe(404);
		expect((await h.call('GET', `/v1/merchants/${M1}/websites/${W2}/products`, { headers: owner1 })).json.items).toEqual([]);
		expect((await h.portal.shared.audit.list({ merchantId: M1 })).map((a) => a.action)).toEqual(
			expect.arrayContaining(['product.added', 'product.removed']),
		);

		// money views (each runs the check first)
		await h.prices(PRODUCT, 1, { codes: 1000 });
		await h.service.recordSwitches({ merchantId: M1, websiteId: W1, productId: PRODUCT, on: ['codes'] });
		clock.set(T0 + 2 * HOUR + 5 * 60_000);
		const billing = await h.call('GET', `/v1/merchants/${M1}/billing`, { headers: owner1 });
		expect(billing.json).toMatchObject({ merchantId: M1, status: 'active', balance: 97_000, dailySpend: 24_000, daysLeft: 4 });
		const usage = await h.call('GET', `/v1/merchants/${M1}/usage?from=2026-10-01&to=2026-10-01&websiteId=${W1}`, {
			headers: owner1,
		});
		expect(usage.json.rows).toMatchObject([{ feature: 'codes', featureName: 'Codes', hours: 3, amount: 3000 }]);
		expect((await h.call('GET', `/v1/merchants/${M1}/usage?from=nope`, { headers: owner1 })).status).toBe(422);

		// adding credits: Owner and Finance only, with the receipt form (PLAN 0.5.8)
		const receipt = (/** @type {Record<string, string>} */ who, /** @type {unknown} */ body) =>
			h.call('POST', `/v1/admin/merchants/${M1}/receipts`, { headers: { ...who, ...idem() }, body });
		const form = { credits: 50, amountPaid: 'PKR 5,000', method: 'Bank transfer', reference: 'wire-77' };
		expect((await receipt(owner1, form)).status).toBe(401);
		expect((await receipt(support, form)).status).toBe(403);
		expect((await receipt(admin, { ...form, credits: 0 })).status).toBe(422);
		const key = idem();
		const added = await h.call('POST', `/v1/admin/merchants/${M1}/receipts`, { headers: { ...admin, ...key }, body: form });
		expect(added.status).toBe(201);
		expect(added.json.receipt).toMatchObject({ credits: 50_000, amountPaid: 'PKR 5,000', method: 'Bank transfer' });
		expect(added.json.summary.balance).toBe(147_000);
		// a double submit with the same one-time key saves once
		const again = await h.call('POST', `/v1/admin/merchants/${M1}/receipts`, { headers: { ...admin, ...key }, body: form });
		expect(again.headers.get('idempotent-replayed')).toBe('true');
		const finance = await h.login({ kind: 'admin', subject: 'adm_finance' });
		expect((await receipt(finance, { ...form, reference: undefined })).status).toBe(201);
		// the amount paid is shown to admins only
		const own = await h.call('GET', `/v1/merchants/${M1}/receipts`, { headers: owner1 });
		expect(own.json.items).toHaveLength(3);
		expect(own.json.items.every((/** @type {any} */ r) => !('amountPaid' in r))).toBe(true);
		const seen = await h.call('GET', `/v1/merchants/${M1}/receipts`, { headers: support });
		expect(seen.json.items[1]).toMatchObject({ amountPaid: 'PKR 5,000' });
		expect((await h.portal.shared.audit.list({ merchantId: M1 })).map((a) => a.action)).toContain('credits.added');

		// Credits and billing: Support views, Finance views
		for (const path of [
			`/v1/admin/merchants/${M1}/day-charges`,
			`/v1/admin/billing/merchants?ids=${M1},${M2},bad`,
			'/v1/admin/billing/attention',
			'/v1/admin/billing/receipts?method=Bank%20transfer',
			'/v1/admin/billing/charges?by=merchant',
		]) {
			expect([path, (await h.call('GET', path, { headers: support })).status]).toEqual([path, 200]);
			expect((await h.call('GET', path, { headers: owner1 })).status).toBe(401);
		}
		expect(
			(await h.call('GET', `/v1/admin/billing/merchants?ids=${M1},${M2},bad`, { headers: finance })).json.items,
		).toHaveLength(2);
		expect(
			(await h.call('GET', '/v1/admin/billing/receipts?method=Bank%20transfer', { headers: finance })).json.items,
		).toHaveLength(3);
		expect((await h.call('GET', '/v1/admin/billing/charges?by=week', { headers: finance })).status).toBe(422);
		expect((await h.call('GET', '/v1/admin/billing/charges?from=x', { headers: finance })).status).toBe(422);
		expect((await h.call('GET', '/v1/admin/billing/receipts?merchantId=x', { headers: finance })).status).toBe(422);

		// product routes need the product's client assertion; a session never reaches them
		const asProduct = await h.productAuth(PRODUCT);
		expect((await h.call('GET', `/v1/product/websites/${W1}/status`)).status).toBe(401);
		expect((await h.call('GET', `/v1/product/websites/${W1}/status`, { headers: owner1 })).status).toBe(401);
		expect((await h.call('GET', `/v1/product/websites/${W1}/status`, { headers: await asProduct() })).json).toMatchObject({
			websiteId: W1,
			status: 'active',
		});
		expect(STAFF.type).toBe('admin');
	});
});
