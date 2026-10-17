/**
 * Ecommerce's messages and their default templates (parity P1): every message Ecommerce sends through Notifications is
 * declared in `schemas/messages.json` with US-English default words and every send carries them; a per-status order
 * message names the general one as its fallback template, so it gets the website's general template, else its
 * defaults; staff alerts take `all_staff` (every unblocked Accounts user whose role has the alert's own permission) and
 * `includePhone`.
 */
import { validateMessageDefaults } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import declaration from '../schemas/messages.json' with { type: 'json' };
import guide from '../docs/guide.json' with { type: 'json' };
import { STOCK_ALERT_VALUES } from '../server/extras-alerts.js';
import { RETURN_MESSAGE_VALUES } from '../server/extras-returns.js';
import { STAFF_ALERT_MAX_RECIPIENTS } from '../core/limits.js';
import { COLLECTIONS } from '../core/model.js';
import { ORDER_MESSAGE_VALUES, ORDER_TEMPLATES } from '../server/order-messages.js';
import { BUSINESS_VALUE } from '../server/service.js';
import {
	ALL_STAFF_PERMISSIONS,
	STAFF_ALERT_EVENTS,
	STAFF_ALERT_LINK,
	STAFF_ALERT_PHONE,
	STAFF_ALERT_VALUES,
} from '../server/staff-alerts.js';
import { ORIGIN, readyShop } from './helpers.js';

/**
 * The defaults the kit attaches to a send of a message: each channel with words, with the message's flags.
 * @param {string} key
 */
const defaultsOf = (key) => {
	const message = /** @type {any} */ (declaration.messages.find((each) => each.key === key));
	return Object.fromEntries(
		Object.entries(message.channels)
			.filter(([, words]) => words !== null)
			.map(([channel, words]) => [
				channel,
				{
					.../** @type {object} */ (words),
					required: message.required === true,
					urgent: message.urgent === true,
					sensitive: message.sensitive === true,
				},
			]),
	);
};

describe('Ecommerce’s messages and their defaults (parity P1)', () => {
	it('declares every message it sends, with exactly the values the code fills, as the contract wants', () => {
		expect(validateMessageDefaults({ productId: 'ecommerce', ...declaration })).toMatchObject({ ok: true });
		/** @type {Record<string, string[]>} */
		const expected = {
			[ORDER_TEMPLATES.placed]: [...ORDER_MESSAGE_VALUES, BUSINESS_VALUE],
			[ORDER_TEMPLATES.status]: [...ORDER_MESSAGE_VALUES, BUSINESS_VALUE],
			'ecommerce.return_status': [...RETURN_MESSAGE_VALUES, BUSINESS_VALUE],
			'ecommerce.back_in_stock': [...STOCK_ALERT_VALUES, BUSINESS_VALUE],
			'ecommerce.price_drop': [...STOCK_ALERT_VALUES, BUSINESS_VALUE],
			...Object.fromEntries(
				Object.entries(STAFF_ALERT_EVENTS).map(([event, own]) => [
					`ecommerce.staff_${event}`,
					[...STAFF_ALERT_VALUES, ...own, STAFF_ALERT_LINK, STAFF_ALERT_PHONE],
				]),
			),
		};
		expect(Object.fromEntries(declaration.messages.map((message) => [message.key, message.values]))).toEqual(expected);
		// the claim and stock alert values are the ones the docs list
		for (const [key, values] of Object.entries(/** @type {Record<string, string[]>} */ (guide.templates)))
			expect([...values, BUSINESS_VALUE], key).toEqual(expected[key]);
		// every message goes by email and SMS with default words; WhatsApp is named without any (Meta-approved only)
		for (const message of declaration.messages) {
			expect(Object.keys(message.channels), message.key).toEqual(['email', 'sms', 'whatsapp']);
			expect(message.channels.whatsapp, message.key).toBeNull();
		}
		// order, claim and staff messages are required; the shopper's stock alerts are optional
		expect(declaration.messages.filter((message) => message.required !== true).map((message) => message.key)).toEqual([
			'ecommerce.back_in_stock',
			'ecommerce.price_drop',
		]);
		// the general status message reads as the plan says
		const status = /** @type {any} */ (declaration.messages.find((message) => message.key === ORDER_TEMPLATES.status));
		expect(status.channels.email.subject).toBe('Your order {number} is now {status}');
		expect(status.channels.sms.text).toMatch(/^Your order \{number\} with \{business\} is now \{status\}\./);
	});

	describe('through the API', () => {
		/** @type {Awaited<ReturnType<typeof readyShop>>} */
		let shop;
		let shoppers = 0;
		const ADDRESS = {
			name: 'Sam Lee',
			phone: '+15550001111',
			line1: '1 Main Street',
			city: 'Springfield',
			region: 'IL',
			postalCode: '62701',
			country: 'US',
		};

		/** A COD order of a new shopper. */
		const placeOrder = async () => {
			const item = await shop.seedProduct({ price: 1000, stock: 10 });
			shoppers += 1;
			const token = await shop.signIn({ id: `usr_messages${String(shoppers).padStart(4, '0')}`, name: 'Sam Lee' });
			const placed = await shop.call('POST', '/v1/shop/orders', {
				token: shop.browser,
				origin: ORIGIN,
				body: { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS },
				headers: { 'x-forwarded-for': `10.9.0.${shoppers}`, 'ss-sign-in': token, 'idempotency-key': `msg-${shoppers}` },
			});
			expect(placed.status, JSON.stringify(placed.json)).toBe(201);
			await shop.flush();
			return { order: placed.json.order, token };
		};
		/** @param {string} id @param {string} to */
		const move = async (id, to) => {
			expect((await shop.api('POST', `/v1/orders/${id}/move`, { to })).status).toBe(200);
			await shop.flush();
		};

		beforeAll(async () => {
			shop = await readyShop();
			await shop.setting('staff_alerts', 'recipients', ['team@shop.example.com']);
			await shop.setting('staff_alerts', 'events', ['placed', 'return_requested']);
		});
		afterAll(async () => shop.product.close());

		it('serves the declaration publicly', async () => {
			const answer = await shop.call('GET', '/v1/message-defaults');
			expect(answer.status).toBe(200);
			expect(answer.json).toEqual({ productId: 'ecommerce', ...declaration });
		});

		it('every order message carries its defaults; a per-status one names the general message as its fallback', async () => {
			const since = shop.messages().length;
			const { order } = await placeOrder();
			await move(order.id, 'confirmed');
			await shop.setting('checkout', 'statusTemplates', 'per_status');
			await move(order.id, 'delivered');
			await shop.setting('checkout', 'statusTemplates', 'one');
			const sent = shop.messages().slice(since);
			const placed = sent.find((message) => message.template === ORDER_TEMPLATES.placed);
			expect(placed).toMatchObject({ channel: 'email', required: true, defaults: defaultsOf(ORDER_TEMPLATES.placed) });
			expect(placed).not.toHaveProperty('fallbackTemplate');
			const confirmed = sent.find((message) => message.template === ORDER_TEMPLATES.status);
			expect(confirmed).toMatchObject({ values: { status: 'Confirmed' }, defaults: defaultsOf(ORDER_TEMPLATES.status) });
			expect(confirmed).not.toHaveProperty('fallbackTemplate');
			const delivered = sent.find((message) => message.template === `${ORDER_TEMPLATES.status}.delivered`);
			expect(delivered).toMatchObject({
				fallbackTemplate: ORDER_TEMPLATES.status,
				required: true,
				defaults: defaultsOf(ORDER_TEMPLATES.status),
			});
			// the staff alert carries its own
			expect(sent.find((message) => message.template === 'ecommerce.staff_placed')).toMatchObject({
				defaults: defaultsOf('ecommerce.staff_placed'),
			});
		});

		it('all_staff alerts every unblocked Accounts user whose role has the alert’s own permission; includePhone adds the phone', async () => {
			shop.accounts.setUsers([
				{ id: 'usr_orders1', email: 'orders@shop.example.com', permissions: ['ecommerce:orders.read'] },
				{ id: 'usr_claims1', email: 'claims@shop.example.com', permissions: ['ecommerce:returns.manage'] },
				{ id: 'usr_owner01', email: 'owner@shop.example.com', permissions: ['*'] },
				{ id: 'usr_blocked', email: 'blocked@shop.example.com', blocked: true, permissions: ['ecommerce:orders.read'] },
				{ id: 'usr_other01', email: 'chat@shop.example.com', permissions: ['chat:inbox.read'] },
			]);
			await shop.setting('staff_alerts', 'staffPermission', 'all_staff');
			await shop.setting('staff_alerts', 'includePhone', true);
			const since = shop.messages().length;
			const reads = shop.accounts.userReads.length;
			const { order, token } = await placeOrder();
			const alerts = () => shop.messages().slice(since);
			expect(
				alerts()
					.filter((message) => message.template === 'ecommerce.staff_placed')
					.map((m) => m.to),
			).toEqual([
				{ email: 'team@shop.example.com' },
				{ email: 'orders@shop.example.com' },
				{ email: 'owner@shop.example.com' },
			]);
			expect(alerts().find((message) => message.template === 'ecommerce.staff_placed')?.values).toMatchObject({
				number: order.number,
				[STAFF_ALERT_PHONE]: ADDRESS.phone,
			});
			// a claim alerts the ones who handle claims
			await move(order.id, 'confirmed');
			await move(order.id, 'delivered');
			const claim = await shop.call('POST', '/v1/shop/returns', {
				token: shop.browser,
				origin: ORIGIN,
				body: {
					orderId: order.id,
					kind: 'return',
					lines: [{ lineId: order.lines[0].id, quantity: 1 }],
					reason: 'Wrong size',
				},
				headers: { 'x-forwarded-for': '10.9.1.1', 'ss-sign-in': token, 'idempotency-key': 'msg-claim' },
			});
			expect(claim.status, JSON.stringify(claim.json)).toBe(201);
			await shop.flush();
			expect(
				alerts()
					.filter((message) => message.template === 'ecommerce.staff_return_requested')
					.map((m) => m.to),
			).toEqual([
				{ email: 'team@shop.example.com' },
				{ email: 'claims@shop.example.com' },
				{ email: 'owner@shop.example.com' },
			]);
			expect(shop.accounts.userReads.slice(reads)).toEqual([
				`ecommerce:${ALL_STAFF_PERMISSIONS.placed}`,
				`ecommerce:${ALL_STAFF_PERMISSIONS.return_requested}`,
			]);
			// without includePhone, no phone
			await shop.setting('staff_alerts', 'includePhone', false);
			const later = shop.messages().length;
			await placeOrder();
			const plain = shop
				.messages()
				.slice(later)
				.find((message) => message.template === 'ecommerce.staff_placed');
			expect(plain?.values).not.toHaveProperty(STAFF_ALERT_PHONE);
			await shop.setting('staff_alerts', 'staffPermission', '');
		});

		it('names a channel for one recipient and sends a staff push to Accounts staff, saved in the outbox like every alert (K8)', async () => {
			shop.accounts.setUsers([
				{ id: 'usr_orders1', email: 'orders@shop.example.com', permissions: ['ecommerce:orders.manage'] },
			]);
			await shop.setting('staff_alerts', 'recipients', [
				'email:team@shop.example.com',
				'whatsapp:+44 7700 900123',
				'push:usr_ops00001',
			]);
			await shop.setting('staff_alerts', 'staffPermission', 'orders.manage');
			await shop.setting('staff_alerts', 'staffPush', true);
			const since = shop.messages().length;
			await placeOrder();
			const alerts = shop
				.messages()
				.slice(since)
				.filter((message) => message.template === 'ecommerce.staff_placed');
			expect(alerts.map((m) => [m.channel, m.to])).toEqual([
				['email', { email: 'team@shop.example.com' }],
				['whatsapp', { phone: '+447700900123' }],
				['staff-push', { staffId: 'usr_ops00001' }],
				['email', { email: 'orders@shop.example.com' }],
				['staff-push', { staffId: 'usr_orders1' }],
			]);
			// every alert was saved before it was sent, and removed once Notifications took it
			const stuck = await (
				await shop.db()
			)
				.collection(COLLECTIONS.outbox)
				.find({ websiteId: shop.websiteId, template: 'ecommerce.staff_placed' })
				.toArray();
			expect(stuck).toEqual([]);
			// the limit is fixed (STAFF_ALERT_MAX_RECIPIENTS people): the list first
			await shop.setting(
				'staff_alerts',
				'recipients',
				Array.from({ length: STAFF_ALERT_MAX_RECIPIENTS + 5 }, (_, index) => `person${index}@shop.example.com`),
			);
			const limited = shop.messages().length;
			await placeOrder();
			expect(
				shop
					.messages()
					.slice(limited)
					.filter((message) => message.template === 'ecommerce.staff_placed'),
			).toHaveLength(STAFF_ALERT_MAX_RECIPIENTS);
			await shop.setting('staff_alerts', 'staffPush', false);
			await shop.setting('staff_alerts', 'staffPermission', '');
			await shop.setting('staff_alerts', 'recipients', ['team@shop.example.com']);
		});
	});
});
