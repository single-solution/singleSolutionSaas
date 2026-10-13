/**
 * An order's money, the pure part (`core/orders.js`): how much of a refund goes back through Payments (PM-2).
 */
import { describe, expect, it } from 'vitest';
import { refundSplit } from '../core/orders.js';

/** @param {string} method @param {number} amount @param {string} [reference] */
const entry = (method, amount, reference = '') => ({ method, amount, reference });

/**
 * An order record with only what its money needs.
 * @param {Record<string, any>} payment @param {Record<string, any>} [lists] `payments`, `refunds`, `role`, `total`
 * @returns {any}
 */
const order = (payment, { payments, refunds = [], role = 'open', total = 1000 } = {}) => ({
	role,
	totals: { total, currency: 'USD' },
	payment: { method: 'online', paymentId: 'pay_1', advance: 0, paid: 0, refunded: 0, ...payment },
	...(payments ? { payments, refunds } : {}),
});

describe('refundSplit (PM-2)', () => {
	it('sends only what Payments took back through Payments', () => {
		// a payment started online but paid by a bank transfer staff recorded
		const byHand = order({ paid: 1000 }, { payments: [entry('bank_transfer', 1000, 'TRX-1')] });
		expect(refundSplit(byHand, 1000)).toEqual({ online: 0, manual: 1000 });
		// a COD advance through Payments and the rest in cash
		const advance = order(
			{ method: 'cod', advance: 200, paid: 1000 },
			{ payments: [entry('online', 200, 'pay_1'), entry('cash', 800)] },
		);
		expect(refundSplit(advance, 1000)).toEqual({ online: 200, manual: 800 });
		// after the advance went back online, nothing more goes through Payments
		const back = order(
			{ method: 'cod', advance: 200, paid: 1000, refunded: 200 },
			{ payments: advance.payments, refunds: [entry('online', 200)] },
		);
		expect(refundSplit(back, 800)).toEqual({ online: 0, manual: 800 });
		// an online entry of another (earlier) payment is not this payment's money
		const other = order({ paid: 1000 }, { payments: [entry('online', 1000, 'pay_0')] });
		expect(refundSplit(other, 500)).toEqual({ online: 0, manual: 500 });
		// a recorded refund leaves Payments' share as it was
		const recorded = order(
			{ paid: 1000, refunded: 300 },
			{ payments: [entry('online', 1000, 'pay_1')], refunds: [entry('cash', 300)] },
		);
		expect(refundSplit(recorded, 700)).toEqual({ online: 700, manual: 0 });
		expect(refundSplit(order({ paymentId: null, paid: 1000 }, { payments: [entry('cash', 1000)] }), 10)).toEqual({
			online: 0,
			manual: 10,
		});
	});

	it('counts records from before the payments log as before', () => {
		expect(refundSplit(order({ paid: 1000, refunded: 400 }), 600)).toEqual({ online: 600, manual: 0 });
		expect(refundSplit(order({ method: 'cod', advance: 300, paid: 1000 }), 1000)).toEqual({ online: 300, manual: 700 });
	});
});
