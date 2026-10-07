/**
 * Bulk work (pure): CSV export rows with the merchant's columns, and CSV import rows of status and tracking updates
 * (`number` or `id`, then any of `status`, `reason`, `carrier`, `service_level`, `tracking_number`, `note`). Each row
 * is applied by the service with the same rules as a single change.
 * @module
 */
import { summarize } from './ledger.js';
import { addressLine } from './documents.js';
import { cleanText, isId, isKey } from './text.js';

/** Columns an import understands. */
export const IMPORT_COLUMNS = Object.freeze([
	'id',
	'number',
	'status',
	'reason',
	'carrier',
	'service_level',
	'tracking_number',
	'note',
]);

/**
 * One export cell.
 * @param {Record<string, any>} order
 * @param {string} column
 * @param {{ revenue: boolean }} context
 * @returns {string | number | boolean | null}
 */
export const exportCell = (order, column, { revenue }) => {
	const money = summarize(order);
	const lines = /** @type {any[]} */ (order.lines ?? []);
	switch (column) {
		case 'id':
			return order.id;
		case 'number':
			return order.number;
		case 'external_id':
			return order.externalId ?? null;
		case 'source':
			return order.source;
		case 'placed_at':
			return new Date(order.placedAt).toISOString();
		case 'status':
			return order.status;
		case 'revenue':
			return revenue;
		case 'customer_name':
			return order.shipping?.name ?? order.customer?.name ?? null;
		case 'customer_email':
			return order.customer?.email ?? null;
		case 'customer_phone':
			return order.customer?.phone ?? order.shipping?.phone ?? null;
		case 'city':
			return order.shipping?.city ?? null;
		case 'country':
			return order.shipping?.country ?? null;
		case 'currency':
			return order.currency;
		case 'subtotal':
		case 'discount':
		case 'shipping':
		case 'tax':
		case 'total':
			return order.amounts[column];
		case 'paid':
			return money.paid;
		case 'refunded':
			return money.refunded;
		case 'balance_due':
			return money.balanceDue;
		case 'payment_method':
			return order.payment?.method ?? null;
		case 'delivery_method':
			return order.delivery?.method ?? null;
		case 'carrier':
			return order.fulfilment?.carrierName ?? null;
		case 'tracking_number':
			return order.fulfilment?.trackingNumber ?? null;
		case 'units':
			return lines.reduce((sum, line) => sum + line.quantity, 0);
		case 'lines':
			return lines.map((line) => `${line.quantity} × ${line.sku ?? line.title}`).join('; ');
		case 'serials':
			return lines.flatMap((line) => line.serials ?? []).join(' ');
		case 'risk_flags':
			return (order.risk?.flags ?? []).join(' ');
		case 'address':
			return addressLine(order.shipping);
		default:
			return null;
	}
};

/**
 * @typedef {{ line: number, ref: { id: string } | { number: string }, status: string | null, reason: string | null,
 *   fulfilment: Record<string, string | null> }} ImportRow
 */

/**
 * Turn CSV records into update instructions; rows that are not understood are reported, not guessed.
 * @param {Array<{ line: number, values: Record<string, string> }>} records
 * @returns {{ rows: ImportRow[], problems: Array<{ line: number, code: string }> }}
 */
export const importRows = (records) => {
	/** @type {ImportRow[]} */
	const rows = [];
	/** @type {Array<{ line: number, code: string }>} */
	const problems = [];
	for (const { line, values } of records) {
		const id = values.id ? values.id : null;
		const number = values.number ? cleanText(values.number, 64) : null;
		if (id && !isId(id)) {
			problems.push({ line, code: 'id_invalid' });
			continue;
		}
		if (!id && !number) {
			problems.push({ line, code: 'order_ref_missing' });
			continue;
		}
		const status = values.status ? values.status.trim().toLowerCase() : null;
		if (status !== null && !isKey(status)) {
			problems.push({ line, code: 'status_invalid' });
			continue;
		}
		const reason = values.reason ? values.reason.trim().toLowerCase() : null;
		/** @type {Record<string, string | null>} */
		const fulfilment = {};
		if (values.carrier !== undefined && values.carrier !== '') fulfilment.carrier = values.carrier;
		if (values.service_level !== undefined && values.service_level !== '') fulfilment.serviceLevel = values.service_level;
		if (values.tracking_number !== undefined && values.tracking_number !== '')
			fulfilment.trackingNumber = values.tracking_number;
		if (values.note !== undefined && values.note !== '') fulfilment.note = values.note;
		if (status === null && Object.keys(fulfilment).length === 0) {
			problems.push({ line, code: 'nothing_to_change' });
			continue;
		}
		rows.push({ line, ref: id ? { id } : { number: /** @type {string} */ (number) }, status, reason, fulfilment });
	}
	return { rows, problems };
};
