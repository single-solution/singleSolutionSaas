/**
 * Event envelopes for the injector (`ss dev emit`): sample data for common standard events, envelope construction.
 * @module
 */
import { createId } from '@ss/contracts';

/**
 * Sample `data` for standard events (overridable with `--data`).
 * @type {Readonly<Record<string, () => Record<string, unknown>>>}
 */
export const SAMPLE_DATA = Object.freeze({
	'order.placed@1': () => ({
		orderId: createId('ord'),
		number: String(1000 + Math.floor(Math.random() * 9000)),
		customerId: 'cus_devcustomer01',
		currency: 'USD',
		lines: [
			{ itemId: 'itm_devitem000001', sku: 'SKU-1', title: 'Sample item', quantity: 1, unitAmount: 2500, totalAmount: 2500 },
		],
		amounts: { subtotal: 2500, total: 2500 },
	}),
	'order.paid@1': () => ({ orderId: createId('ord'), amount: { amount: 2500, currency: 'USD' }, method: 'card' }),
	'order.completed@1': () => ({ orderId: createId('ord') }),
	'order.cancelled@1': () => ({ orderId: createId('ord'), reason: 'customer request' }),
	'cart.updated@1': () => ({
		cartId: 'cart_devcart01',
		currency: 'USD',
		lines: [{ itemId: 'itm_devitem000001', quantity: 2, unitAmount: 2500 }],
		subtotalAmount: 5000,
	}),
	'customer.created@1': () => ({ customerId: createId('cus'), identities: [{ type: 'email', value: 'dev@example.com' }] }),
	'customer.signed_in@1': () => ({ customerId: 'cus_devcustomer01', method: 'password' }),
	'page.viewed@1': () => ({ url: 'https://shop.example.com/', path: '/', title: 'Home' }),
	'item.viewed@1': () => ({ itemId: 'itm_devitem000001', price: { amount: 2500, currency: 'USD' } }),
});

/**
 * `order.placed` → `order.placed@1`.
 * @param {string} type
 * @returns {string}
 */
export const withVersion = (type) => (type.includes('@') ? type : `${type}@1`);

/**
 * Build an envelope.
 * @param {{ type: string, websiteId: string, env: 'live' | 'test', data?: Record<string, unknown>, id?: string, now: number }} input
 * @returns {import('@ss/contracts').EventEnvelope}
 */
export const buildEnvelope = ({ type, websiteId, env, data, id, now }) => {
	const typed = withVersion(type);
	const eventId = id ?? createId('evt');
	const sample = Object.hasOwn(SAMPLE_DATA, typed) ? /** @type {() => Record<string, unknown>} */ (SAMPLE_DATA[typed])() : {};
	return /** @type {import('@ss/contracts').EventEnvelope} */ ({
		id: eventId,
		type: typed,
		websiteId,
		env,
		occurredAt: new Date(now).toISOString(),
		idempotencyKey: eventId,
		actor: { type: 'system' },
		data: data ?? sample,
		context: { source: 'portal' },
	});
};
