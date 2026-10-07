/**
 * First-product learnings (PLAN F.14): bring-your-own customer identity (the website's own login token verified by
 * app-kit replaces wallet tokens, which stay as the fallback), `custom.*` events consumed from the Event Hub, and order
 * lifecycle events that carry their own context (contracts v1, additive).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
import { hasOrderContext, orderCustomer, orderSnapshot } from '../core/orders.js';
import { createHarness, T0 } from './harness.js';

const ORIGIN = { origin: 'https://shop.example.com' };
const NOW_S = Math.floor(T0 / 1000);
const RULES = [
	{ id: 'purchase', trigger: 'order.completed@1', formula: { kind: 'percent', percent: 1 } },
	{ id: 'reviews', trigger: 'custom.review_written@1', formula: { kind: 'fixed', points: 30 } },
];

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
const issuer = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });
beforeAll(async () => {
	h = await createHarness({ config: { earn_rules: { rules: RULES } } });
});
afterAll(async () => h?.close());

const balance = async (/** @type {string} */ customerId) =>
	(await h.call('GET', `/v1/members/${customerId}/balance`)).json.balance;

describe('bring-your-own identity', () => {
	it('serves the wallet to the website’s own login token, with wallet tokens as the fallback', async () => {
		await h.call('POST', '/v1/earnings', { body: { customerId: 'cus_fed', points: 70 } });
		const login = issuer.sign({ iss: issuer.section.issuer, aud: 'shop-web', sub: 'cus_fed', iat: NOW_S, exp: NOW_S + 900 });
		// before the website registers an issuer: the login token is not a wallet token
		expect((await h.call('GET', '/v1/wallet', { key: h.pk, headers: { ...ORIGIN, 'ss-identity': login } })).status).toBe(401);

		await h.entitle({ identity: issuer.section });
		const wallet = await h.call('GET', '/v1/wallet', { key: h.pk, headers: { ...ORIGIN, 'ss-identity': login } });
		expect(wallet.status).toBe(200);
		expect(wallet.json).toMatchObject({ customerId: 'cus_fed', balance: 70 });
		const earnings = await h.call('GET', '/v1/earnings', { key: h.pk, headers: { ...ORIGIN, 'ss-identity': login } });
		expect(earnings.json.items.map((/** @type {any} */ tx) => tx.customerId)).toEqual(['cus_fed']);

		// wallet tokens keep working next to the issuer
		const issued = await h.call('POST', '/v1/wallet-tokens', { body: { customerId: 'cus_fed' } });
		const legacy = await h.call('GET', '/v1/wallet', { key: h.pk, headers: { ...ORIGIN, 'ss-identity': issued.json.token } });
		expect(legacy.json.customerId).toBe('cus_fed');

		// a forged or expired login token identifies nobody
		const forged = createTestIdentityIssuer({ alg: 'ES256' }).sign({
			iss: issuer.section.issuer,
			aud: 'shop-web',
			sub: 'cus_fed',
			iat: NOW_S,
			exp: NOW_S + 900,
		});
		expect((await h.call('GET', '/v1/wallet', { key: h.pk, headers: { ...ORIGIN, 'ss-identity': forged } })).status).toBe(401);
		const expired = issuer.sign({
			iss: issuer.section.issuer,
			aud: 'shop-web',
			sub: 'cus_fed',
			iat: NOW_S - 7200,
			exp: NOW_S - 3600,
		});
		expect((await h.call('GET', '/v1/wallet', { key: h.pk, headers: { ...ORIGIN, 'ss-identity': expired } })).status).toBe(401);
		await h.entitle();
	});
});

describe('Event Hub: custom.* and richer order events', () => {
	it('earns from custom.* deliveries exactly once per event id, for the named or acting customer', async () => {
		const first = await h.deliver('custom.review_written@1', { customerId: 'cus_custom', rating: 5 }, { id: 'evt_review_1' });
		expect(first.status).toBe(200);
		await h.deliver('custom.review_written@1', { customerId: 'cus_custom', rating: 5 }, { id: 'evt_review_1' });
		expect(await balance('cus_custom')).toBe(30);
		// the same id through the API earns nothing more
		await h.call('POST', '/v1/activities', {
			body: { id: 'evt_review_1', type: 'custom.review_written@1', customerId: 'cus_custom' },
		});
		expect(await balance('cus_custom')).toBe(30);
		await h.deliver('custom.review_written@1', { rating: 4 }, { actor: { type: 'customer', id: 'cus_actor' } });
		expect(await balance('cus_actor')).toBe(30);
		// no customer, or a custom event no rule listens to: nothing happens
		expect((await h.deliver('custom.review_written@1', { rating: 5 })).status).toBe(200);
		expect((await h.deliver('custom.newsletter_opened@1', { customerId: 'cus_custom' })).status).toBe(200);
		expect(await balance('cus_custom')).toBe(30);
	});

	it('settles a completion that carries its own order context (no order.placed@1 seen)', async () => {
		const done = await h.deliver('order.completed@1', {
			orderId: 'ord_self_contained',
			customer: { subject: 'cus_ctx' },
			currency: 'USD',
			lines: [{ itemId: 'itm_1', quantity: 1, unitAmount: 20_000 }],
			amounts: { subtotal: 20_000, total: 20_000 },
		});
		expect(done.status).toBe(200);
		expect(await balance('cus_ctx')).toBe(200);
		// a bare completion of an unknown order still waits for its placement
		await h.deliver('order.completed@1', { orderId: 'ord_unknown' });
		expect((await h.collection('orders').findOne({ orderId: 'ord_unknown' }))?.snapshot).toBeNull();
	});

	it('reads the customer of an order from customerId or the identity reference', () => {
		expect(orderCustomer({ customerId: 'a', customer: { customerId: 'b' } })).toBe('a');
		expect(orderCustomer({ customer: { customerId: 'b', subject: 'c' } })).toBe('b');
		expect(orderCustomer({ customer: { subject: 'c' } })).toBe('c');
		expect(orderCustomer({})).toBeUndefined();
		expect(hasOrderContext({ currency: 'USD', lines: [], amounts: { total: 1 } })).toBe(true);
		expect(hasOrderContext({ currency: 'USD', lines: [] })).toBe(false);
		expect(orderSnapshot({ orderId: 'o', number: '7' }, 'at')).toEqual({
			orderId: 'o',
			number: '7',
			currency: undefined,
			lines: [],
			amounts: undefined,
			placedAt: 'at',
		});
	});
});
