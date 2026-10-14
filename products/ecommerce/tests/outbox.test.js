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
/** How the fake Notifications answers a send. @type {'ok' | 'down' | 'duplicate' | 'running' | 'missing'} */
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
	await shop.setting('staff_alerts', 'recipients', ['team@shop.example.com', '+44 7700 900123', 'nobody']);
	await shop.setting('staff_alerts', 'events', ['placed']);
	await shop.setting('staff_alerts', 'adminUrl', 'https://admin.shop.example.com/orders/{id}');
	shop.responders.set(NOTIFY, (call) => {
		if (!call.path.startsWith('/v1/messages/')) return { status: 200, body: {} };
		if (mode === 'down') return { status: 503, body: { type: 'https://errors.example/unavailable' } };
		if (mode === 'duplicate') return { status: 409, body: { type: 'https://errors.example/duplicate_request' } };
		if (mode === 'running') return { status: 409, body: { type: 'https://errors.example/in_progress' } };
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
		expect(staff.map((m) => m.to)).toEqual([{ email: 'team@shop.example.com' }, { phone: '+447700900123' }]);
		expect(staff[0].values).toMatchObject({ number: order.number, link: `https://admin.shop.example.com/orders/${order.id}` });
		expect(await outbox()).toEqual([]);
	});

	it('reads staff alert phones with the shared normalizer, leaving local numbers out (K12)', () => {
		expect(recipientOf('+44 07700 900456')).toEqual({ key: 'p:447700900456', to: { phone: '+447700900456' } });
		expect(recipientOf('0044 7700 900123')).toEqual(recipientOf('+44 7700 900123'));
		expect(recipientOf(' Team@Shop.Example.com ')).toEqual({
			key: 'e:team@shop.example.com',
			to: { email: 'team@shop.example.com' },
		});
		expect(recipientOf('07700900123')).toBeNull();
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

	it('keeps a message whose earlier try still runs in Notifications (409 in_progress) and sends it later (K-14)', async () => {
		mode = 'running';
		const since = shop.calls.length;
		await placeOrder();
		const first = sendsSince(since);
		expect(first).toHaveLength(3);
		expect(await outbox()).toHaveLength(3);
		mode = 'ok';
		const later = shop.calls.length;
		await useAfter(61_000);
		expect(
			sendsSince(later)
				.map((m) => m.key)
				.sort(),
		).toEqual(first.map((m) => m.key).sort());
		expect(await outbox()).toEqual([]);
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
								{ id: 'usr_m1', email: 'maya@shop.example.com', phone: '+12025550198' },
								{ id: 'usr_m2', email: '', phone: '+12025550199' },
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
			[{ phone: '+447700900123' }, true],
			[{ email: 'maya@shop.example.com' }, true],
			[{ phone: '+12025550199' }, true],
		]);
		expect(
			shop.calls
				.slice(since)
				.filter((call) => call.url.includes('/v1/messages/sms'))
				.map((call) => JSON.parse(call.body).to),
		).toEqual([{ phone: '+447700900123' }, { phone: '+12025550199' }]);
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

	it('removes a person’s waiting messages and the staff alerts about their orders on a data-rights deletion (E63)', async () => {
		mode = 'down';
		await placeOrder();
		const mine = `usr_outbox${String(users).padStart(6, '0')}`;
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const other = await shop.signIn({ id: 'usr_outboxother1', name: 'Omar', email: 'omar@example.com', phone: '+15550009999' });
		const kept = await shop.call('POST', '/v1/shop/orders', {
			token: shop.browser,
			origin: ORIGIN,
			body: { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS },
			headers: { 'x-forwarded-for': '10.6.1.1', 'ss-sign-in': other, 'idempotency-key': 'out-other' },
		});
		expect(kept.status).toBe(201);
		expect(await outbox()).toHaveLength(6);
		const removed = await shop.api('POST', '/v1/data-rights/delete', { user: { id: mine } });
		expect(removed.status).toBe(200);
		const left = await outbox();
		expect(left).toHaveLength(3);
		expect(left.every((row) => row.values.number === kept.json.order.number)).toBe(true);
		expect(left.filter((row) => row.template === 'ecommerce.order_placed').map((row) => row.to)).toEqual([
			{ email: 'omar@example.com' },
		]);
		mode = 'ok';
		await useAfter(61_000);
		expect(await outbox()).toEqual([]);
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
		// an earlier try of the same message still runs in Notifications (K-14): tried again, never dropped
		expect(outcomeOf({ ok: false, reason: 'failed', status: 409, body: { type: 'x/in_progress' } })).toBe('retry');
		expect(outcomeOf({ ok: false, reason: 'failed', status: 409 })).toBe('failed');
	});
});
