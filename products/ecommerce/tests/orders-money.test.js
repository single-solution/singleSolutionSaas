/**
 * An order's money, the pure part (`core/orders.js`): how much of a refund goes back through Payments (PM-2), and paid,
 * refunded and due counted one way for every view, invoice and lookup (CK-5, K-23).
 */
import { describe, expect, it } from 'vitest';
import { cashToCollect } from '../core/invoice.js';
import { orderSummary } from '../core/lookup.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { earnedLeft, orderMoney, refundSplit } from '../core/orders.js';

/** @param {string} method @param {number} amount @param {string} [reference] */
const entry = (method, amount, reference = '') => ({ method, amount, reference });

/**
 * An order record with only what its money needs.
 * @param {Record<string, any>} payment @param {Record<string, any>} [lists] `payments`, `refunds`, `role`, `total`
 * @returns {any}
 */
const order = (payment, { payments = [], refunds = [], role = 'open', total = 1000 } = {}) => ({
	role,
	totals: { total, currency: 'USD' },
	payment: { method: 'online', kind: 'gateway', paymentId: 'pay_1', advance: 0, paid: 0, refunded: 0, ...payment },
	payments,
	refunds,
});

describe('refundSplit (PM-2)', () => {
	it('sends only what Payments took back through Payments', () => {
		// a payment started online but paid by a bank transfer staff recorded
		const byHand = order({ paid: 1000 }, { payments: [entry('bank_transfer', 1000, 'TRX-1')] });
		expect(refundSplit(byHand, 1000)).toEqual({ online: 0, manual: 1000 });
		// a COD advance through Payments and the rest in cash
		const advance = order(
			{ method: 'cod', advance: 200, paid: 1000 },
			{ payments: [entry('payments', 200, 'pay_1'), entry('cod', 800)] },
		);
		expect(refundSplit(advance, 1000)).toEqual({ online: 200, manual: 800 });
		// after the advance went back online, nothing more goes through Payments
		const back = order(
			{ method: 'cod', advance: 200, paid: 1000, refunded: 200 },
			{ payments: advance.payments, refunds: [entry('payments', 200)] },
		);
		expect(refundSplit(back, 800)).toEqual({ online: 0, manual: 800 });
		// a Payments entry of another (earlier) payment is not this payment's money
		const other = order({ paid: 1000 }, { payments: [entry('payments', 1000, 'pay_0')] });
		expect(refundSplit(other, 500)).toEqual({ online: 0, manual: 500 });
		// a recorded refund leaves Payments' share as it was
		const recorded = order(
			{ paid: 1000, refunded: 300 },
			{ payments: [entry('payments', 1000, 'pay_1')], refunds: [entry('cod', 300)] },
		);
		expect(refundSplit(recorded, 700)).toEqual({ online: 700, manual: 0 });
		expect(refundSplit(order({ paymentId: null, paid: 1000 }, { payments: [entry('cod', 1000)] }), 10)).toEqual({
			online: 0,
			manual: 10,
		});
	});
});

describe('orderMoney (CK-5, K-23)', () => {
	it('never makes a refund a debt and owes nothing on a closed order', () => {
		// paid in full, part refunded: nothing due, the rest can be refunded
		const partly = order({ paid: 1000, refunded: 300 }, { role: 'delivered' });
		expect(orderMoney(partly)).toEqual({ paid: 1000, refunded: 300, net: 700, due: 0, refundable: 700, refundDue: 0 });
		// part paid: the rest is due, until the order closes
		expect(orderMoney(order({ paid: 400 })).due).toBe(600);
		for (const role of ['cancelled', 'returned_to_origin', 'refunded', 'returned'])
			expect(orderMoney(order({ paid: 400 }, { role })).due).toBe(0);
		// a canceled order still holding money owes it back
		expect(orderMoney(order({ paid: 1000, refunded: 200 }, { role: 'cancelled' })).refundDue).toBe(800);
		expect(orderMoney(order({ paid: 1000 }, { role: 'returned' })).refundDue).toBe(0);
	});

	it('is what the invoice, the lookup and the points use', () => {
		const cod = { ...order({ method: 'cod', kind: 'on_delivery', paymentId: null, state: 'unpaid' }), role: 'shipped' };
		expect(cashToCollect(cod)).toBe(1000);
		expect(cashToCollect({ ...cod, role: 'cancelled' })).toBe(0);
		const looked = orderSummary(
			{
				...order({ paid: 1000, refunded: 300 }, { role: 'delivered' }),
				status: 'delivered',
				lines: [],
				placedAt: new Date(0),
			},
			DEFAULT_FLOW,
			(amount) => String(amount),
		);
		expect(looked).toMatchObject({ paid: 700, balanceDue: 0 });
		expect(earnedLeft({ promotions: /** @type {any} */ ({ pointsEarned: 20 }) })).toBe(20);
		expect(earnedLeft({ promotions: /** @type {any} */ ({ pointsEarned: 20, pointsReversed: 25 }) })).toBe(0);
	});
});
