/**
 * The order engine's property test on the database (PLAN 0.8.10 dynamic model §3, phase 1): random flows the role rules
 * allow, saved through the flow editor's route, × random sequences of every way an order changes — staff moves (and
 * their retries with the order as read), the shopper's cancel, the end of a waiting window, Payments' confirmation,
 * refunds by staff, recorded payments (with confirm), deletes — two of them at once on one order, and Payments failing
 * (a cancel's refund done but its answer lost, other refunds not done). Afterwards stock = initial + given back − held
 * or sold, paid = Σ payments, refunded = Σ refunds ≤ paid (and what Payments refunded = what the orders record of it),
 * points = Σ lots = what was earned less what was spent, offer uses and RTOs counted once, and one history entry and
 * one activity line per transition. A failure names its seed. Its own shop, so the flows start from orders of its own.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { givePoints, loyaltyAccount, placeOrder } from '../adapters/ledger.js';
import { PLACED_FACTS, factsOf } from '../core/facts.js';
import { moveOf, nextStatuses } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { checkPayment, checkRefund, refundable } from '../core/orders.js';
import { balanceOf } from '../core/points.js';
import { createMoves } from '../server/orders-moves.js';
import { createService } from '../server/service.js';
import { DOMAIN, ORIGIN, PAYMENTS, readyShop, storedOrder } from './helpers.js';
import { randomFlow, randomOf } from './transitions-helpers.js';

/** The keys of today's payment methods (the ways staff record money by, with `other`). */
const KEYS = ['online', 'bank_transfer', 'cod', 'pickup'];

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {ReturnType<typeof createService>} */
let service;
/** @type {ReturnType<typeof createMoves>} */
let moves;

beforeAll(async () => {
	shop = await readyShop();
	service = createService(shop.product);
	moves = createMoves(shop.product, service);
});
afterAll(async () => shop.product.close());

/** A server-token request context, as the routes give the moves module. */
const ctx = () => ({
	websiteId: shop.websiteId,
	merchantId: null,
	status: { domain: DOMAIN },
	headers: new Headers(),
	ticket: null,
	after: () => {},
});

const orders = async () => (await shop.db()).collection(COLLECTIONS.orders);
/** @param {string} id @returns {Promise<any>} */
const recordOf = async (id) => (await orders()).findOne({ websiteId: shop.websiteId, id }, { projection: { _id: 0 } });
/** @param {string} id */
const stockOf = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id }))
		.variants[0].stock;
/** The activity entries of a target, newest first. @param {string} target */
const activityOf = async (target) =>
	(await shop.api('GET', `/v1/activity?target=${encodeURIComponent(target)}&limit=100`)).json.items;

/** Roles before delivery: a delete gives back what such an order holds. */
const BEFORE_DELIVERY = ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed', 'shipped'];

describe('property: random flows × every way an order moves, retries, two at once and Payments failing', () => {
	it('keeps stock, money, offer uses and points adding up, each given back or taken at most once', async () => {
		const SEED = 141026;
		const FLOWS = 40;
		const ORDERS = 5;
		const STEPS = 12;
		const random = randomOf(SEED);
		const data = await shop.db();
		const user = 'usr_property0001';
		const customerId = 'cus_property0001';
		await data
			.collection(COLLECTIONS.customers)
			.insertOne({ id: customerId, userId: user, guest: false, rtoCount: 0, orderCount: 0 });
		await shop.setting('loyalty', 'earnPercent', 10);
		await givePoints(
			data,
			{ userId: user, points: 100_000, orderId: null, kind: 'adjust', expiresAt: null },
			{ now: shop.now() },
		);
		const couponId = createId('cpn');
		await data.collection(COLLECTIONS.coupons).insertOne({ id: couponId, code: 'PROP', active: true, limit: null, used: 0 });
		const products = [];
		for (let n = 0; n < 3; n += 1) products.push(await shop.seedProduct({ price: 1000, stock: 1000 }));

		// Payments as strict as the real one: a refund is at most what is left of the payment, a repeated Idempotency-Key
		// gets the first answer; while `failing`, refunds fail (a cancel's refund is done but its answer is lost)
		const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
		/** @type {Map<string, { amount: number, refunded: number, refunds: Array<{ id: string, amount: number, manual: boolean }> }>} */
		const taken = new Map();
		/** @type {Map<string, any>} Idempotency-Key → first answer */
		const answered = new Map();
		let failing = false;
		/** @type {Map<string, number>} payment id → its order's total (what the shared double does not know) */
		const amounts = new Map();
		shop.responders.set(PAYMENTS, (call) => {
			const path = call.path.split('?')[0] ?? '';
			const read = /^\/v1\/payments\/([^/]+)$/.exec(path);
			if (read && call.method === 'GET') {
				// a payment as Payments has it, with what it refunded
				if (failing) return { status: 503, body: {} };
				const answer = normal(call);
				const payment = taken.get(String(read[1]));
				return {
					...answer,
					body: {
						...answer.body,
						amount: amounts.get(String(read[1])) ?? answer.body.amount,
						...(payment ? { refunded: payment.refunded, refunds: payment.refunds, gateway: 'card' } : {}),
					},
				};
			}
			const refund = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(path);
			if (!refund) {
				// the amount of a payment the cancel answers paid (409 already_paid)
				const answer = normal(call);
				const cancel = /^\/v1\/payments\/([^/]+)\/cancel$/.exec(path);
				return cancel && answer.body?.payment
					? {
							...answer,
							body: {
								...answer.body,
								payment: { ...answer.body.payment, amount: amounts.get(String(cancel[1])) ?? 0 },
							},
						}
					: answer;
			}
			const key = String(call.headers['idempotency-key'] ?? '');
			if (answered.has(key)) return answered.get(key);
			if (failing && !key.endsWith(':cancel')) return { status: 503, body: {} };
			const payment = taken.get(String(refund[1]));
			const { amount } = JSON.parse(call.body);
			if (!payment || payment.refunded + amount > payment.amount)
				return { status: 422, type: 'application/problem+json', body: { status: 422, detail: 'At most what is left.' } };
			payment.refunded += amount;
			payment.refunds.push({ id: `rfd_${answered.size + 1}`, amount, manual: false });
			const answer = {
				status: 201,
				body: {
					id: refund[1],
					status: payment.refunded >= payment.amount ? 'refunded' : 'partially_refunded',
					refunds: [...payment.refunds],
				},
			};
			answered.set(key, answer);
			return failing ? { status: 503, body: {} } : answer;
		});

		/** @type {Set<string>} */
		const live = new Set();
		/** What deleted orders held when they went (their stock, sold units, offer uses, points and RTOs). @type {any[]} */
		const gone = [];
		const counts = {
			attempts: 0,
			made: 0,
			concurrent: 0,
			refundPairs: 0,
			retries: 0,
			shopper: 0,
			paid: 0,
			refunds: 0,
			recorded: 0,
			deleted: 0,
			failing: 0,
			expired: 0,
		};
		let ip = 0;

		/** @param {unknown} error @param {string[]} codes */
		const expectCode = (error, codes) => {
			const failed = /** @type {any} */ (error);
			expect(codes, `${failed?.code}: ${failed?.detail ?? failed?.message} (seed ${SEED})`).toContain(failed?.code);
		};

		try {
			for (let f = 0; f < FLOWS; f += 1) {
				// every flow keeps the same statuses (two per kind), so it saves over the last while orders are in any of them
				const flow = randomFlow(random, { full: true });
				expect((await shop.list('order_flow', flow)).moves).toEqual(flow.moves);
				for (let o = 0; o < ORDERS; o += 1) {
					const waiting = random() < 0.5 ? 'awaiting_payment' : 'awaiting_confirmation';
					const start = /** @type {any} */ (flow.statuses.find((status) => status.role === waiting));
					const lines = products
						.filter(() => random() < 0.6)
						.slice(0, 2)
						.map((product) => ({ product, quantity: 1 + Math.floor(random() * 3) }));
					if (lines.length === 0) lines.push({ product: /** @type {any} */ (products[0]), quantity: 1 });
					const total = lines.reduce((sum, line) => sum + 1000 * line.quantity, 0);
					const kind = random();
					// paid online, waiting for its online payment (awaiting payment only), or cash on delivery
					const how = kind < 0.45 ? 'paid' : kind < 0.7 && waiting === 'awaiting_payment' ? 'pending' : 'cod';
					const id = createId('ord');
					const paymentId = `pay_${id.slice(4, 16)}`;
					const holdUntil = random() < 0.6 ? new Date(shop.now() + (1 + Math.floor(random() * 6)) * 20_000) : null;
					if (how === 'paid') taken.set(paymentId, { amount: total, refunded: 0, refunds: [] });
					if (how !== 'cod') amounts.set(paymentId, total);
					const result = await placeOrder(
						data,
						{
							numberPrefix: 'P-',
							order: /** @type {any} */ (
								storedOrder({
									id,
									customer: { userId: user, name: 'Pat', email: '', phone: '', customerId },
									address: null,
									delivery: { method: 'none', zone: '', rate: '', rateName: '', fee: 0, locationId: null },
									lines: lines.map(({ product, quantity }) => ({
										id: createId('oln'),
										productId: product.id,
										variantId: /** @type {any} */ (product.variants[0]).id,
										kind: 'physical',
										name: 'Item',
										variantName: '',
										sku: '',
										grade: null,
										gradeLabel: '',
										image: null,
										unitPrice: 1000,
										quantity,
										discount: 0,
										tax: 0,
										total: 1000 * quantity,
										cost: null,
										categoryIds: [],
										brandId: null,
										locationId: null,
										serials: [],
										booking: null,
										licences: [],
										returnedQuantity: 0,
									})),
									totals: {
										subtotal: total,
										discount: 0,
										delivery: 0,
										tax: 0,
										total,
										currency: 'USD',
										taxIncluded: true,
									},
									promotions: {
										couponId: random() < 0.5 ? couponId : null,
										couponCode: '',
										dealIds: [],
										bundleIds: [],
										pointsRedeemed: random() < 0.5 ? 100 : 0,
										pointsValue: 0,
										pointsEarned: 0,
										pointsFixed: false,
										pointsCredited: false,
										released: false,
									},
									payment:
										how === 'paid'
											? {
													method: 'online',
													kind: 'gateway',
													state: 'paid',
													paymentId,
													advance: 0,
													paid: total,
													refunded: 0,
													checkedAt: null,
												}
											: how === 'pending'
												? {
														method: 'online',
														kind: 'gateway',
														state: 'pending',
														paymentId,
														advance: 0,
														paid: 0,
														refunded: 0,
														checkedAt: null,
													}
												: {
														method: 'cod',
														kind: 'on_delivery',
														state: 'unpaid',
														paymentId: null,
														advance: 0,
														paid: 0,
														refunded: 0,
														checkedAt: null,
													},
									payments:
										how === 'paid'
											? [
													{
														id: createId('opy'),
														method: 'payments',
														amount: total,
														reference: paymentId,
														proofKey: null,
														note: '',
														by: { kind: 'system', id: 'payments', name: 'Payments' },
														at: new Date(shop.now()),
													},
												]
											: [],
									refunds: [],
									status: start.key,
									role: start.role,
									history: [{ at: new Date(shop.now()), from: null, to: start.key, by: 'shopper', note: '' }],
									shipment: null,
									media: [],
									stockHeld: true,
									facts: { ...PLACED_FACTS },
									holdUntil,
									idempotencyKey: createId('key'),
									note: '',
									staffNote: '',
									placedAt: new Date(shop.now()),
									deliveredAt: null,
								})
							),
						},
						{ now: shop.now() },
					);
					if (!result.ok) throw new Error(`not placed: ${result.code}`);
					live.add(id);

					for (let step = 0; step < STEPS && live.has(id); step += 1) {
						// time goes on: windows end and pending refunds become due again
						shop.advance(20_000);
						failing = random() < 0.15;
						if (failing) counts.failing += 1;
						const read = await recordOf(id);
						const next = nextStatuses(flow, read.status);
						const onward = next.filter((status) => status.role !== 'cancelled' && status.role !== 'refunded');
						/** Every random choice of an action is made before it runs, so a seed replays. */
						const choose = () => {
							const pick = random();
							const pool =
								next.length === 0 || random() < 0.2
									? flow.statuses
									: onward.length > 0 && random() < 0.75
										? onward
										: next;
							const to = /** @type {any} */ (pool[Math.floor(random() * pool.length)]).key;
							const share = random();
							const cash = random() < 0.5;
							const confirm = random() < 0.5;
							const reason = random() < 0.5 ? 'rto' : 'customer_return';
							const restock = random() < 0.5;
							// a waiting order is more often paid, canceled by the shopper or left until its window ends
							const waits = read.role === 'awaiting_payment' || read.role === 'awaiting_confirmation';
							const up = waits
								? { move: 0.35, shopper: 0.47, pay: 0.65, refund: 0.7, record: 0.8, read: 0.85 }
								: { move: 0.5, shopper: 0.55, pay: 0.57, refund: 0.75, record: 0.85, read: 0.93 };
							if (pick < up.move) return { kind: 'move', to, reason, restock };
							if (pick < up.shopper) return { kind: 'shopper' };
							if (pick < up.pay) return { kind: 'pay' };
							if (pick < up.refund) return { kind: 'refund', share, cash };
							if (pick < up.record) return { kind: 'record', share, confirm };
							if (pick < up.read) return { kind: 'read' };
							return { kind: 'use' };
						};
						/**
						 * @param {ReturnType<typeof choose>} action @param {any} [current] the order as read
						 * @returns {Promise<boolean>} whether it changed the order
						 */
						const run = async (action, current = read) => {
							counts.attempts += 1;
							const s = await service.site(ctx());
							if (action.kind === 'move') {
								try {
									await moves.move(
										s,
										ctx(),
										current,
										{
											to: /** @type {string} */ (action.to),
											note: '',
											serials: {},
											shipment: { courier: '', trackingNumber: `T-${step}` },
											// a dispatch video for a move into packed that asks for one
											video: { kind: 'dispatch_video', url: 'https://video.example/packing' },
											updatedAt: null,
											reason: /** @type {'rto' | 'customer_return'} */ (action.reason),
											// staff answer a move that asks whether the items go back in stock
											...(moveOf(flow, current.status, /** @type {string} */ (action.to), 'staff')?.options.restock ===
											'ask'
												? { restock: /** @type {boolean} */ (action.restock) }
												: {}),
										},
										flow,
									);
									counts.made += 1;
									return true;
								} catch (error) {
									expectCode(error, ['move_not_allowed', 'conflict', 'nothing_paid', 'payments_unavailable']);
									return false;
								}
							}
							if (action.kind === 'shopper') {
								ip += 1;
								// a fresh sign-in (the clock moves on)
								const signedIn = await shop.signIn({ id: user });
								const answer = await shop.call('POST', `/v1/shop/orders/${id}/cancel`, {
									token: shop.browser,
									origin: ORIGIN,
									headers: { 'ss-sign-in': signedIn, 'x-forwarded-for': `10.90.${(ip >> 8) & 255}.${ip & 255}` },
								});
								expect([200, 409], `shopper cancel: ${JSON.stringify(answer.json)}`).toContain(answer.status);
								if (answer.status === 200) counts.shopper += 1;
								return answer.status === 200;
							}
							if (action.kind === 'pay') {
								// the shopper pays at Payments; staff open the order, which asks Payments and confirms it
								if (current.role !== 'awaiting_payment' || current.payment.state !== 'pending') return false;
								shop.payPayment(current.payment.paymentId);
								if (!taken.has(current.payment.paymentId))
									taken.set(current.payment.paymentId, { amount: current.totals.total, refunded: 0, refunds: [] });
								counts.paid += 1;
								expect((await shop.api('GET', `/v1/orders/${id}`)).status).toBe(200);
								return true;
							}
							if (action.kind === 'refund') {
								const left = refundable(current);
								const checked = checkRefund(
									{
										amount: Math.max(1, Math.ceil(left * /** @type {number} */ (action.share))),
										reason: 'Goodwill',
										...(action.cash ? { method: 'cod' } : {}),
									},
									current,
									KEYS,
								);
								if (!checked.ok) return false;
								try {
									await moves.refund(s, ctx(), current, checked.value);
									counts.refunds += 1;
									return true;
								} catch (error) {
									// refused by Payments only when a cancel's refund took the money at the same moment
									expectCode(error, ['conflict', 'payments_unavailable', 'payments_refused']);
									return false;
								}
							}
							if (action.kind === 'record') {
								const due = Math.max(0, current.totals.total - current.payment.paid);
								const checked = checkPayment(
									{
										method: 'cod',
										amount: Math.max(1, Math.ceil(due * /** @type {number} */ (action.share))),
										confirm: action.confirm,
									},
									current,
									KEYS,
								);
								if (!checked.ok) return false;
								try {
									await moves.recordPayment(s, ctx(), current, checked.value, flow);
									counts.recorded += 1;
									return true;
								} catch (error) {
									expectCode(error, ['conflict', 'move_not_allowed', 'payments_unavailable']);
									return false;
								}
							}
							if (action.kind === 'read') {
								expect((await shop.api('GET', `/v1/orders/${id}`)).status).toBe(200);
								return false;
							}
							// a use of the shop: waiting orders whose window ended are canceled, pending refunds tried again
							const quoted = await shop.call('POST', '/v1/shop/cart/quote', {
								token: shop.browser,
								origin: ORIGIN,
								body: { lines: [] },
							});
							// an empty cart is refused (422); the work on use runs all the same
							expect(quoted.status).toBeLessThan(500);
							return false;
						};

						if (random() < 0.25) {
							// two at once, each with the order as read: what one gives back or takes, the other does not again
							counts.concurrent += 1;
							const pair = [choose(), choose()];
							// refunds by staff go through the order's refund lock, so two at once (or one with a move into a refunded
							// status) leave every refund Payments made recorded, never more than paid
							if (pair.some((action) => action.kind === 'refund')) counts.refundPairs += 1;
							await Promise.all(pair.map((action) => run(action)));
						} else if (random() < 0.012) {
							// a delete gives back what the order holds, once
							const answer = await shop.api('DELETE', `/v1/orders/${id}`);
							expect([204, 409, 503], JSON.stringify(answer.json)).toContain(answer.status);
							if (answer.status === 204) {
								counts.deleted += 1;
								live.delete(id);
								const facts = factsOf(read);
								const released = BEFORE_DELIVERY.includes(read.role);
								gone.push({
									...read,
									facts: released ? { ...facts, stock: 'back', offers: 'released', redeemed: 'given_back' } : facts,
								});
							}
						} else {
							const action = choose();
							const done = await run(action);
							// the same move again with the order as it was read changes nothing
							if (done && action.kind === 'move' && random() < 0.5) {
								counts.retries += 1;
								const before = await recordOf(id);
								expect(await run(action)).toBe(false);
								expect(await recordOf(id), `retry of ${action.to} (seed ${SEED})`).toEqual(before);
							}
						}
					}
				}
			}
		} finally {
			failing = false;
		}

		// Payments works again: every refund left pending is done once, on use
		shop.advance(3 * 60_000);
		for (const id of live) await shop.api('GET', `/v1/orders/${id}`);
		shop.responders.set(PAYMENTS, normal);

		// the invariants
		const records = /** @type {any[]} */ (
			await (await orders()).find({ websiteId: shop.websiteId, id: { $in: [...live] } }, { projection: { _id: 0 } }).toArray()
		);
		const all = [...records, ...gone];
		counts.expired = records.filter((record) =>
			record.history.some(
				(/** @type {any} */ entry) => entry.code === 'not_paid_in_time' || entry.code === 'not_confirmed_in_time',
			),
		).length;
		for (const product of products) {
			// stock = initial + given back − held or sold (or kept out after a return)
			const out = all
				.filter((record) => ['held', 'sold', 'none'].includes(factsOf(record).stock))
				.flatMap((record) => record.lines)
				.filter((line) => line.productId === product.id)
				.reduce((sum, line) => sum + line.quantity, 0);
			expect(await stockOf(product.id), `stock of ${product.id} (seed ${SEED})`).toBe(1000 - out);
			const sold = all
				.filter((record) => record.deliveredAt)
				.flatMap((record) => record.lines)
				.filter((line) => line.productId === product.id)
				.reduce((sum, line) => sum + line.quantity, 0);
			const stored = /** @type {any} */ (
				await data.collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: product.id })
			);
			expect(stored.sold, `sold of ${product.id} (seed ${SEED})`).toBe(sold);
			// ordered = the units of orders that hold their stock or were delivered (P3-10)
			const ordered = all
				.filter((record) => factsOf(record).stock === 'held' || record.deliveredAt)
				.flatMap((record) => record.lines)
				.filter((line) => line.productId === product.id)
				.reduce((sum, line) => sum + line.quantity, 0);
			expect(stored.ordered, `ordered of ${product.id} (seed ${SEED})`).toBe(ordered);
		}
		for (const record of records) {
			const label = `${record.id} (seed ${SEED})`;
			const sum = (/** @type {any[]} */ entries) => entries.reduce((total, entry) => total + entry.amount, 0);
			// paid = Σ payments, refunded = Σ refunds ≤ paid, and Payments refunded exactly what the order records of it
			expect(record.payment.paid, `paid of ${label}`).toBe(sum(record.payments ?? []));
			expect(record.payment.refunded, `refunded of ${label}`).toBe(sum(record.refunds ?? []));
			expect(record.payment.refunded, `refunded ≤ paid of ${label}`).toBeLessThanOrEqual(record.payment.paid);
			const atPayments = taken.get(record.payment.paymentId)?.refunded ?? 0;
			expect(sum((record.refunds ?? []).filter((/** @type {any} */ entry) => entry.refundId)), `Payments of ${label}`).toBe(
				atPayments,
			);
			// every refund a transition asked of Payments ended: done, not needed any more, or refused by Payments because a
			// refund by staff took the money at the same moment (then Payments refunded nothing for it)
			for (const effect of record.effects ?? [])
				expect(['done', 'skipped', 'failed'], `effect of ${label}`).toContain(effect.state);
			expect(record.stockHeld, `stockHeld of ${label}`).toBe(['held', 'sold'].includes(record.facts?.stock ?? 'held'));
			if (record.facts && (record.facts.offers === 'released' || record.facts.redeemed === 'given_back'))
				expect(record.promotions.released).toBe(true);
			// one history entry per transition, each from where the order was; one activity line each
			const moved = record.history.filter((/** @type {any} */ entry) => entry.from !== null && entry.from !== entry.to);
			let at = record.history[0].to;
			for (const entry of moved) {
				expect(entry.from, `history of ${label}`).toBe(at);
				at = entry.to;
			}
			expect(at, `status of ${label}`).toBe(record.status);
			const lines = (await activityOf(record.id)).filter((/** @type {any} */ entry) => entry.action === 'order.moved');
			expect(lines, `activity of ${label}`).toHaveLength(moved.length);
		}
		const coupon = /** @type {any} */ (
			await data.collection(COLLECTIONS.coupons).findOne({ websiteId: shop.websiteId, id: couponId })
		);
		expect(coupon.used, `coupon uses (seed ${SEED})`).toBe(
			all.filter((record) => record.promotions.couponId === couponId && factsOf(record).offers === 'counted').length,
		);
		const account = await loyaltyAccount(data, user, { now: shop.now() });
		expect(account.balance).toBe(balanceOf(account.lots));
		const spent = all
			.filter((record) => factsOf(record).redeemed === 'spent')
			.reduce((total, record) => total + record.promotions.pointsRedeemed, 0);
		const earned = all
			.filter((record) => factsOf(record).earned === 'credited')
			.reduce((total, record) => total + record.promotions.pointsEarned, 0);
		expect(account.balance, `points (seed ${SEED})`).toBe(100_000 - spent + earned);
		const rto = all.flatMap((record) => record.history).filter((entry) => entry.reason === 'rto').length;
		const customer = /** @type {any} */ (
			await data.collection(COLLECTIONS.customers).findOne({ websiteId: shop.websiteId, id: customerId })
		);
		expect(customer.rtoCount, `RTO count (seed ${SEED})`).toBe(rto);
		// enough of each happened to mean something (a typical run: 200 orders, about 3,000 actions, 530 moves made, 600
		// pairs at once, 160 retries, 50 shopper cancels, 10 Payments confirmations, 140 refunds, 60 recorded payments, 20
		// deletes, 5 windows ended, Payments failing in 350 steps)
		const said = JSON.stringify(counts);
		expect(all.length).toBe(FLOWS * ORDERS);
		expect(counts.made, said).toBeGreaterThan(400);
		expect(counts.concurrent, said).toBeGreaterThan(300);
		expect(counts.retries, said).toBeGreaterThan(80);
		for (const key of /** @type {const} */ ([
			'shopper',
			'paid',
			'refunds',
			'recorded',
			'deleted',
			'expired',
			'failing',
			'refundPairs',
		]))
			expect(counts[key], `${key}: ${said}`).toBeGreaterThan(0);
	}, 300_000);
});
