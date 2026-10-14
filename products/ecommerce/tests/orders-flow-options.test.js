/**
 * The options of the order flow's moves and statuses through the API (PLAN 0.8.10 dynamic model §3.1–3.5, phase 2):
 * who may make a move and the permission and input it needs, a paid order the shopper cancels, what shoppers read of a
 * status and the note staff write them, whether a status sends a message, staff asked whether items go back in stock,
 * a refund of an unpaid order as a cancel, the extra moves after delivery (E40), edits that keep the placed amounts, a
 * delete that gives everything back, a flow without a confirmation step, a dispatch video replaced after packing, and
 * the settings the flow replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { givePoints, loyaltyAccount } from '../adapters/ledger.js';
import { ORIGIN, readyShop } from './helpers.js';
import { orderRecords } from './order-records.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {ReturnType<typeof orderRecords>} */
let records;
/** The shopper the seeded orders belong to. */
const SHOPPER = 'usr_engine000001';

beforeAll(async () => {
	shop = await readyShop();
	records = orderRecords(shop);
});
afterAll(async () => shop.product.close());

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** The seeded orders' customer, with an e-mail address to write to. */
const CUSTOMER = { userId: SHOPPER, name: 'Eve', email: 'eve@example.com', phone: '', customerId: 'cus_engine000001' };

let visits = 0;
/**
 * A call of the seeded orders' shopper (signed in; each from its own address, visitor calls are rate limited).
 * @param {string} method @param {string} path @param {unknown} [body]
 */
const asShopper = async (method, path, body) => {
	visits += 1;
	const token = await shop.signIn({ id: SHOPPER });
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		...(body === undefined ? {} : { body }),
		headers: { 'ss-sign-in': token, 'x-forwarded-for': `10.9.${Math.floor(visits / 200)}.${visits % 200}` },
	});
};

/** Change the saved flow for one test, then put it back. @param {(flow: any) => any} change @param {() => Promise<void>} run */
const withFlow = async (change, run) => {
	const before = await shop.flow((flow) => flow);
	await shop.flow(change);
	try {
		await run();
	} finally {
		await shop.flow(() => before);
	}
};

/** The flow with one move's fields changed. @param {string} from @param {string} to @param {Record<string, unknown>} fields */
const moveWith = (from, to, fields) => (/** @type {any} */ flow) => ({
	...flow,
	moves: flow.moves.map((/** @type {any} */ move) => (move.from === from && move.to === to ? { ...move, ...fields } : move)),
});

describe('a paid order the shopper cancels', () => {
	it('is refused, cancelled with the refund due, or cancelled and refunded, as the move says', async () => {
		await withFlow(
			moveWith('confirmed', 'cancelled', { who: ['staff', 'shopper'], options: { shopperPaid: 'refuse' } }),
			async () => {
				const refused = await records.seedOrder();
				const answer = await asShopper('POST', `/v1/shop/orders/${refused.order.id}/cancel`);
				expect(codeOf(answer)).toBe('move_not_allowed');
				expect((await records.recordOf(refused.order.id)).status).toBe('confirmed');
			},
		);
		await withFlow(
			moveWith('confirmed', 'cancelled', { who: ['staff', 'shopper'], options: { shopperPaid: 'flag' } }),
			async () => {
				const flagged = await records.seedOrder();
				const answer = await asShopper('POST', `/v1/shop/orders/${flagged.order.id}/cancel`);
				expect(answer.status).toBe(200);
				expect(answer.json.order.role).toBe('cancelled');
				expect(records.refundCalls(flagged.paymentId)).toHaveLength(0);
				expect((await shop.api('GET', `/v1/orders/${flagged.order.id}`)).json.payment).toMatchObject({ refundDue: 1000 });
			},
		);
		await withFlow(
			moveWith('confirmed', 'cancelled', { who: ['staff', 'shopper'], options: { shopperPaid: 'refund' } }),
			async () => {
				const refunded = await records.seedOrder();
				const answer = await asShopper('POST', `/v1/shop/orders/${refunded.order.id}/cancel`);
				expect(answer.status).toBe(200);
				expect(records.refundCalls(refunded.paymentId)).toHaveLength(1);
				expect((await records.recordOf(refunded.order.id)).payment).toMatchObject({ refunded: 1000, state: 'refunded' });
			},
		);
	});

	it('is not the shopper’s to cancel when the move is staff’s only', async () => {
		await withFlow(moveWith('awaiting_confirmation', 'cancelled', { who: ['staff'] }), async () => {
			const { order } = await records.seedOrder({ status: 'awaiting_confirmation', role: 'awaiting_confirmation', cod: true });
			expect(codeOf(await asShopper('POST', `/v1/shop/orders/${order.id}/cancel`))).toBe('move_not_allowed');
			expect((await records.moveTo(order.id, 'cancelled')).status).toBe(200);
		});
	});
});

describe('what shoppers read', () => {
	it('the status’s name for shoppers, its line for the payment method and the note staff write them', async () => {
		await withFlow(
			(flow) => ({
				...moveWith('confirmed', 'packed', { needs: ['reason'] })(flow),
				statuses: flow.statuses.map((/** @type {any} */ status) =>
					status.key === 'packed'
						? {
								...status,
								shopperLabel: 'Getting ready',
								shopperText: { online: 'Paid: we pack it today.', cod: 'Have the cash ready.' },
								notify: true,
							}
						: status,
				),
			}),
			async () => {
				const { order } = await records.seedOrder({ patch: { customer: CUSTOMER } });
				// the move needs a note for the shopper
				expect(codeOf(await records.moveTo(order.id, 'packed', { note: 'Box 4' }))).toBe('validation_failed');
				const sent = shop.messages().length;
				const packed = await records.moveTo(order.id, 'packed', { note: 'Box 4', shopperNote: 'Gift wrapped' });
				expect(packed.status).toBe(200);
				const mine = await asShopper('GET', `/v1/shop/orders/${order.id}`);
				expect(mine.json).toMatchObject({ statusLabel: 'Getting ready', statusText: 'Paid: we pack it today.' });
				expect(mine.json.history.at(-1)).toMatchObject({ status: 'packed', label: 'Getting ready', note: 'Gift wrapped' });
				// the staff note stays internal
				expect(JSON.stringify(mine.json)).not.toContain('Box 4');
				const message = shop
					.messages()
					.slice(sent)
					.find((m) => m.template === 'ecommerce.order_status');
				expect(message?.values).toMatchObject({ status: 'Getting ready', shopperNote: 'Gift wrapped' });
			},
		);
	});

	it('a message only for statuses that send one', async () => {
		await withFlow(
			(flow) => ({
				...flow,
				statuses: flow.statuses.map((/** @type {any} */ status) =>
					status.key === 'confirmed'
						? { ...status, notify: false }
						: status.key === 'packed'
							? { ...status, notify: true }
							: status,
				),
			}),
			async () => {
				const { order } = await records.seedOrder({
					status: 'awaiting_confirmation',
					role: 'awaiting_confirmation',
					cod: true,
					patch: { customer: CUSTOMER },
				});
				const sent = shop.messages().length;
				expect((await records.moveTo(order.id, 'confirmed')).status).toBe(200);
				expect(
					shop
						.messages()
						.slice(sent)
						.filter((m) => m.template === 'ecommerce.order_status'),
				).toEqual([]);
				// packed sends one now (by default it does not)
				expect((await records.moveTo(order.id, 'packed')).status).toBe(200);
				expect(
					shop
						.messages()
						.slice(sent)
						.filter((m) => m.template === 'ecommerce.order_status')
						.map((m) => m.values.status),
				).toEqual(['Packed']);
			},
		);
	});
});

describe('what a move needs of staff', () => {
	it('a note, and the permission it names', async () => {
		await withFlow(moveWith('confirmed', 'packed', { needs: ['note'], permission: 'orders.refund' }), async () => {
			const { order } = await records.seedOrder();
			expect(codeOf(await records.moveTo(order.id, 'packed'))).toBe('validation_failed');
			const manager = await shop.ticket(['orders.read', 'orders.manage']);
			const forbidden = await shop.admin(manager, 'POST', `/v1/admin/orders/${order.id}/move`, {
				to: 'packed',
				note: 'Box 1',
			});
			expect(forbidden.status).toBe(403);
			expect((await records.moveTo(order.id, 'packed', { note: 'Box 1' })).status).toBe(200);
		});
	});

	it('whether the items go back in stock, when the move asks', async () => {
		await withFlow(moveWith('dispatched', 'returned', { options: { restock: 'ask' } }), async () => {
			const kept = await records.seedOrder({ status: 'dispatched', role: 'shipped' });
			expect(await records.stockOf(kept.product.id)).toBe(4);
			const unanswered = await records.moveTo(kept.order.id, 'returned');
			expect(unanswered.status).toBe(422);
			expect(unanswered.json.errors[0]).toMatchObject({ path: '/restock' });
			expect((await records.moveTo(kept.order.id, 'returned', { restock: false })).status).toBe(200);
			expect(await records.stockOf(kept.product.id)).toBe(4);
			expect((await records.recordOf(kept.order.id)).facts.stock).toBe('none');

			const back = await records.seedOrder({ status: 'dispatched', role: 'shipped' });
			expect((await records.moveTo(back.order.id, 'returned', { restock: true })).status).toBe(200);
			expect(await records.stockOf(back.product.id)).toBe(5);
		});
		// a move that does not ask refuses an answer
		const plain = await records.seedOrder({ status: 'dispatched', role: 'shipped' });
		expect(codeOf(await records.moveTo(plain.order.id, 'returned', { restock: false }))).toBe('validation_failed');
	});
});

describe('the extra moves (E40)', () => {
	it('a refund of an unpaid order is refused, or cancels it with no money, as the move says', async () => {
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'confirmed', to: 'refunded' }] }),
			async () => {
				const unpaid = await records.seedOrder({ cod: true });
				expect(codeOf(await records.moveTo(unpaid.order.id, 'refunded'))).toBe('nothing_paid');
			},
		);
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'confirmed', to: 'refunded', options: { unpaid: 'cancel' } }] }),
			async () => {
				const unpaid = await records.seedOrder({ cod: true });
				const refunded = await records.moveTo(unpaid.order.id, 'refunded');
				expect(refunded.status).toBe(200);
				expect(refunded.json).toMatchObject({ status: 'refunded', payment: { refunded: 0 } });
				expect(await records.stockOf(unpaid.product.id)).toBe(5);
			},
		);
	});

	it('a cancel after delivery: items back as the move says, earned points taken back or kept', async () => {
		/** @param {any} owner */
		const balanceOf = async (owner) => (await loyaltyAccount(await shop.db(), owner, { now: shop.now() })).balance;
		/** A delivered order that earned 20 points (credited). */
		const delivered = async () => {
			const seeded = await records.seedOrder({
				status: 'delivered',
				role: 'delivered',
				patch: {
					promotions: {
						couponId: null,
						couponCode: '',
						dealIds: [],
						bundleIds: [],
						pointsRedeemed: 0,
						pointsValue: 0,
						pointsEarned: 20,
						pointsFixed: true,
						pointsCredited: true,
						released: false,
					},
					facts: { stock: 'sold', offers: 'counted', redeemed: 'spent', earned: 'credited', units: 'none' },
					deliveredAt: new Date(shop.now()),
				},
			});
			await givePoints(
				await shop.db(),
				{ userId: SHOPPER, points: 20, orderId: seeded.order.id, kind: 'earn', expiresAt: null },
				{ now: shop.now() },
			);
			return seeded;
		};
		// by default: the items stay with the customer, the earned points are taken back
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'delivered', to: 'cancelled', options: { refund: 'staff' } }] }),
			async () => {
				const { order, product } = await delivered();
				const before = await balanceOf(SHOPPER);
				expect((await records.moveTo(order.id, 'cancelled')).status).toBe(200);
				expect(await records.stockOf(product.id)).toBe(4);
				expect(await balanceOf(SHOPPER)).toBe(before - 20);
				expect((await records.recordOf(order.id)).facts).toMatchObject({
					stock: 'sold',
					offers: 'released',
					earned: 'reversed',
				});
			},
		);
		// the items back in stock, the points kept
		await withFlow(
			(flow) => ({
				...flow,
				moves: [
					...flow.moves,
					{ from: 'delivered', to: 'cancelled', options: { refund: 'staff', restock: 'yes', points: 'keep' } },
				],
			}),
			async () => {
				const { order, product } = await delivered();
				const before = await balanceOf(SHOPPER);
				expect((await records.moveTo(order.id, 'cancelled')).status).toBe(200);
				expect(await records.stockOf(product.id)).toBe(5);
				expect(await balanceOf(SHOPPER)).toBe(before);
				expect((await records.recordOf(order.id)).facts).toMatchObject({ stock: 'back', earned: 'credited' });
			},
		);
	});
});

describe('checkout options of the flow', () => {
	it('an edit of a waiting order keeps the amounts it was placed with, or prices it again', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const variantId = /** @type {any} */ (item.variants[0]).id;
		await shop.setting('cod', 'feePercent', 5);
		/** @param {string} key */
		const place = async (key) => {
			visits += 1;
			const token = await shop.signIn({ id: SHOPPER });
			const placed = await shop.call('POST', '/v1/shop/orders', {
				token: shop.browser,
				origin: ORIGIN,
				body: {
					lines: [{ productId: item.id }],
					payment: 'cod',
					address: { name: 'Eve', phone: '+15550001111', line1: '1 Main St', city: 'Springfield', country: 'US' },
				},
				headers: { 'ss-sign-in': token, 'idempotency-key': key, 'x-forwarded-for': `10.10.0.${visits % 200}` },
			});
			expect(placed.status).toBe(201);
			return /** @type {string} */ (placed.json.order.id);
		};
		try {
			const repriced = await place('keep-1');
			const kept = await place('keep-2');
			const fee = (await records.recordOf(kept)).totals.fee;
			expect(fee).toBe(50);
			// the fee is no more; one edit prices again, the other keeps what was placed
			await shop.setting('cod', 'feePercent', 0);
			const again = await shop.api('PATCH', `/v1/orders/${repriced}`, { lines: [{ variantId, quantity: 2 }] });
			expect(again.json.totals).toMatchObject({ subtotal: 2000, fee: 0 });
			await shop.setting('checkout', 'editPricing', 'keep_placed');
			const same = await shop.api('PATCH', `/v1/orders/${kept}`, { lines: [{ variantId, quantity: 2 }] });
			expect(same.json.totals).toMatchObject({ subtotal: 2000, fee: 50 });
		} finally {
			await shop.setting('checkout', 'editPricing', 'reprice');
			await shop.setting('cod', 'feePercent', 0);
		}
	});

	it('a delete gives back what a delivered order holds only when the website says so', async () => {
		const held = await records.seedOrder({
			status: 'delivered',
			role: 'delivered',
			patch: { deliveredAt: new Date(shop.now()) },
		});
		expect((await shop.api('DELETE', `/v1/orders/${held.order.id}`)).status).toBe(204);
		expect(await records.stockOf(held.product.id)).toBe(4);
		await shop.setting('checkout', 'deleteGivesBack', 'all');
		try {
			const all = await records.seedOrder({
				status: 'delivered',
				role: 'delivered',
				patch: { deliveredAt: new Date(shop.now()) },
			});
			expect((await shop.api('DELETE', `/v1/orders/${all.order.id}`)).status).toBe(204);
			expect(await records.stockOf(all.product.id)).toBe(5);
		} finally {
			await shop.setting('checkout', 'deleteGivesBack', 'held');
		}
	});

	it('a flow without a confirmation step starts cash-on-delivery orders open', async () => {
		// a status with orders cannot go (the flow-save guard): the orders waiting in it are cancelled first
		const waiting = await shop.api('GET', '/v1/orders?status=awaiting_confirmation&limit=100');
		for (const order of waiting.json.items) expect((await records.moveTo(order.id, 'cancelled')).status).toBe(200);
		await withFlow(
			(flow) => ({
				...flow,
				statuses: flow.statuses.filter((/** @type {any} */ status) => status.key !== 'awaiting_confirmation'),
				moves: flow.moves.filter(
					(/** @type {any} */ move) => move.from !== 'awaiting_confirmation' && move.to !== 'awaiting_confirmation',
				),
				starts: {},
			}),
			async () => {
				const item = await shop.seedProduct({ price: 1000, stock: 3 });
				visits += 1;
				const placed = await shop.call('POST', '/v1/shop/orders', {
					token: shop.browser,
					origin: ORIGIN,
					body: {
						lines: [{ productId: item.id }],
						payment: 'cod',
						address: { name: 'Eve', phone: '+15550001111', line1: '1 Main St', city: 'Springfield', country: 'US' },
					},
					headers: {
						'ss-sign-in': await shop.signIn({ id: SHOPPER }),
						'idempotency-key': 'no-confirm-1',
						'x-forwarded-for': `10.11.0.${visits % 200}`,
					},
				});
				expect(placed.status).toBe(201);
				expect(await records.recordOf(placed.json.order.id)).toMatchObject({ status: 'confirmed', role: 'open' });
			},
		);
	});

	it('replaces the dispatch video after packing', async () => {
		const { order } = await records.seedOrder({
			status: 'packed',
			role: 'packed',
			patch: { media: [{ kind: 'dispatch_video', url: 'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa' }] },
		});
		const replaced = await shop.api('PATCH', `/v1/orders/${order.id}`, { video: 'https://youtu.be/dQw4w9WgXcQ' });
		expect(replaced.status).toBe(200);
		const record = await records.recordOf(order.id);
		expect(record.media).toEqual([{ kind: 'dispatch_video', url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' }]);
		expect(record.history.at(-1)).toMatchObject({ code: 'video_replaced', kind: 'video' });
		// not before packing: it comes with the move into packed
		const open = await records.seedOrder();
		expect(codeOf(await shop.api('PATCH', `/v1/orders/${open.order.id}`, { video: 'https://youtu.be/dQw4w9WgXcQ' }))).toBe(
			'validation_failed',
		);
	});

	it('the settings the flow replaced are gone', async () => {
		const cookie = await shop.adminSession();
		for (const key of [
			'checkout.returnRestock',
			'checkout.shopperCancel',
			'checkout.paidOnConfirm',
			'checkout.rewaitWindow',
			'checkout.trackingRequired',
			'checkout.packingVideo',
			'checkout.autoRefundedStatus',
			'checkout.notifyStatuses',
			'checkout.freeOrderStart',
			'cod.startStatus',
		]) {
			const answer = await shop.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${shop.websiteId}/settings/${key}`, {
				value: 'yes',
			});
			expect([404, 422]).toContain(answer.status);
		}
	});
});
