/**
 * Event data this product publishes (pure): the catalogued `order.refunded@1` (the Orders ledger records refunds from
 * it) and `inventory.changed@1` (restocked units), and the product's own claim events. Each builder returns data that
 * validates against the `@ss/contracts` schema of its type (closed objects, optional fields omitted when unknown).
 * @module
 */
import { kindOf } from './claims.js';

/** Characters kept of a refund reason (`order.refunded@1` allows 500). */
const REASON_MAX = 500;

/**
 * @param {Record<string, unknown>} object
 * @returns {Record<string, unknown>}
 */
const compact = (object) =>
	Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));

/**
 * `order.refunded@1` data for one refund of a claim.
 * @param {{ claim: Record<string, any>, purchase: Record<string, any>, refund: { amount: number, currency: string },
 *   reason: string, includeLines: boolean }} input
 */
export const refundEventData = ({ claim, purchase, refund, reason, includeLines }) =>
	compact({
		orderId: purchase.orderId,
		amount: { amount: refund.amount, currency: refund.currency },
		reason: reason.slice(0, REASON_MAX),
		number: purchase.number ?? undefined,
		customerId: purchase.customer?.customerId ?? undefined,
		customer: (() => {
			const ref = compact({
				customerId: purchase.customer?.customerId,
				subject: purchase.customer?.subject,
				email: purchase.customer?.email,
				phone: purchase.customer?.phone,
			});
			return Object.keys(ref).length > 0 ? ref : undefined;
		})(),
		lines: includeLines
			? /** @type {Array<Record<string, any>>} */ (claim.lines).map((line) =>
					compact({
						itemId: line.itemId,
						variantId: line.variantId,
						sku: line.sku,
						title: line.title,
						quantity: line.quantity,
						unitAmount: line.unitAmount,
						totalAmount: line.unitAmount === null ? null : line.unitAmount * line.quantity,
					}),
				)
			: undefined,
	});

/**
 * `inventory.changed@1` data for a restocked line, from the last known on-hand quantity.
 * @param {{ line: Record<string, any>, previous: { quantity: number, available?: number | null }, reason: string }} input
 */
export const restockEventData = ({ line, previous, reason }) =>
	compact({
		itemId: line.itemId,
		variantId: line.variantId,
		sku: line.sku,
		quantity: previous.quantity + line.quantity,
		previousQuantity: previous.quantity,
		available: typeof previous.available === 'number' ? previous.available + line.quantity : undefined,
		previousAvailable: typeof previous.available === 'number' ? previous.available : undefined,
		reason,
	});

/**
 * `aftersales.claim_submitted@1` data.
 * @param {Record<string, any>} claim
 */
export const submittedEventData = (claim) =>
	compact({
		claimId: claim.id,
		reference: claim.reference,
		type: claim.type,
		reason: claim.reason,
		purchaseId: claim.purchaseId,
		orderId: claim.orderId,
		status: claim.status,
		via: claim.via,
		lines: /** @type {Array<Record<string, any>>} */ (claim.lines).map((line) =>
			compact({ lineId: line.lineId, itemId: line.itemId, variantId: line.variantId, quantity: line.quantity }),
		),
	});

/**
 * `aftersales.claim_status_changed@1` data.
 * @param {{ claim: Record<string, any>, from: string, to: string, statuses: import('./claims.js').Status[] }} input
 */
export const statusEventData = ({ claim, from, to, statuses }) =>
	compact({
		claimId: claim.id,
		reference: claim.reference,
		type: claim.type,
		orderId: claim.orderId,
		from,
		to,
		kind: kindOf(statuses, to),
	});

/**
 * Where to reach a customer: the first configured channel the contact supports.
 * @param {{ email?: string | null, phone?: string | null } | null | undefined} contact
 * @param {readonly string[]} channels
 * @returns {{ channel: string, to: string } | null}
 */
export const pickTarget = (contact, channels) => {
	for (const channel of channels) {
		if (channel === 'email' && contact?.email) return { channel, to: contact.email };
		if ((channel === 'sms' || channel === 'whatsapp') && contact?.phone) return { channel, to: contact.phone };
	}
	return null;
};
