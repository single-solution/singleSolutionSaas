/**
 * The shopper routes (`/v1/shop/…`) called from the website's own server with the server token, for a shopper who
 * signed in through Accounts: the call carries the shopper's Accounts sign-in in `SS-Sign-In` (with `SS-Visitor-IP`),
 * the kit verifies it for the website of the token, and the call acts as that shopper only. A sign-in for another
 * website, an expired one, one signed by another key and a bare user id are all refused; staff acting is unchanged.
 */
import { createAccountsDouble } from '@ss/app-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

const IP = '203.0.113.30';
/** The problem code of an answer. @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();
/** A server-token shopper call. @param {string} method @param {string} path @param {string | null} signIn @param {unknown} [body] @param {Record<string, string>} [more] */
const asShopper = (method, path, signIn, body, more = {}) =>
	shop.api(method, path, body, { 'ss-visitor-ip': IP, ...(signIn ? { 'ss-sign-in': signIn } : {}), ...more });

describe('shopper routes called from the website’s server', () => {
	it('act as the shopper of a valid sign-in: my orders, loyalty and wishlist are theirs alone', async () => {
		const item = await shop.seedProduct({ price: 1500, stock: 5 });
		const sara = await shop.signIn({ id: 'usr_serversara001', name: 'Sara Server' });
		const omar = await shop.signIn({ id: 'usr_serveromar001', name: 'Omar Server' });
		for (const path of ['/v1/shop/orders', '/v1/shop/loyalty', '/v1/shop/wishlist']) {
			expect((await asShopper('GET', path, sara)).status).toBe(200);
		}
		expect((await asShopper('POST', `/v1/shop/wishlist/items/${item.id}`, sara, {})).status).toBeLessThan(300);
		const hers = await asShopper('GET', '/v1/shop/wishlist', sara);
		const his = await asShopper('GET', '/v1/shop/wishlist', omar);
		expect(JSON.stringify(hers.json)).toContain(item.id);
		expect(JSON.stringify(his.json)).not.toContain(item.id);
		// the same answer as the browser gets for that sign-in
		const fromBrowser = await shop.visitor('GET', '/v1/shop/wishlist', { signIn: sara });
		expect(fromBrowser.json).toEqual(hers.json);
	});

	it('refuse a missing sign-in on a route that needs the shopper', async () => {
		const missing = await asShopper('GET', '/v1/shop/orders', null);
		expect([missing.status, codeOf(missing)]).toEqual([403, 'sign_in_required']);
		// a user id alone never names the shopper
		const bare = await asShopper('GET', '/v1/shop/orders', null, undefined, {
			'ss-user-id': 'usr_serversara001',
			'ss-actor-id': 'usr_serversara001',
			'ss-actor-name': 'Sara',
		});
		expect([bare.status, codeOf(bare)]).toEqual([403, 'sign_in_required']);
	});

	it('refuse a sign-in made for another website, an expired one and one signed by another key', async () => {
		const foreign = await shop.accounts.signIn({ websiteId: 'web_another_site', sub: 'usr_serversara001' });
		const expired = await shop.accounts.signIn({ websiteId: shop.websiteId, sub: 'usr_serversara001', ttlSeconds: 1 });
		const stranger = await createAccountsDouble({ url: ACCOUNTS, now: shop.now }).signIn({
			websiteId: shop.websiteId,
			sub: 'usr_serversara001',
		});
		shop.advance(2 * 60_000);
		for (const [token, cause] of /** @type {const} */ ([
			[foreign, 'audience'],
			[expired, 'expired'],
			[stranger, 'signature'],
		])) {
			for (const [method, path, body] of /** @type {const} */ ([
				['GET', '/v1/shop/orders', undefined],
				['GET', '/v1/shop/loyalty', undefined],
				['POST', '/v1/shop/wishlist/merge', { items: [] }],
				['POST', '/v1/shop/cart/quote', { lines: [] }],
			])) {
				const refused = await asShopper(method, path, token, body);
				expect([method, path, refused.status, codeOf(refused), refused.json.cause]).toEqual([
					method,
					path,
					401,
					'invalid_sign_in',
					cause,
				]);
			}
		}
	});

	it('cannot cancel or read another shopper’s order', async () => {
		const item = await shop.seedProduct({ price: 2500, stock: 5 });
		const sara = await shop.signIn({ id: 'usr_serversara002', name: 'Sara Server' });
		const omar = await shop.signIn({ id: 'usr_serveromar002', name: 'Omar Server' });
		const placed = await asShopper(
			'POST',
			'/v1/shop/orders',
			sara,
			{
				lines: [{ productId: item.id, quantity: 1 }],
				payment: 'cod',
				address: {
					name: 'Sara',
					phone: '+15550002222',
					line1: '2 High Street',
					city: 'Springfield',
					region: 'IL',
					postalCode: '62701',
					country: 'US',
				},
			},
			{ 'idempotency-key': 'server-shopper-1' },
		);
		expect(placed.status).toBe(201);
		const id = placed.json.order.id;
		expect((await asShopper('GET', `/v1/shop/orders/${id}`, sara)).status).toBe(200);
		expect((await asShopper('GET', `/v1/shop/orders/${id}`, omar)).status).toBe(404);
		expect((await asShopper('POST', `/v1/shop/orders/${id}/cancel`, omar, {})).status).toBe(404);
		expect((await asShopper('POST', `/v1/shop/orders/${id}/cancel`, sara, {})).status).toBe(200);
	});

	it('keep the staff rules: only a verified staff sign-in names the member; actor headers mean nothing', async () => {
		const forged = await shop.call('GET', '/v1/orders', {
			token: shop.server,
			bare: true,
			headers: { 'ss-actor-id': 'usr_ali0001', 'ss-actor-name': 'Ali' },
		});
		expect([forged.status, codeOf(forged)]).toEqual([403, 'needs_signed_in_staff']);
		const staff = await shop.api('GET', '/v1/orders', undefined, { 'ss-actor-id': 'usr_ali0001', 'ss-actor-name': 'Ali' });
		expect(staff.status).toBe(200);
		// a shopper's sign-in is no staff: the staff routes refuse it, whatever else is sent
		const sara = await shop.signIn({ id: 'usr_serversara003', name: 'Sara Server' });
		const asShopper = await shop.call('GET', '/v1/orders', { token: shop.server, bare: true, headers: { 'ss-sign-in': sara } });
		expect([asShopper.status, codeOf(asShopper)]).toEqual([403, 'forbidden']);
		const junk = await shop.call('GET', '/v1/orders', { token: shop.server, bare: true, headers: { 'ss-sign-in': 'junk' } });
		expect(junk.status).toBe(401);
	});
});
