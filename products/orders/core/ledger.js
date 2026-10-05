/**
 * The payments and refunds ledger (pure; review A22): every movement of money on an order is an append-only entry,
 * and these are the only formulas for what it means —
 *
 *   paid = Σ payments   refunded = Σ refunds   netPaid = paid − refunded   balanceDue = total − netPaid (never negative)
 *
 * A refund can never exceed what is still held (the repository enforces it inside the write), and an order becomes
 * fully refunded only when refunds cover everything received. Net revenue of a revenue-status order is its total
 * minus its refunds (A11).
 * @module
 */
import { cleanText, httpsUrl, isObject, issue } from './text.js';
import { isAmount } from './money.js';

/**
 * @typedef {object} LedgerEntry
 * @property {string} id
 * @property {'payment' | 'refund'} kind
 * @property {number} amount
 * @property {string} method
 * @property {string | null} reference
 * @property {string | null} proofUrl
 * @property {string | null} note
 * @property {Array<{ lineId: string, quantity: number }>} lines refunded lines (refunds only)
 * @property {{ type: string, id: string | null }} actor
 * @property {Date} at
 */

/**
 * @typedef {object} MoneySummary
 * @property {number} total
 * @property {number} paid
 * @property {number} refunded
 * @property {number} netPaid
 * @property {number} balanceDue
 * @property {number} refundable
 * @property {'unpaid' | 'partially_paid' | 'paid'} paymentState
 * @property {'none' | 'partial' | 'full'} refundState
 */

/**
 * @param {Record<string, any>} order `{ amounts: { total }, paid?, refunded? }`
 * @returns {MoneySummary}
 */
export const summarize = (order) => {
	const total = Math.max(0, order.amounts?.total ?? 0);
	const paid = Math.max(0, order.paid ?? 0);
	const refunded = Math.max(0, order.refunded ?? 0);
	const netPaid = Math.max(0, paid - refunded);
	return {
		total,
		paid,
		refunded,
		netPaid,
		balanceDue: Math.max(0, total - netPaid),
		refundable: netPaid,
		paymentState: paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partially_paid',
		refundState: refunded <= 0 ? 'none' : refunded >= paid ? 'full' : 'partial',
	};
};

/**
 * Net revenue an order contributes: its total minus refunds for a revenue status, else 0.
 * @param {Record<string, any>} order
 * @param {boolean} revenueStatus
 */
export const netRevenue = (order, revenueStatus) =>
	revenueStatus ? Math.max(0, (order.amounts?.total ?? 0) - Math.max(0, order.refunded ?? 0)) : 0;

/**
 * @typedef {{ key: string, label: string | null, requiresReference: boolean }} Method
 */

/**
 * Methods from the `ledger` settings.
 * @param {unknown} raw
 * @returns {Method[]}
 */
export const methodsOf = (raw) =>
	(Array.isArray(raw) ? raw : [])
		.filter((m) => isObject(m) && typeof m.key === 'string')
		.map((m) => ({
			key: m.key,
			label: typeof m.label === 'string' && m.label.trim() ? m.label.trim() : null,
			requiresReference: m.requires_reference === true,
		}));

/**
 * Validate a payment or refund request.
 * @param {unknown} input
 * @param {'payment' | 'refund'} kind
 * @param {{ methods: Method[], lines: ReadonlyArray<{ id: string, quantity: number }> }} context
 * @returns {{ ok: true, value: { amount: number, method: string, reference: string | null, proofUrl: string | null, note: string | null, lines: Array<{ lineId: string, quantity: number }>, at: Date | null } }
 *   | { ok: false, errors: Array<{ path: string, code: string }> }}
 */
export const validateEntry = (input, kind, { methods, lines }) => {
	if (!isObject(input)) return { ok: false, errors: [issue('', 'object_required')] };
	/** @type {Array<{ path: string, code: string }>} */
	const errors = [];
	if (!isAmount(input.amount) || input.amount <= 0) errors.push(issue('/amount', 'amount_invalid'));
	const method = methods.find((m) => m.key === input.method);
	if (!method) errors.push(issue('/method', 'method_unknown'));
	const reference = input.reference === undefined || input.reference === null ? null : cleanText(input.reference, 200);
	if (input.reference !== undefined && input.reference !== null && reference === null)
		errors.push(issue('/reference', 'text_invalid'));
	if (method?.requiresReference && !reference) errors.push(issue('/reference', 'reference_required'));
	const proofUrl = input.proofUrl === undefined || input.proofUrl === null ? null : httpsUrl(input.proofUrl);
	if (input.proofUrl !== undefined && input.proofUrl !== null && proofUrl === null)
		errors.push(issue('/proofUrl', 'url_invalid'));
	const noteField = kind === 'refund' ? 'reason' : 'note';
	const note = cleanText(input[noteField], 500, { multiline: true });
	if (input[noteField] !== undefined && input[noteField] !== null && note === null)
		errors.push(issue(`/${noteField}`, 'text_invalid'));
	if (kind === 'refund' && note === null) errors.push(issue('/reason', 'required'));
	const at = input.occurredAt === undefined || input.occurredAt === null ? null : new Date(String(input.occurredAt));
	if (at && Number.isNaN(at.getTime())) errors.push(issue('/occurredAt', 'date_invalid'));
	/** @type {Array<{ lineId: string, quantity: number }>} */
	const refundLines = [];
	if (kind === 'refund' && input.lines !== undefined && input.lines !== null) {
		if (!Array.isArray(input.lines) || input.lines.length > 500) errors.push(issue('/lines', 'invalid'));
		else
			for (const [index, raw] of input.lines.entries()) {
				const line = lines.find((l) => l.id === raw?.lineId);
				if (!line || !Number.isSafeInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > line.quantity)
					errors.push(issue(`/lines/${index}`, 'line_invalid'));
				else refundLines.push({ lineId: line.id, quantity: raw.quantity });
			}
	}
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			amount: /** @type {number} */ (input.amount),
			method: /** @type {Method} */ (method).key,
			reference,
			proofUrl,
			note,
			lines: refundLines,
			at,
		},
	};
};
