/**
 * The order engine, the pure part (PLAN 0.8.10 dynamic model §3, phase 1): facts derived from today's flags
 * (`core/facts.js`), the plan of each kind of transition (`core/transitions.js`), the flow-save guard and restatus
 * checks (`core/flow.js`), and a property test: random flows the role rules allow × random sequences of transitions
 * (repeated ones included), applied in memory, never give anything back or take anything twice.
 */
import { describe, expect, it } from 'vitest';
import { FACT_KEYS, PLACED_FACTS, derivedFacts, factsGuard, factsOf, isFacts } from '../core/facts.js';
import { DEFAULT_FLOW, checkRestatus, flowChangeProblems } from '../core/flow.js';
import { checkTransition, nothingPaid, planRelease, planTransition } from '../core/transitions.js';
import { randomFlow, randomOf } from './transitions-helpers.js';

const NOW = Date.parse('2026-10-14T10:00:00Z');
const STAFF = { kind: 'staff', id: 'usr_staff', name: 'Sam' };
/** @type {import('../core/transitions.js').TransitionRules} */
const RULES = { paymentWindowMinutes: 60, paidOnDelivery: true, loyalty: null, timeZone: 'UTC' };
const LOYALTY = { earnPercent: 10, pointValue: 100 };

/**
 * An order record (the default flow), paid online, with a coupon, 50 points redeemed and 30 earned.
 * @param {Record<string, any>} [patch]
 * @returns {any}
 */
const order = (patch = {}) => ({
	id: 'ord_1',
	number: 'S-2026-000001',
	customer: { userId: 'usr_1', name: 'Sara', email: '', phone: '', customerId: 'cus_1' },
	lines: [
		{ id: 'oln_1', productId: 'prd_1', variantId: 'var_1', kind: 'physical', quantity: 2, locationId: null, serials: [] },
		{ id: 'oln_2', productId: 'prd_2', variantId: 'var_2', kind: 'digital', quantity: 1, locationId: null, serials: [] },
	],
	totals: { subtotal: 3000, discount: 0, delivery: 0, tax: 0, total: 3000, currency: 'USD', taxIncluded: true },
	promotions: {
		couponId: 'cpn_1',
		couponCode: 'SAVE',
		dealIds: ['dl_1'],
		bundleIds: [],
		pointsRedeemed: 50,
		pointsValue: 500,
		pointsEarned: 30,
		pointsFixed: false,
		pointsCredited: false,
		released: false,
	},
	payment: { method: 'online', state: 'paid', paymentId: 'pay_1', advance: 0, paid: 3000, refunded: 0, checkedAt: null },
	payments: [{ id: 'opy_1', method: 'online', amount: 3000, reference: 'pay_1' }],
	refunds: [],
	status: 'confirmed',
	role: 'open',
	history: [],
	media: [],
	stockHeld: true,
	holdUntil: null,
	deliveredAt: null,
	updatedAt: new Date(NOW - 1000),
	...patch,
});

/**
 * Plan a staff move of the default flow.
 * @param {any} from @param {string} to @param {Partial<import('../core/transitions.js').TransitionInput>} [input]
 * @param {Partial<import('../core/transitions.js').TransitionRules>} [rules] @param {import('../core/model.js').OrderFlow} [flow]
 */
const plan = (from, to, input = {}, rules = {}, flow = DEFAULT_FLOW) =>
	planTransition({
		order: from,
		flow,
		to,
		input: { who: 'staff', actor: STAFF, by: 'Sam', byKind: 'staff', note: '', ...input },
		rules: { ...RULES, ...rules },
		now: NOW,
	});

/** @param {ReturnType<typeof plan>} result */
const planOf = (result) => {
	if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
	return result.plan;
};

/** @param {import('../core/transitions.js').TransitionPlan} p */
const kinds = (p) => p.ledger.map((effect) => effect.kind);

describe('facts derived from the flags orders had before them', () => {
	it('match every state today’s give-backs leave', () => {
		expect(derivedFacts(order({ role: 'awaiting_payment', status: 'pending_payment' }))).toEqual(PLACED_FACTS);
		// delivered: sold, earned points credited
		expect(
			derivedFacts(
				order({ role: 'delivered', deliveredAt: new Date(NOW), promotions: { ...order().promotions, pointsCredited: true } }),
			),
		).toEqual({ stock: 'sold', offers: 'counted', redeemed: 'spent', earned: 'credited', units: 'none' });
		// a cancel (or a refund before delivery) gave everything back
		for (const role of ['cancelled', 'refunded'])
			expect(
				derivedFacts(order({ role, stockHeld: false, promotions: { ...order().promotions, released: true } })),
				role,
			).toEqual({ stock: 'back', offers: 'released', redeemed: 'given_back', earned: 'none', units: 'none' });
		// a return to origin put the stock back, or kept it out
		const rto = { role: 'returned_to_origin', stockHeld: false, history: [{ reason: 'rto' }] };
		expect(derivedFacts(order({ ...rto, returnRestocked: true })).stock).toBe('back');
		expect(derivedFacts(order(rto))).toEqual({
			stock: 'none',
			offers: 'counted',
			redeemed: 'spent',
			earned: 'none',
			units: 'none',
		});
		// refunded after it came back: the offers stay counted, the points came back
		expect(
			derivedFacts(
				order({
					...rto,
					role: 'refunded',
					history: [{ reason: 'rto' }],
					promotions: { ...order().promotions, released: true },
				}),
			),
		).toEqual({ stock: 'none', offers: 'counted', redeemed: 'given_back', earned: 'none', units: 'none' });
		// a customer's return after delivery: earned points reversed, redeemed ones given back
		const credited = { ...order().promotions, pointsCredited: true, released: true, pointsReversed: 30 };
		expect(
			derivedFacts(
				order({
					role: 'returned',
					stockHeld: false,
					returnRestocked: true,
					deliveredAt: new Date(NOW),
					promotions: credited,
				}),
			),
		).toEqual({ stock: 'back', offers: 'counted', redeemed: 'given_back', earned: 'reversed', units: 'none' });
		// refunded after delivery: the units stay sold
		expect(derivedFacts(order({ role: 'refunded', deliveredAt: new Date(NOW), promotions: credited }))).toEqual({
			stock: 'sold',
			offers: 'counted',
			redeemed: 'given_back',
			earned: 'reversed',
			units: 'none',
		});
		// serial numbers count while the units are held or sold
		const lines = order().lines.map((/** @type {any} */ line) => ({
			...line,
			serials: line.kind === 'physical' ? ['S1', 'S2'] : [],
		}));
		expect(derivedFacts(order({ role: 'packed', lines })).units).toBe('captured');
		expect(derivedFacts(order({ role: 'cancelled', stockHeld: false, lines })).units).toBe('none');
		// an order that never wrote pointsCredited counts as credited once settled, as the reversal reads it
		const unwritten = { ...order().promotions, pointsCredited: undefined };
		expect(derivedFacts(order({ role: 'delivered', promotions: unwritten })).earned).toBe('credited');
		expect(derivedFacts(order({ role: 'open', promotions: unwritten })).earned).toBe('none');
		expect(derivedFacts(order({ role: 'open', promotions: null })).redeemed).toBe('spent');
	});

	it('are read as written once a transition wrote them, and guard its write', () => {
		const written = { stock: 'back', offers: 'released', redeemed: 'given_back', earned: 'none', units: 'none' };
		expect(factsOf(order({ facts: written }))).toEqual(written);
		expect(isFacts({ ...written, stock: 'gone' })).toBe(false);
		expect(factsOf(order({ facts: { ...written, stock: 'gone' } }))).toEqual(PLACED_FACTS);
		expect(factsGuard(order({ facts: written }))).toEqual({
			'facts.stock': 'back',
			'facts.offers': 'released',
			'facts.redeemed': 'given_back',
			'facts.earned': 'none',
			'facts.units': 'none',
		});
		expect(factsGuard(order())).toEqual({ facts: { $exists: false } });
		expect(FACT_KEYS).toEqual(['stock', 'offers', 'redeemed', 'earned', 'units']);
	});
});

describe('the plan of each kind of transition (the default flow, today’s rules)', () => {
	it('confirms, packs, ships and sends back to wait without giving anything back', () => {
		const waiting = order({ status: 'pending_payment', role: 'awaiting_payment' });
		const entry = { id: 'opy_2', method: 'other', amount: 3000 };
		const confirmed = planOf(plan(waiting, 'confirmed', { paid: { set: { 'payment.paid': 3000 }, entry } }));
		expect(confirmed.ledger).toEqual([]);
		expect(confirmed.set).toMatchObject({ status: 'confirmed', role: 'open', holdUntil: null, 'payment.paid': 3000 });
		expect(confirmed.push.payments).toBe(entry);
		expect(confirmed.recorded).toBe(entry);
		expect(confirmed.guard).toMatchObject({
			status: 'pending_payment',
			updatedAt: waiting.updatedAt,
			facts: { $exists: false },
		});

		const units = {
			plan: [{ lineId: 'oln_1', productId: 'prd_1', variantId: 'var_1', serials: ['S1', 'S2'], before: [] }],
			mode: /** @type {const} */ ('registered'),
		};
		const packed = planOf(plan(order(), 'packed', { units, video: { kind: 'dispatch_video', url: 'https://v.example/1' } }));
		expect(kinds(packed)).toEqual(['capture_units']);
		expect(packed.facts.after.units).toBe('captured');
		expect(packed.push.media).toEqual({ kind: 'dispatch_video', url: 'https://v.example/1' });
		expect(/** @type {any[]} */ (packed.set.lines)[0].serials).toEqual(['S1', 'S2']);

		const shipment = { courier: 'Post', trackingNumber: 'T1', trackingUrl: '', booked: false, status: '', checkedAt: null };
		const shipped = planOf(plan(order({ status: 'packed', role: 'packed' }), 'dispatched', { shipment }));
		expect(shipped.set.shipment).toBe(shipment);
		expect(shipped.ledger).toEqual([]);

		// back to waiting from packed: serial numbers go back, a new window (or none, by the move or the settings)
		const flow = { ...DEFAULT_FLOW, moves: [...DEFAULT_FLOW.moves, { from: 'packed', to: 'pending_payment' }] };
		const lines = order().lines.map((/** @type {any} */ line) => ({ ...line, serials: ['S1'] }));
		const rewait = planOf(plan(order({ status: 'packed', role: 'packed', lines }), 'pending_payment', {}, {}, flow));
		expect(kinds(rewait)).toEqual(['release_units']);
		expect(rewait.set.holdUntil).toEqual(new Date(NOW + 60 * 60_000));
		expect(rewait.facts.after.units).toBe('none');
		const inPacked = order({ status: 'packed', role: 'packed' });
		expect(planOf(plan(inPacked, 'pending_payment', {}, { paymentWindowMinutes: 0 }, flow)).set.holdUntil).toBeNull();
		const none = {
			...DEFAULT_FLOW,
			moves: [
				...DEFAULT_FLOW.moves,
				{ from: 'packed', to: 'pending_payment', options: { window: /** @type {const} */ ('none') } },
			],
		};
		expect(planOf(plan(inPacked, 'pending_payment', {}, {}, none)).set.holdUntil).toBeNull();
	});

	it('delivers: units sold, cash on delivery paid, earned points credited once', () => {
		const delivered = planOf(plan(order(), 'delivered', {}, { loyalty: LOYALTY }));
		expect(kinds(delivered)).toEqual(['give_points', 'count_sold']);
		// 10 % of 3,000 in points of 100: 3, or the 30 fixed at placement
		expect(delivered.ledger[0]).toMatchObject({ kind: 'give_points', owner: { userId: 'usr_1' }, points: 3, reason: 'earn' });
		expect(delivered.set).toMatchObject({ 'promotions.pointsEarned': 3, 'promotions.pointsCredited': true });
		const fixed = order({ promotions: { ...order().promotions, pointsFixed: true } });
		expect(planOf(plan(fixed, 'delivered', {}, { loyalty: LOYALTY })).ledger[0]).toMatchObject({ points: 30 });
		// a guest earns only when guests earn
		const guest = order({ customer: { userId: '', name: '', email: '', phone: '', customerId: 'cus_9' } });
		expect(kinds(planOf(plan(guest, 'delivered', {}, { loyalty: LOYALTY })))).toEqual(['count_sold']);
		expect(planOf(plan(guest, 'delivered', {}, { loyalty: { ...LOYALTY, guests: 'earn' } })).ledger[0]).toMatchObject({
			owner: { customerId: 'cus_9' },
		});
		expect(delivered.facts.after).toMatchObject({ stock: 'sold', earned: 'credited' });
		// already credited (or no loyalty): nothing more
		const credited = order({ facts: { ...PLACED_FACTS, earned: 'credited' } });
		expect(kinds(planOf(plan(credited, 'delivered', {}, { loyalty: LOYALTY })))).toEqual(['count_sold']);
		expect(kinds(planOf(plan(order(), 'delivered')))).toEqual(['count_sold']);
		// cash on delivery becomes paid unless staff record it
		const cod = order({
			payment: { ...order().payment, method: 'cod', state: 'unpaid', paid: 0, paymentId: null },
			payments: [],
		});
		const cash = planOf(plan(cod, 'delivered'));
		expect(cash.recorded).toMatchObject({ method: 'cash', amount: 3000, note: 'Paid on delivery' });
		expect(cash.set).toMatchObject({ 'payment.state': 'paid', 'payment.paid': 3000 });
		expect(planOf(plan(cod, 'delivered', {}, { paidOnDelivery: false })).recorded).toBeNull();
	});

	it('cancels: everything back once, and a refund of what Payments took after the transaction', () => {
		const cancelled = planOf(
			plan(order(), 'cancelled', { note: 'Out of stock', payments: { 'payment.voidedAt': new Date(NOW) } }),
		);
		expect(kinds(cancelled)).toEqual(['release_stock', 'release_slots', 'release_offers', 'give_points']);
		expect(cancelled.ledger[0]).toEqual({
			kind: 'release_stock',
			lines: [{ productId: 'prd_1', variantId: 'var_1', quantity: 2, locationId: null }],
		});
		expect(cancelled.ledger[3]).toMatchObject({ owner: { userId: 'usr_1' }, points: 50, reason: 'refund' });
		expect(cancelled.set).toMatchObject({ stockHeld: false, 'promotions.released': true, 'payment.voidedAt': new Date(NOW) });
		expect(cancelled.facts.after).toEqual({
			stock: 'back',
			offers: 'released',
			redeemed: 'given_back',
			earned: 'none',
			units: 'none',
		});
		expect(cancelled.external).toEqual([
			expect.objectContaining({
				id: 'ord_1:cancel',
				kind: 'refund',
				amount: 3000,
				state: 'pending',
				reason: 'Out of stock',
				note: 'Order cancelled',
			}),
		]);
		expect(cancelled.push.effects).toEqual({ $each: cancelled.external });
		expect(cancelled.event).toEqual({ from: 'confirmed', to: 'cancelled', by: 'Sam', note: 'Out of stock' });
		// a shopper's cancel (by default) or an ended window refunds nothing (the money shows as due)
		const waiting = order({ status: 'pending_payment', role: 'awaiting_payment' });
		const shopper = planOf(
			plan(waiting, 'cancelled', { who: 'shopper', by: 'shopper', byKind: undefined, cancelReason: 'shopper' }),
		);
		expect(shopper.external).toEqual([]);
		expect(shopper.history).toMatchObject({ by: 'shopper', reason: 'shopper' });
		expect(shopper.event).toEqual({ from: 'pending_payment', to: 'cancelled', by: 'shopper', reason: 'shopper' });
		const expired = planOf(
			plan(waiting, 'cancelled', { who: 'system', by: 'system', byKind: undefined, cancelReason: 'expired', listed: false }),
		);
		expect(expired.external).toEqual([]);
		// staff whose move says the refund is theirs: nothing is refunded now
		const byHand = {
			...DEFAULT_FLOW,
			moves: DEFAULT_FLOW.moves.map((move) =>
				move.from === 'confirmed' && move.to === 'cancelled'
					? { ...move, options: { refund: /** @type {const} */ ('staff') } }
					: move,
			),
		};
		expect(planOf(plan(order(), 'cancelled', {}, {}, byHand)).external).toEqual([]);
		// facts that say it was given back already: nothing is given back again
		const back = order({ facts: { stock: 'back', offers: 'released', redeemed: 'given_back', earned: 'none', units: 'none' } });
		expect(planOf(plan(back, 'cancelled')).ledger).toEqual([]);
	});

	it('takes parcels back: restocked or kept out, an RTO counted, points of a customer’s return', () => {
		const shipped = order({ status: 'dispatched', role: 'shipped' });
		const rto = planOf(plan(shipped, 'returned'));
		expect(kinds(rto)).toEqual(['release_units', 'restock_return', 'count_rto']);
		expect(rto.set).toMatchObject({ stockHeld: false, returnRestocked: true });
		expect(rto.history).toMatchObject({ reason: 'rto' });
		const keptOut = {
			...DEFAULT_FLOW,
			moves: DEFAULT_FLOW.moves.map((move) =>
				move.to === 'returned' ? { ...move, options: { restock: /** @type {const} */ ('no') } } : move,
			),
		};
		const kept = planOf(plan(shipped, 'returned', { reason: 'customer_return' }, {}, keptOut));
		expect(kinds(kept)).toEqual(['release_units']);
		expect(kept.facts.after.stock).toBe('none');
		expect(kept.set.returnRestocked).toBeUndefined();

		const flow = {
			statuses: [
				...DEFAULT_FLOW.statuses,
				{ key: 'customer-returned', label: 'Returned', role: /** @type {const} */ ('returned') },
			],
			moves: [
				...DEFAULT_FLOW.moves,
				{ from: 'delivered', to: 'customer-returned' },
				{ from: 'customer-returned', to: 'refunded' },
			],
		};
		const delivered = order({
			status: 'delivered',
			role: 'delivered',
			deliveredAt: new Date(NOW),
			promotions: { ...order().promotions, pointsCredited: true, pointsReversed: 10 },
		});
		const returned = planOf(plan(delivered, 'customer-returned', {}, {}, flow));
		expect(kinds(returned)).toEqual(['release_units', 'restock_return', 'take_points', 'give_points']);
		expect(returned.ledger[2]).toMatchObject({ points: 20 });
		expect(returned.inc).toEqual({ 'promotions.pointsReversed': 20 });
		expect(returned.facts.after).toMatchObject({ stock: 'back', redeemed: 'given_back', earned: 'reversed' });
		// a guest without a customer record has no points to move
		const anonymous = { ...delivered, customer: { userId: '', name: '', email: '', phone: '' } };
		expect(kinds(planOf(plan(anonymous, 'customer-returned', {}, {}, flow)))).toEqual(['release_units', 'restock_return']);
	});

	it('refunds: before delivery as a cancel and only when paid, after delivery with the points', () => {
		const flow = { ...DEFAULT_FLOW, moves: [...DEFAULT_FLOW.moves, { from: 'confirmed', to: 'refunded' }] };
		// 2,000 taken by Payments, 1,000 paid by bank transfer: the transfer recorded as given back by hand in the
		// transaction, Payments' part refunded after it (the Idempotency-Key names the refunds before it)
		const split = order({
			payments: [
				{ id: 'opy_1', method: 'online', amount: 2000, reference: 'pay_1' },
				{ id: 'opy_2', method: 'bank_transfer', amount: 1000, reference: 'T-1' },
			],
		});
		const before = planOf(plan(split, 'refunded', {}, {}, flow));
		expect(kinds(before)).toEqual(['release_stock', 'release_slots', 'release_offers', 'give_points']);
		expect(before.refunded).toBe(1000);
		expect(before.set).toMatchObject({ 'payment.refunded': 1000, 'payment.state': 'partially_refunded' });
		expect(/** @type {any} */ (before.push.refunds).$each).toEqual([
			expect.objectContaining({ method: 'other', amount: 1000, note: 'Order refunded' }),
		]);
		expect(before.external).toEqual([
			expect.objectContaining({ id: 'ord_1:refund:0', kind: 'refund', amount: 2000, reason: 'Order refunded' }),
		]);
		// all through Payments: nothing recorded in the transaction
		const online = planOf(plan(order(), 'refunded', { note: 'Damaged' }, {}, flow));
		expect(online.set['payment.refunded']).toBeUndefined();
		expect(online.push.refunds).toBeUndefined();
		expect(online.external).toEqual([expect.objectContaining({ amount: 3000, reason: 'Damaged', note: 'Damaged' })]);
		const unpaid = order({ payment: { ...order().payment, paid: 0 } });
		expect(plan(unpaid, 'refunded', {}, {}, flow)).toMatchObject({ ok: false, code: 'nothing_paid' });
		expect(nothingPaid(unpaid, 'cancelled')).toBeNull();

		const delivered = order({
			status: 'delivered',
			role: 'delivered',
			deliveredAt: new Date(NOW),
			promotions: { ...order().promotions, pointsCredited: true },
		});
		const after = planOf(plan(delivered, 'refunded'));
		expect(kinds(after)).toEqual(['take_points', 'give_points']);
		expect(after.facts.after).toMatchObject({ stock: 'sold', earned: 'reversed', redeemed: 'given_back' });
		expect(after.set.stockHeld).toBeUndefined();
	});

	it('refuses moves the flow or the role rules do not allow, and an order whose status changed its role', () => {
		expect(checkTransition({ order: order(), flow: DEFAULT_FLOW, to: 'dispatched' })).toMatchObject({
			ok: false,
			code: 'move_not_allowed',
		});
		expect(checkTransition({ order: order(), flow: DEFAULT_FLOW, to: 'nowhere' })).toMatchObject({ code: 'move_not_allowed' });
		expect(checkTransition({ order: order(), flow: DEFAULT_FLOW, to: 'confirmed' })).toMatchObject({
			code: 'move_not_allowed',
		});
		// G1: the status of a delivered order given the role open must not let it be cancelled
		const reRoled = {
			...DEFAULT_FLOW,
			statuses: DEFAULT_FLOW.statuses.map((status) =>
				status.key === 'delivered' ? { ...status, role: /** @type {const} */ ('open') } : status,
			),
			moves: [...DEFAULT_FLOW.moves, { from: 'delivered', to: 'cancelled' }],
		};
		const delivered = order({ status: 'delivered', role: 'delivered' });
		expect(plan(delivered, 'cancelled', {}, {}, reRoled)).toMatchObject({ ok: false, code: 'flow_changed' });
		// a cancel that needs no listed move (an ended window, a shopper) still follows the role rules
		const strict = { ...DEFAULT_FLOW, moves: DEFAULT_FLOW.moves.filter((move) => move.to !== 'cancelled') };
		const waiting = order({ status: 'awaiting_confirmation', role: 'awaiting_confirmation' });
		expect(checkTransition({ order: waiting, flow: strict, to: 'cancelled' }).ok).toBe(false);
		expect(checkTransition({ order: waiting, flow: strict, to: 'cancelled', listed: false }).ok).toBe(true);
		expect(checkTransition({ order: delivered, flow: strict, to: 'cancelled', listed: false }).ok).toBe(false);
		// a status the flow no longer has: refused when listed (as before), by its role when not
		const gone = order({ status: 'retired', role: 'awaiting_confirmation' });
		expect(checkTransition({ order: gone, flow: DEFAULT_FLOW, to: 'cancelled' }).ok).toBe(false);
		expect(checkTransition({ order: gone, flow: DEFAULT_FLOW, to: 'cancelled', listed: false }).ok).toBe(true);
	});

	it('plans a delete as a release without a status, once', () => {
		expect(planRelease({ order: order({ status: 'delivered', role: 'delivered' }) })).toBeNull();
		const release = /** @type {import('../core/transitions.js').TransitionPlan} */ (planRelease({ order: order() }));
		expect(kinds(release)).toEqual(['release_units', 'release_stock', 'release_slots', 'release_offers', 'give_points']);
		expect(release.set).toMatchObject({ stockHeld: false, 'promotions.released': true });
		expect(release.history).toBeNull();
		const back = order({ facts: { stock: 'back', offers: 'released', redeemed: 'given_back', earned: 'none', units: 'none' } });
		expect(kinds(/** @type {any} */ (planRelease({ order: back })))).toEqual(['release_units']);
	});
});

describe('the flow-save guard and restatus', () => {
	const counts = [
		{ status: 'packed', role: 'packed', count: 3 },
		{ status: 'retired', role: 'open', count: 2 },
		{ status: 'confirmed', role: 'open', count: 0 },
	];
	it('keeps the key and kind of every status that has orders; names and moves change freely', () => {
		expect(flowChangeProblems(DEFAULT_FLOW, DEFAULT_FLOW, counts)).toEqual([]);
		const renamed = {
			statuses: DEFAULT_FLOW.statuses.map((status) => ({ ...status, label: `${status.label}!` })),
			moves: DEFAULT_FLOW.moves.slice(0, 3),
		};
		expect(flowChangeProblems(DEFAULT_FLOW, renamed, counts)).toEqual([]);
		const removed = { ...DEFAULT_FLOW, statuses: DEFAULT_FLOW.statuses.filter((status) => status.key !== 'packed') };
		expect(flowChangeProblems(DEFAULT_FLOW, removed, counts)).toEqual([
			{ path: '/value/statuses', code: 'status_in_use', message: expect.stringContaining('Packed (packed) has 3 orders') },
		]);
		const reRoled = {
			...DEFAULT_FLOW,
			statuses: DEFAULT_FLOW.statuses.map((status) =>
				status.key === 'packed' ? { ...status, role: /** @type {const} */ ('open') } : status,
			),
		};
		expect(flowChangeProblems(DEFAULT_FLOW, reRoled, counts)).toEqual([
			{ path: '/value/statuses/3/role', code: 'status_in_use', message: expect.stringContaining('stays packed (not open)') },
		]);
		// a status the flow no longer had comes back only with its orders' role
		const back = (/** @type {any} */ role) => ({
			...DEFAULT_FLOW,
			statuses: [...DEFAULT_FLOW.statuses, { key: 'retired', label: 'Retired', role }],
		});
		expect(flowChangeProblems(DEFAULT_FLOW, back('open'), counts)).toEqual([]);
		expect(flowChangeProblems(DEFAULT_FLOW, back('packed'), counts)).toHaveLength(1);
		expect(flowChangeProblems(DEFAULT_FLOW, DEFAULT_FLOW, [{ status: 'packed', role: 'packed', count: 1 }])).toEqual([]);
		// a status whose role was changed before the guard existed: kept as saved, or put right to its orders' role only
		const wrong = {
			...DEFAULT_FLOW,
			statuses: DEFAULT_FLOW.statuses.map((status) =>
				status.key === 'delivered' ? { ...status, role: /** @type {const} */ ('open') } : status,
			),
		};
		const inDelivered = [{ status: 'delivered', role: 'delivered', count: 4 }];
		expect(flowChangeProblems(wrong, wrong, inDelivered)).toEqual([]);
		expect(flowChangeProblems(wrong, DEFAULT_FLOW, inDelivered)).toEqual([]);
		const third = {
			...DEFAULT_FLOW,
			statuses: DEFAULT_FLOW.statuses.map((status) =>
				status.key === 'delivered' ? { ...status, role: /** @type {const} */ ('shipped') } : status,
			),
		};
		expect(flowChangeProblems(wrong, third, inDelivered)).toEqual([
			{ path: '/value/statuses/5/role', code: 'status_in_use', message: expect.stringContaining('stays open (not shipped)') },
		]);
		// orders of two kinds in one status (left by such a change): only an unchanged role saves
		const mixed = [...inDelivered, { status: 'delivered', role: 'open', count: 1 }];
		expect(flowChangeProblems(wrong, DEFAULT_FLOW, mixed)).toHaveLength(1);
		expect(flowChangeProblems(wrong, wrong, mixed)).toEqual([]);
	});

	it('moves orders only between statuses of the same kind', () => {
		const flow = {
			...DEFAULT_FLOW,
			statuses: [...DEFAULT_FLOW.statuses, { key: 'qc', label: 'Quality check', role: /** @type {const} */ ('open') }],
		};
		expect(checkRestatus(flow, 'qc', 'confirmed')).toEqual({ ok: true, role: 'open' });
		expect(checkRestatus(flow, 'retired', 'confirmed')).toEqual({ ok: true, role: 'open' });
		expect(checkRestatus(flow, 'qc', 'packed')).toMatchObject({ ok: false, field: 'to' });
		expect(checkRestatus(flow, 'qc', 'qc')).toMatchObject({ ok: false, field: 'to' });
		expect(checkRestatus(flow, 'qc', 'nowhere')).toMatchObject({ ok: false, field: 'to' });
		expect(checkRestatus(flow, 'Bad key', 'confirmed')).toMatchObject({ ok: false, field: 'from' });
	});
});

// ------------------------------------------------------------------------------------------------ property test

/**
 * Apply a plan's write to an order in memory (`$set` with dotted paths, `$inc`, `$push`).
 * @param {any} record @param {import('../core/transitions.js').TransitionPlan} p
 */
const applied = (record, p) => {
	const next = structuredClone(record);
	/** @param {string} path @param {(value: any) => any} change */
	const at = (path, change) => {
		const keys = path.split('.');
		let node = next;
		for (const key of keys.slice(0, -1)) node = node[key] ??= {};
		const last = /** @type {string} */ (keys.at(-1));
		node[last] = change(node[last]);
	};
	for (const [path, value] of Object.entries(p.set)) at(path, () => structuredClone(value));
	for (const [path, value] of Object.entries(p.inc)) at(path, (old) => (old ?? 0) + value);
	if (p.history) next.history = [...(next.history ?? []), p.history];
	// the refunds a plan asks of Payments wait (pending) until done; refunds recorded by hand are written
	next.effects = [...(next.effects ?? []), ...structuredClone(p.external)];
	const refunds = /** @type {any} */ (p.push.refunds);
	if (refunds) next.refunds = [...(next.refunds ?? []), ...structuredClone(refunds.$each)];
	return next;
};

describe('property: random flows × random transitions never give back or take twice', () => {
	it('holds for 1,000 flows with random move options (E40 moves included) × 6 orders × 12 random steps, repeats included', () => {
		const SEED = 20261014;
		const random = randomOf(SEED);
		let transitions = 0;
		const by = { staff: 0, shopper: 0, system: 0, trigger: 0, afterDelivery: 0, kept: 0, restocked: 0 };
		for (let f = 0; f < 1000; f += 1) {
			const flow = randomFlow(random);
			for (let o = 0; o < 6; o += 1) {
				const waiting = random() < 0.5 ? 'awaiting_payment' : 'awaiting_confirmation';
				const start = flow.statuses.find((status) => status.role === waiting);
				let current = order({
					status: start?.key,
					role: start?.role,
					customer: random() < 0.3 ? { userId: '', name: '', email: '', phone: '', customerId: 'cus_2' } : order().customer,
					payment:
						random() < 0.5
							? order().payment
							: { ...order().payment, method: 'cod', state: 'unpaid', paid: 0, paymentId: null },
					facts: { ...PLACED_FACTS },
				});
				/** @type {Record<string, number>} */
				const counted = {};
				const rules = { ...RULES, loyalty: random() < 0.7 ? LOYALTY : null };
				for (let step = 0; step < 12; step += 1) {
					const options = flow.statuses.filter((status) => random() < 0.4 || status.key === current.status);
					const target = options[Math.floor(random() * options.length)] ?? flow.statuses[0];
					// staff along a listed move, the shopper along one of theirs, the shop itself (an ended window, without one;
					// a trigger, along any listed move)
					const pick = random();
					/** @type {Partial<import('../core/transitions.js').TransitionInput>} */
					const input =
						pick < 0.65
							? { who: 'staff' }
							: pick < 0.8
								? { who: 'shopper', cancelReason: 'shopper' }
								: pick < 0.9
									? { who: 'system', listed: false, cancelReason: 'expired' }
									: { who: 'staff', trigger: true };
					const result = plan(
						current,
						/** @type {any} */ (target).key,
						{ ...input, restock: random() < 0.5, reason: random() < 0.5 ? 'rto' : 'customer_return' },
						rules,
						flow,
					);
					if (!result.ok) {
						expect(['move_not_allowed', 'nothing_paid', 'flow_changed']).toContain(result.code);
						continue;
					}
					transitions += 1;
					by[input.trigger ? 'trigger' : /** @type {'staff' | 'shopper' | 'system'} */ (input.who)] += 1;
					const p = result.plan;
					if (!['awaiting_payment', 'awaiting_confirmation', 'open', 'packed', 'shipped'].includes(p.fromStage))
						by.afterDelivery += 1;
					if (
						p.facts.before.earned === 'credited' &&
						p.facts.after.earned === 'credited' &&
						p.ledger.some((e) => e.kind === 'give_points' && e.reason === 'refund')
					)
						by.kept += 1;
					if (p.facts.before.stock === 'sold' && p.facts.after.stock === 'back') by.restocked += 1;
					for (const effect of p.ledger) {
						const key =
							effect.kind === 'give_points'
								? `give_${effect.reason}_${p.stage === 'delivered' ? 'earn' : 'redeemed'}`
								: effect.kind;
						counted[key] = (counted[key] ?? 0) + 1;
					}
					counted.external = (counted.external ?? 0) + p.external.length;
					// every fact the plan writes is a fact, and only the stage contract's changes happen
					expect(isFacts(p.set.facts)).toBe(true);
					if (p.facts.before.stock !== 'held' && p.facts.before.stock !== 'sold')
						expect(p.ledger.some((e) => e.kind === 'release_stock' || e.kind === 'restock_return')).toBe(false);
					if (p.facts.before.offers === 'released') expect(kinds(p)).not.toContain('release_offers');
					if (p.facts.before.earned !== 'credited') expect(kinds(p)).not.toContain('take_points');
					// a shopper or the shop itself only cancels, and a shopper only before dispatch
					if (input.who !== 'staff') expect(p.stage).toBe('cancelled');
					if (input.who === 'shopper')
						expect(['awaiting_payment', 'awaiting_confirmation', 'open', 'packed']).toContain(p.fromStage);
					// repeating the same transition on the order as it is now changes nothing
					const after = applied(current, p);
					const repeat = plan(after, /** @type {any} */ (target).key, { ...input }, rules, flow);
					expect(repeat.ok).toBe(false);
					current = after;
				}
				// each give-back and take at most once in the order's whole life
				for (const kind of [
					'release_stock',
					'release_slots',
					'release_offers',
					'restock_return',
					'give_refund_redeemed',
					'take_points',
					'give_earn_earn',
					'count_sold',
					'count_rto',
					'external',
				])
					expect(counted[kind] ?? 0, `${kind} (seed ${SEED})`).toBeLessThanOrEqual(1);
				// stock comes back only once, whichever way
				expect((counted.release_stock ?? 0) + (counted.restock_return ?? 0)).toBeLessThanOrEqual(1);
			}
		}
		expect(transitions, JSON.stringify(by)).toBeGreaterThan(7000);
		// every kind of transition happened, also E40's after delivery, kept points and items back after delivery
		for (const [kind, count] of Object.entries(by)) expect(count, `${kind}: ${JSON.stringify(by)}`).toBeGreaterThan(20);
	});
});
