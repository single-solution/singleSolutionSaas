/**
 * Ecommerce's staff routes and configuration routes: orders, products, customers, coupons, refunds and the order-number
 * counter belong to a verified staff member with the permission; the server token alone changes none of them and reads
 * no order (SEC). Shop reads and the shopper's own actions (with the shopper's sign-in) are the website's runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

/** @param {{ json: any }} response */
const typeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

describe('Ecommerce with the server token alone', () => {
	it('moves no order, edits no catalog, no customer, no coupon, no setting: 403 needs_signed_in_staff', async () => {
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['GET', '/v1/orders', undefined],
			['GET', '/v1/orders/count', undefined],
			['GET', '/v1/orders/ord_none', undefined],
			['POST', '/v1/orders/ord_none/move', { to: 'confirmed' }],
			['POST', '/v1/orders/ord_none/refunds', { amount: 1 }],
			['DELETE', '/v1/orders/ord_none', undefined],
			['POST', '/v1/orders/counter', { next: 5000 }],
			['GET', '/v1/customers', undefined],
			['PATCH', '/v1/customers/cus_none', { name: 'x' }],
			['POST', '/v1/products', { name: 'Cup', price: 100 }],
			['PATCH', '/v1/products/prd_none', { status: 'active' }],
			['POST', '/v1/coupons', { code: 'SEC' }],
			['POST', '/v1/deals', { name: 'x' }],
			['GET', '/v1/events', undefined],
			['GET', '/v1/csv/orders', undefined],
			['POST', '/v1/data/delete-all', { scope: 'orders', confirm: 'DELETE orders' }],
			['PUT', '/v1/format', { wholeUnits: true }],
			['PUT', '/v1/theme', { radius: 3 }],
			['PUT', '/v1/lists/order_flow', { value: {} }],
			['PUT', '/v1/connections/storage', { value: { bucket: 'x' } }],
			['GET', '/v1/connections', undefined],
			['GET', '/v1/activity', undefined],
		])) {
			const refused = await shop.call(method, path, {
				token: shop.server,
				bare: true,
				...(body === undefined ? {} : { body }),
			});
			expect([method, path, refused.status, typeOf(refused)]).toEqual([method, path, 403, 'needs_signed_in_staff']);
		}
	});

	it('still runs the shop: reads for the storefront and the policies', async () => {
		for (const path of ['/v1/policies', '/v1/features', '/v1/settings', '/v1/theme', '/v1/format', '/v1/llms.txt']) {
			const read = await shop.call('GET', path, { token: shop.server, bare: true });
			expect([path, read.status === 403 ? await typeOf(read) : 'ok']).toEqual([path, 'ok']);
		}
	});
});

describe('every connection of the product (database, storage, provider keys, pasted product tokens)', () => {
	it('cannot be saved, removed or test-called with the server token alone: 403, and the list stays as it was', async () => {
		const listed = await shop.call('GET', '/v1/connections', { token: shop.server });
		const names = listed.json.connections.map((/** @type {{ name: string }} */ c) => c.name);
		expect(names).toContain('database');
		for (const name of names) {
			for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
				['PUT', `/v1/connections/${name}`, { value: 'attacker-value' }],
				['DELETE', `/v1/connections/${name}`, undefined],
				['POST', `/v1/connections/${name}/test`, undefined],
			])) {
				const refused = await shop.call(method, path, {
					token: shop.server,
					bare: true,
					...(body === undefined ? {} : { body }),
				});
				expect([name, method, refused.status, String(refused.json?.type).split('/').pop()]).toEqual([
					name,
					method,
					403,
					'needs_signed_in_staff',
				]);
			}
		}
		const after = await shop.call('GET', '/v1/connections', { token: shop.server });
		expect(after.json.connections).toEqual(listed.json.connections);
	});
});

describe('a staff sign-in', () => {
	it('with orders.manage moves an order, with that person in its history', async () => {
		await shop.switchOn(ALL);
		const staff = { id: 'usr_sec4', name: 'Olive Orders', permissions: ['ecommerce:orders.manage'] };
		const moved = await shop.call('POST', '/v1/orders/ord_none/move', { token: shop.server, staff, body: { to: 'confirmed' } });
		// allowed through the gate: the order itself does not exist
		expect(moved.status).toBe(404);
	});

	it('without the permission (customer, other permission, other product’s) is refused 403 forbidden', async () => {
		await shop.switchOn(ALL);
		for (const permissions of [[], ['ecommerce:orders.read'], ['chat:orders.manage'], ['ecommerce:orders']]) {
			const refused = await shop.call('POST', '/v1/orders/ord_none/move', {
				token: shop.server,
				staff: { permissions },
				body: { to: 'confirmed' },
			});
			expect([JSON.stringify(permissions), refused.status, typeOf(refused)]).toEqual([
				JSON.stringify(permissions),
				403,
				'forbidden',
			]);
		}
		// a refund is its own permission, and a shopper’s own sign-in is no staff
		const noRefund = await shop.call('POST', '/v1/orders/ord_none/refunds', {
			token: shop.server,
			staff: { permissions: ['ecommerce:orders.manage'] },
			body: { amount: 1 },
		});
		expect([noRefund.status, typeOf(noRefund)]).toEqual([403, 'forbidden']);
		const sara = await shop.signIn();
		const asShopper = await shop.call('POST', '/v1/orders/ord_none/move', {
			token: shop.server,
			bare: true,
			headers: { 'ss-sign-in': sara },
			body: { to: 'confirmed' },
		});
		expect([asShopper.status, typeOf(asShopper)]).toEqual([403, 'forbidden']);
	});

	it('of another website is refused 401 invalid_sign_in', async () => {
		await shop.staffHeaders();
		const other = await shop.accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_x', permissions: ['*'] });
		const refused = await shop.call('POST', '/v1/orders/ord_none/move', {
			token: shop.server,
			bare: true,
			headers: { 'ss-sign-in': other },
			body: { to: 'confirmed' },
		});
		expect([refused.status, typeOf(refused)]).toEqual([401, 'invalid_sign_in']);
	});

	it('the order-number counter (a configuration) needs a staff member with orders.manage', async () => {
		const set = await shop.call('POST', '/v1/orders/counter', {
			token: shop.server,
			staff: { permissions: ['ecommerce:orders.manage'] },
			body: { next: 5000 },
		});
		expect([200, 204, 422]).toContain(set.status);
		const refused = await shop.call('POST', '/v1/orders/counter', {
			token: shop.server,
			staff: { permissions: ['ecommerce:orders.read'] },
			body: { next: 6000 },
		});
		expect(refused.status).toBe(403);
	});
});
