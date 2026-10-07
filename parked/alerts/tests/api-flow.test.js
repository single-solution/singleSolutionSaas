/** The main flow on MongoDB: subscribe → inventory.changed@1 → exactly one message through the merchant's provider. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, PROVIDER, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeEach(async () => {
	h = await createHarness();
});
afterEach(async () => {
	await h.close();
});

describe('back in stock', () => {
	it('sends one alert when stock goes 0 → 5, even with duplicate deliveries', async () => {
		const subscribed = await h.subscribe(
			{ item: { name: 'Phone X', url: 'https://shop.example.com/p/phone-x' } },
			{ key: h.pk },
		);
		expect(subscribed.status, JSON.stringify(subscribed.json)).toBe(201);
		expect(subscribed.json).toMatchObject({
			type: 'back_in_stock',
			status: 'pending',
			contact: null,
			contactMasked: 'j•••@example.com',
			created: true,
		});
		expect(h.published('alerts.subscribed@1')).toHaveLength(1);

		const first = await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 5, previousQuantity: 0 });
		expect(first.status).toBe(200);
		// the exact same delivery again (app-kit replay), a re-signed redelivery of the same id, and a second event
		// with the same change all lead to no further message
		await h.handle(
			new Request('https://alerts.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: first.signed.headers,
				body: first.signed.body,
			}),
		);
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 5, previousQuantity: 0 }, { id: first.id });
		await h.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 6, previousQuantity: 5 });
		expect(h.provider.sent).toHaveLength(1);
		const [message] = h.provider.sent;
		expect(message).toMatchObject({ channel: 'email', to: { email: 'jane@example.com' }, lang: 'en' });
		expect(message.subject).toBe('Phone X is back in stock');
		expect(message.text).toContain('Order here: https://shop.example.com/p/phone-x');
		expect(message.text).toMatch(/Stop these alerts: https:\/\/alerts\.example\.com\/u\/us1\./);
		expect(message.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(h.provider.requests[0]?.url).toBe(`${PROVIDER}/messages`);
		expect(h.provider.requests[0]?.headers['idempotency-key']).toBe(message.id);
		expect(h.provider.requests[0]?.headers.authorization).toBe('Bearer msg_test_key');

		const sub = await h.collection('subscriptions').findOne({ websiteId: WEBSITE, id: subscribed.json.id });
		expect(sub).toMatchObject({ status: 'notified', cycle: 1 });
		expect(sub?.active).toBeUndefined();
		const messages = await h.collection('messages').find({ websiteId: WEBSITE }).toArray();
		expect(messages.map((m) => m.status)).toEqual(['sent']);
		expect(h.published('alerts.sent@1')).toHaveLength(1);
		expect(h.published('alerts.sent@1')[0].data).toMatchObject({ messageId: message.id, channel: 'email', kind: 'alert' });
		await h.alerts.product.usage.flush();
		expect([...h.portal.usage.values()].filter((/** @type {any} */ r) => r.unit === 'alert_send')).toHaveLength(1);
	});
});
