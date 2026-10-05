/**
 * Customer-facing views (pure; review A2 and A25 lessons): the customer sees the full timeline whatever the status
 * (cancelled and refunded included), the tracking number and link, the line snapshot (image, warranty, serials), what
 * was paid and refunded and whether they may still cancel — never internal notes, risk flags, payment references or
 * who on the staff did what.
 * @module
 */
import { summarize } from './ledger.js';

/**
 * @typedef {object} CustomerViewContext
 * @property {(status: string) => string} statusLabel
 * @property {(method: string | null | undefined) => string} methodLabel
 * @property {boolean} showTracking
 * @property {boolean} showVideo
 * @property {boolean} canCancel
 */

/**
 * Tracking as the customer sees it (null when there is nothing to show or it is turned off).
 * @param {Record<string, any>} order
 * @param {{ showTracking: boolean, showVideo: boolean }} options
 */
export const trackingOf = (order, { showTracking, showVideo }) => {
	const f = order.fulfilment ?? {};
	const tracking = showTracking && (f.carrierName || f.trackingNumber);
	const video = showVideo && f.dispatchVideoUrl;
	if (!tracking && !video) return null;
	return {
		carrier: tracking ? (f.carrierName ?? null) : null,
		serviceLevel: tracking ? (f.serviceLevel ?? null) : null,
		trackingNumber: tracking ? (f.trackingNumber ?? null) : null,
		trackingUrl: tracking ? (f.trackingUrl ?? null) : null,
		eta: tracking ? (f.eta ?? null) : null,
		dispatchVideoUrl: video ? f.dispatchVideoUrl : null,
	};
};

/**
 * @param {Date | string | null | undefined} value
 */
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * A short order summary for lists.
 * @param {Record<string, any>} order
 * @param {CustomerViewContext} ctx
 */
export const customerSummary = (order, ctx) => ({
	id: order.id,
	number: order.number,
	status: order.status,
	statusLabel: ctx.statusLabel(order.status),
	placedAt: iso(order.placedAt),
	currency: order.currency,
	total: order.amounts.total,
	units: (order.lines ?? []).reduce((/** @type {number} */ sum, /** @type {any} */ line) => sum + line.quantity, 0),
	canCancel: ctx.canCancel,
});

/**
 * The full customer view of one order.
 * @param {Record<string, any>} order
 * @param {CustomerViewContext} ctx
 */
export const customerView = (order, ctx) => {
	const money = summarize(order);
	return {
		...customerSummary(order, ctx),
		lines: (order.lines ?? []).map((/** @type {any} */ line) => ({
			id: line.id,
			itemId: line.itemId,
			variantId: line.variantId,
			sku: line.sku,
			title: line.title,
			variantTitle: line.variantTitle,
			quantity: line.quantity,
			unitAmount: line.unitAmount,
			totalAmount: line.totalAmount,
			warranty: line.warranty,
			imageUrl: line.imageUrl,
			serials: line.serials ?? [],
		})),
		amounts: order.amounts,
		taxLines: order.taxLines ?? [],
		adjustments: order.adjustments ?? [],
		delivery: order.delivery,
		payment: { method: order.payment?.method ?? null, methodLabel: ctx.methodLabel(order.payment?.method) },
		shipping: order.shipping ?? null,
		money: {
			paid: money.paid,
			refunded: money.refunded,
			balanceDue: money.balanceDue,
			paymentState: money.paymentState,
			refundState: money.refundState,
		},
		ledger: [
			...(order.payments ?? []).map((/** @type {any} */ p) => ({
				kind: 'payment',
				amount: p.amount,
				method: p.method,
				at: iso(p.at),
			})),
			...(order.refunds ?? []).map((/** @type {any} */ r) => ({
				kind: 'refund',
				amount: r.amount,
				method: r.method,
				at: iso(r.at),
			})),
		],
		tracking: trackingOf(order, ctx),
		timeline: (order.timeline ?? []).map((/** @type {any} */ entry) => ({
			status: entry.status,
			statusLabel: ctx.statusLabel(entry.status),
			at: iso(entry.at),
		})),
		customerNote: order.notes?.customer ?? null,
	};
};
