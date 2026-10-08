/**
 * Invoices and packing slips (PLAN 0.8.8: invoices and packing slips with the serial numbers on each line) as
 * printable, self-contained HTML: inline `<style>`, no script, every value HTML-escaped. Everything printed comes from
 * the order snapshot, business.json (name, address, e-mail, phone) and the `invoices` settings, whose texts the
 * merchant edits (`INVOICE_TEXTS` are the English defaults). The invoice number is the order number; the packing slip
 * has no prices. Dates are `YYYY-MM-DD` in the business's time zone (no language is assumed). No I/O.
 * @module
 */
import { formatMoney } from './money.js';

/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {{ name: string, email: string | null, phone: string | null, address: string | null, timeZone: string | null }} BusinessLike */

/** The editable texts (the `invoices` settings) and their defaults. */
export const INVOICE_TEXTS = Object.freeze({
	title: 'Invoice',
	packingSlipTitle: 'Packing slip',
	footer: '',
	labelNumber: 'Invoice no.',
	labelDate: 'Date',
	labelBilledTo: 'Billed to',
	labelShipTo: 'Ship to',
	labelItem: 'Item',
	labelSku: 'SKU',
	labelGrade: 'Grade',
	labelSerials: 'Serial numbers',
	labelQuantity: 'Qty',
	labelUnitPrice: 'Unit price',
	labelAmount: 'Amount',
	labelSubtotal: 'Subtotal',
	labelDiscount: 'Discount',
	labelDelivery: 'Delivery',
	labelTax: 'Tax',
	labelTaxIncluded: 'Tax included',
	labelTotal: 'Total',
	labelPayment: 'Payment',
	labelPaid: 'Paid',
	labelRefunded: 'Refunded',
	labelBalance: 'Balance due',
	labelPickup: 'Store pickup',
	labelCourier: 'Courier',
	labelTracking: 'Tracking number',
	labelNote: 'Note',
	methodCod: 'Cash on delivery',
	methodOnline: 'Paid online',
	methodBankTransfer: 'Bank transfer',
	methodPickup: 'Pay at pickup',
	stateUnpaid: 'Unpaid',
	statePending: 'Pending',
	statePaid: 'Paid',
	statePartiallyRefunded: 'Partially refunded',
	stateRefunded: 'Refunded',
});

/** @typedef {Record<keyof typeof INVOICE_TEXTS, string>} InvoiceTexts */

const ESCAPES = /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/**
 * HTML-escape a value.
 * @param {unknown} value
 */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

/**
 * The texts to print: the settings, with the defaults for anything missing.
 * @param {Record<string, unknown>} settings
 * @returns {InvoiceTexts}
 */
export const invoiceTexts = (settings) =>
	/** @type {InvoiceTexts} */ (
		Object.fromEntries(
			Object.entries(INVOICE_TEXTS).map(([key, fallback]) => [
				key,
				typeof settings[key] === 'string' && (settings[key] !== '' || key === 'footer') ? settings[key] : fallback,
			]),
		)
	);

/**
 * A date as `YYYY-MM-DD` in a time zone (UTC when the zone is missing or unknown).
 * @param {Date | null} date
 * @param {string | null} timeZone
 */
export const isoDate = (date, timeZone) => {
	if (!date) return '';
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timeZone || 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(date);
		const part = (/** @type {string} */ type) => parts.find((p) => p.type === type)?.value ?? '';
		return `${part('year')}-${part('month')}-${part('day')}`;
	} catch {
		return date.toISOString().slice(0, 10);
	}
};

const CSS = `
@page { margin: 12mm; }
* { box-sizing: border-box; }
body { font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 820px; padding: 24px; color: #000; background: #fff; }
h1 { font-size: 22px; letter-spacing: .06em; margin: 0 0 4px; text-transform: uppercase; }
h2 { font-size: 11px; letter-spacing: .1em; margin: 0 0 4px; text-transform: uppercase; }
p { margin: 0; }
header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid; padding-bottom: 12px; margin-bottom: 16px; }
.end { text-align: end; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
th { border-bottom: 2px solid; font-size: 10px; letter-spacing: .08em; text-align: start; text-transform: uppercase; }
th, td { padding: 6px 4px; vertical-align: top; }
td { border-bottom: 1px solid; }
.num { text-align: end; white-space: nowrap; }
.small { font-size: 10px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.totals { margin-inline-start: auto; width: 320px; }
.totals td { border: 0; padding: 2px 4px; }
.totals .grand td { border-top: 2px solid; font-size: 15px; font-weight: 700; padding-top: 6px; }
.footer { border-top: 1px solid; margin-top: 24px; padding-top: 12px; white-space: pre-line; }
@media print { body { padding: 0; } }
`;

/**
 * A complete HTML document.
 * @param {string} title
 * @param {string} body
 */
const page = (title, body) =>
	`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

/** @param {BusinessLike} business */
const businessBlock = (business) =>
	`<div class="end"><p><strong>${esc(business.name)}</strong></p>${[business.address, business.email, business.phone]
		.filter(Boolean)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('')}</div>`;

/** @param {NonNullable<OrderRecord['address']>} address */
const addressLines = (address) =>
	[
		address.name,
		address.phone,
		address.line1,
		address.line2,
		[address.area, address.city].filter(Boolean).join(', '),
		[address.postalCode, address.country].filter(Boolean).join(' '),
	]
		.filter(Boolean)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('');

/**
 * What each line says under its name: the variant, SKU, grade and serial numbers.
 * @param {OrderRecord['lines'][number]} line
 * @param {InvoiceTexts} t
 */
const lineDetail = (line, t) => {
	const parts = [
		line.variantName,
		line.sku ? `${t.labelSku} ${line.sku}` : '',
		line.gradeLabel ? `${t.labelGrade}: ${line.gradeLabel}` : '',
	].filter(Boolean);
	const detail = parts.length > 0 ? `<p class="small">${esc(parts.join(' · '))}</p>` : '';
	const serials =
		line.serials.length > 0 ? `<p class="small mono">${esc(`${t.labelSerials}: ${line.serials.join(', ')}`)}</p>` : '';
	return `${detail}${serials}`;
};

/** @type {Record<string, keyof InvoiceTexts>} */
const METHOD_TEXT = { cod: 'methodCod', online: 'methodOnline', bank_transfer: 'methodBankTransfer', pickup: 'methodPickup' };
/** @type {Record<string, keyof InvoiceTexts>} */
const STATE_TEXT = {
	unpaid: 'stateUnpaid',
	pending: 'statePending',
	paid: 'statePaid',
	partially_refunded: 'statePartiallyRefunded',
	refunded: 'stateRefunded',
};

/**
 * The invoice of an order.
 * @param {OrderRecord} order
 * @param {{ business: BusinessLike, texts: InvoiceTexts }} context
 */
export const invoiceHtml = (order, { business, texts: t }) => {
	const { currency } = order.totals;
	const money = (/** @type {number} */ amount) => esc(formatMoney(amount, currency));
	const rows = order.lines
		.map(
			(line) =>
				`<tr><td><strong>${esc(line.name)}</strong>${lineDetail(line, t)}</td><td class="num">${line.quantity}</td><td class="num">${money(line.unitPrice)}</td><td class="num">${money(line.unitPrice * line.quantity)}</td></tr>`,
		)
		.join('');
	const { subtotal, discount, delivery, tax, total, taxIncluded } = order.totals;
	/** @type {Array<[string, string, boolean?]>} */
	const totals = [[t.labelSubtotal, money(subtotal)]];
	if (discount > 0) totals.push([t.labelDiscount, `−${money(discount)}`]);
	if (delivery > 0) totals.push([t.labelDelivery, money(delivery)]);
	if (tax > 0) totals.push([taxIncluded ? t.labelTaxIncluded : t.labelTax, money(tax)]);
	totals.push([t.labelTotal, money(total), true]);
	const { payment } = order;
	if (payment.paid > 0) totals.push([t.labelPaid, money(payment.paid)]);
	if (payment.refunded > 0) totals.push([t.labelRefunded, `−${money(payment.refunded)}`]);
	const due = payment.state === 'refunded' ? 0 : Math.max(0, total - payment.paid);
	if (due > 0 && payment.paid > 0) totals.push([t.labelBalance, money(due)]);
	const totalsRows = totals
		.map(
			([label, value, grand]) =>
				`<tr${grand ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${value}</td></tr>`,
		)
		.join('');
	const method = t[METHOD_TEXT[payment.method] ?? 'methodOnline'];
	const state = t[STATE_TEXT[payment.state] ?? 'stateUnpaid'];
	const customer = order.customer;
	const billed = [customer.name, customer.email, customer.phone]
		.filter(Boolean)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('');
	const shipTo = order.address
		? `<div><h2>${esc(t.labelShipTo)}</h2>${addressLines(order.address)}</div>`
		: order.delivery.method === 'pickup'
			? `<div><h2>${esc(t.labelShipTo)}</h2><p>${esc(t.labelPickup)}</p></div>`
			: '<div></div>';
	const body = `<header><div><h1>${esc(t.title)}</h1><p>${esc(t.labelNumber)} <strong class="mono">${esc(order.number)}</strong></p><p>${esc(t.labelDate)} ${esc(isoDate(order.placedAt, business.timeZone))}</p></div>${businessBlock(business)}</header><div class="grid"><div><h2>${esc(t.labelBilledTo)}</h2>${billed}</div>${shipTo}</div><table><thead><tr><th>${esc(t.labelItem)}</th><th class="num">${esc(t.labelQuantity)}</th><th class="num">${esc(t.labelUnitPrice)}</th><th class="num">${esc(t.labelAmount)}</th></tr></thead><tbody>${rows}</tbody></table><table class="totals"><tbody>${totalsRows}</tbody></table><p>${esc(t.labelPayment)}: ${esc(method)} · ${esc(state)}</p>${t.footer ? `<div class="footer small">${esc(t.footer)}</div>` : ''}`;
	return page(`${t.title} ${order.number}`, body);
};

/**
 * The packing slip of an order (no prices).
 * @param {OrderRecord} order
 * @param {{ business: BusinessLike, texts: InvoiceTexts }} context
 */
export const packingSlipHtml = (order, { business, texts: t }) => {
	const rows = order.lines
		.filter((line) => line.kind === 'physical')
		.map(
			(line) =>
				`<tr><td><strong>${esc(line.name)}</strong>${lineDetail(line, t)}</td><td class="num">${line.quantity}</td></tr>`,
		)
		.join('');
	const shipTo = order.address
		? addressLines(order.address)
		: `<p>${esc(order.delivery.method === 'pickup' ? t.labelPickup : order.customer.name)}</p>`;
	const shipment = order.shipment
		? `<p>${esc(t.labelCourier)}: ${esc(order.shipment.courier)}</p><p>${esc(t.labelTracking)}: <span class="mono">${esc(order.shipment.trackingNumber)}</span></p>`
		: '';
	const note = order.note ? `<p class="small">${esc(t.labelNote)}: ${esc(order.note)}</p>` : '';
	const body = `<header><div><h1>${esc(t.packingSlipTitle)}</h1><p><strong class="mono">${esc(order.number)}</strong></p><p>${esc(t.labelDate)} ${esc(isoDate(order.placedAt, business.timeZone))}</p></div>${businessBlock(business)}</header><div class="grid"><div><h2>${esc(t.labelShipTo)}</h2>${shipTo}</div><div class="end">${shipment}</div></div><table><thead><tr><th>${esc(t.labelItem)}</th><th class="num">${esc(t.labelQuantity)}</th></tr></thead><tbody>${rows}</tbody></table>${note}${t.footer ? `<div class="footer small">${esc(t.footer)}</div>` : ''}`;
	return page(`${t.packingSlipTitle} ${order.number}`, body);
};
