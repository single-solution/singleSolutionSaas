/**
 * Messages that must not be lost (K-17, owner decision D7): order messages and staff alerts are required, saved in the
 * merchant database before they are sent, and tried again on the website's next uses while Notifications does not
 * take them; a message is sent once (its outbox id is the Idempotency-Key) and given up a day after it was saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { outcomeOf } from '../server/service.js';
import { recipientOf } from '../server/staff-alerts.js';
import { ACCOUNTS, NOTIFY, ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let users = 0;
/** How the fake Notifications answers a send. @type {'ok' | 'down' | 'duplicate' | 'missing'} */
let mode = 'ok';

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/** A COD order of a new shopper (an order message and a staff alert). */
const placeOrder = async () => {
	const item = await shop.seedProduct({ price: 1000, stock: 10 });
	users += 1;
	const token = await shop.signIn({ id: `usr_outbox${String(users).padStart(6, '0')}`, name: 'Sara Shopper' });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS },
		headers: { 'x-forwarded-for': `10.6.0.${users}`, 'ss-sign-in': token, 'idempotency-key': `out-${users}` },
	});
	expect(placed.status).toBe(201);
	return placed.json.order;
};

/** The sends to Notifications since a count of calls. @param {number} since */
const sendsSince = (since) =>
	shop.calls
		.slice(since)
		.filter((call) => call.url.startsWith(`${NOTIFY}/v1/messages/`))
		.map((call) => ({ ...JSON.parse(call.body), key: call.headers['idempotency-key'] }));

/** The outbox's rows. */
const outbox = async () =>
	(await shop.db())
		.collection(COLLECTIONS.outbox)
		.find({ websiteId: shop.websiteId }, { projection: { _id: 0 } })
		.toArray();

/** A later use of the website (its work on use runs right after it). @param {number} ms */
const useAfter = async (ms) => {
	shop.advance(ms);
	await shop.visitor('GET', '/v1/shop/products');
};

beforeAll(async () => {
	shop = await readyShop();
	// orders wait for confirmation without end, so no cancel message joins in while the clock moves
	await shop.setting('checkout', 'confirmationHours', 0);
	await shop.setting('staff_alerts', 'recipients', ['team@shop.example.com', '+92 300 1234567', 'nobody']);
	await shop.setting('staff_alerts', 'events', ['placed']);
	await shop.setting('staff_alerts', 'adminUrl', 'https://admin.shop.example.com/orders/{id}');
	shop.responders.set(NOTIFY, (call) => {
		if (!call.path.startsWith('/v1/messages/')) return { status: 200, body: {} };
		if (mode === 'down') return { status: 503, body: { type: 'https://errors.example/unavailable' } };
		if (mode === 'duplicate') return { status: 409, body: { type: 'https://errors.example/duplicate_request' } };
		if (mode === 'missing') return { status: 404, body: { type: 'https://errors.example/template_not_found' } };
		return { status: 201, body: { id: 'msg_1', status: 'queued' } };
	});
});
afterAll(async () => shop.product.close());

describe('required messages (K-17)', () => {
	it('sends order messages and staff alerts as required, each with its own key, and keeps nothing once sent', async () => {
		mode = 'ok';
		const since = shop.calls.length;
		const order = await placeOrder();
		const sent = sendsSince(since);
		expect(sent.map((m) => m.template).sort()).toEqual([
			'ecommerce.order_placed',
			'ecommerce.staff_placed',
			'ecommerce.staff_placed',
		]);
		for (const message of sent) {
			expect(message.required).toBe(true);
			expect(message.key).toMatch(/^ecommerce-out_/);
		}
		expect(new Set(sent.map((m) => m.key)).size).toBe(3);
		const staff = sent.filter((m) => m.template === 'ecommerce.staff_placed');
		expect(staff.map((m) => m.to)).toEqual([{ email: 'team@shop.example.com' }, { phone: '+923001234567' }]);
		expect(staff[0].values).toMatchObject({ number: order.number, link: `https://admin.shop.example.com/orders/${order.id}` });
		expect(await outbox()).toEqual([]);
	});

	it('reads staff alert phones with the shared normaliser, leaving local numbers out (K12)', () => {
		expect(recipientOf('+92 0320 4862403')).toEqual({ key: 'p:923204862403', to: { phone: '+923204862403' } });
		expect(recipientOf('0092 300 1234567')).toEqual(recipientOf('+92 300 1234567'));
		expect(recipientOf(' Team@Shop.Example.com ')).toEqual({
			key: 'e:team@shop.example.com',
			to: { email: 'team@shop.example.com' },
		});
		expect(recipientOf('03001234567')).toBeNull();
		expect(recipientOf('nobody')).toBeNull();
		expect(recipientOf(42)).toBeNull();
	});

	it('keeps what Notifications did not take and sends it on a later use, once, with the same key', async () => {
		mode = 'down';
		const since = shop.calls.length;
		await placeOrder();
		const first = sendsSince(since);
		expect(first).toHaveLength(3);
		const kept = await outbox();
		expect(kept).toHaveLength(3);
		expect(kept.every((row) => row.tries === 1)).toBe(true);

		// still down a minute later: tried again, kept for longer
		mode = 'down';
		const again = shop.calls.length;
		await useAfter(61_000);
		expect(sendsSince(again)).toHaveLength(3);
		expect((await outbox()).every((row) => row.tries === 2)).toBe(true);
		// a use before the next try is due sends nothing
		const early = shop.calls.length;
		await useAfter(61_000);
		expect(sendsSince(early)).toHaveLength(0);

		mode = 'ok';
		const later = shop.calls.length;
		await useAfter(5 * 60_000);
		const retried = sendsSince(later);
		expect(retried.map((m) => m.key).sort()).toEqual(first.map((m) => m.key).sort());
		expect(await outbox()).toEqual([]);
		const quiet = shop.calls.length;
		await useAfter(61_000);
		expect(sendsSince(quiet)).toHaveLength(0);
	});

	it('takes a duplicate answer as sent and drops what Notifications refuses for good', async () => {
		mode = 'duplicate';
		await placeOrder();
		expect(await outbox()).toEqual([]);
		mode = 'missing';
		await placeOrder();
		expect(await outbox()).toEqual([]);
		const since = shop.calls.length;
		await useAfter(61_000);
		expect(sendsSince(since)).toHaveLength(0);
	});

	it('gives a message up a day after it was saved', async () => {
		mode = 'down';
		await placeOrder();
		expect(await outbox()).toHaveLength(3);
		for (let hour = 0; hour < 26; hour += 1) await useAfter(3_600_000);
		expect(await outbox()).toEqual([]);
		mode = 'ok';
	});

	it('alerts Accounts staff whose role grants the permission, asked once per 5 minutes', async () => {
		mode = 'ok';
		let asked = 0;
		let accountsUp = true;
		shop.responders.set(`${ACCOUNTS}/v1/users`, (call) => {
			asked += 1;
			expect(call.path).toContain('permission=ecommerce%3Aorders.read');
			return accountsUp
				? {
						status: 200,
						body: {
							items: [
								{ id: 'usr_m1', email: 'maya@shop.example.com', phone: '+923009990000' },
								{ id: 'usr_m2', email: '', phone: '+923009990001' },
								{ id: 'usr_m3', email: 'gone@shop.example.com', blocked: true },
								'nobody',
							],
						},
					}
				: { status: 503, body: {} };
		});
		await shop.setting('staff_alerts', 'staffPermission', 'orders.read');
		await shop.setting('staff_alerts', 'phoneChannel', 'sms');
		const since = shop.calls.length;
		await placeOrder();
		const staff = sendsSince(since).filter((m) => m.template === 'ecommerce.staff_placed');
		expect(staff.map((m) => [m.to, m.key.startsWith('ecommerce-out_')])).toEqual([
			[{ email: 'team@shop.example.com' }, true],
			[{ phone: '+923001234567' }, true],
			[{ email: 'maya@shop.example.com' }, true],
			[{ phone: '+923009990001' }, true],
		]);
		expect(
			shop.calls
				.slice(since)
				.filter((call) => call.url.includes('/v1/messages/sms'))
				.map((call) => JSON.parse(call.body).to),
		).toEqual([{ phone: '+923001234567' }, { phone: '+923009990001' }]);
		await placeOrder();
		expect(asked).toBe(1);
		// Accounts down after the 5 minutes: the staff it named before are still alerted
		accountsUp = false;
		shop.advance(6 * 60_000);
		const later = shop.calls.length;
		await placeOrder();
		expect(asked).toBe(2);
		expect(sendsSince(later).filter((m) => m.template === 'ecommerce.staff_placed')).toHaveLength(4);
		shop.responders.delete(`${ACCOUNTS}/v1/users`);
		await shop.setting('staff_alerts', 'staffPermission', '');
		await shop.setting('staff_alerts', 'phoneChannel', 'whatsapp');
	});

	it('tells a retry from a refusal', () => {
		expect(outcomeOf({ ok: true })).toBe('sent');
		expect(outcomeOf({ ok: false, reason: 'not_connected' })).toBe('not_connected');
		expect(outcomeOf({ ok: false, reason: 'unreachable' })).toBe('retry');
		expect(outcomeOf({ ok: false, reason: 'refused', status: 401 })).toBe('retry');
		expect(outcomeOf({ ok: false, reason: 'failed', status: 429 })).toBe('retry');
		expect(outcomeOf({ ok: false, reason: 'failed', status: 408 })).toBe('retry');
		expect(outcomeOf({ ok: false, reason: 'failed', status: 422 })).toBe('failed');
		expect(outcomeOf({ ok: false, reason: 'failed', status: 409, body: { type: 'x/conflict' } })).toBe('failed');
		expect(outcomeOf({ ok: false, reason: 'failed', status: 409, body: { type: 'x/duplicate_request' } })).toBe('sent');
	});
});
