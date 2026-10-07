/**
 * Printable documents (pure): invoices and receipts, packing slips and pick lists as self-contained HTML with print
 * CSS — no script, no PDF library, no colour (black on paper, `currentColor` borders). Everything printed comes from
 * the order snapshot and the merchant's settings: line warranty as placed (A8: "no warranty" for 0 days, nothing for
 * lines without one — never a blanket warranty text), the placement date, itemised adjustments, the order's own tax
 * lines, payments, refunds and the balance due. All text goes through `t` (strings) and is HTML-escaped.
 * @module
 */
import { formatMoney } from './money.js';
import { summarize } from './ledger.js';

/**
 * @typedef {object} DocContext
 * @property {(key: string, params?: Record<string, string | number>) => string} t
 * @property {string} locale
 * @property {string | null} timeZone
 * @property {{ name: string, logoUrl: string | null, addressLines: string[], contactLines: string[], taxId: string | null,
 *   legalText: string | null, footerText: string | null }} brand
 * @property {(status: string) => string} statusLabel
 * @property {(method: string | null | undefined) => string} methodLabel
 * @property {(method: string | null | undefined) => string} deliveryLabel
 * @property {(order: Record<string, any>) => boolean} payOnDelivery
 * @property {number} [now]
 */

const ESCAPES = /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/** @param {unknown} value */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

const CSS = `
@page { margin: 12mm; }
* { box-sizing: border-box; }
body { font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 820px; padding: 24px; }
h1 { font-size: 22px; letter-spacing: .08em; margin: 0; text-transform: uppercase; }
h2 { font-size: 11px; letter-spacing: .12em; margin: 0 0 4px; text-transform: uppercase; }
p { margin: 0; }
header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid; padding-bottom: 12px; margin-bottom: 16px; }
.brand { text-align: end; }
.brand img { max-height: 48px; max-width: 200px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.end { text-align: end; }
table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
th { border-bottom: 2px solid; font-size: 10px; letter-spacing: .1em; text-align: start; text-transform: uppercase; }
th, td { padding: 6px 4px; vertical-align: top; }
td { border-bottom: 1px solid; }
.num { text-align: end; white-space: nowrap; }
.small { font-size: 10px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.totals { margin-inline-start: auto; width: 320px; }
.totals td { border: 0; padding: 2px 4px; }
.totals .grand td { border-top: 2px solid; font-size: 15px; font-weight: 700; padding-top: 6px; }
.box { border: 2px solid; padding: 8px 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: baseline; }
.big { font-size: 26px; font-weight: 700; }
.slot { border-bottom: 1px dashed; display: inline-block; min-width: 180px; height: 14px; }
.check { border: 1px solid; display: inline-block; height: 12px; width: 12px; }
.legal { border-top: 1px solid; margin-top: 24px; padding-top: 12px; white-space: pre-line; }
.page { break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
@media print { body { padding: 0; } }
`;

/**
 * A complete HTML document.
 * @param {{ title: string, lang: string, body: string }} input
 */
export const page = ({ title, lang, body }) =>
	`<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

/**
 * @param {Date | string | null | undefined} value
 * @param {DocContext} ctx
 * @param {boolean} [withTime]
 */
export const formatDate = (value, ctx, withTime = false) => {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const options = /** @type {Intl.DateTimeFormatOptions} */ ({
		dateStyle: 'medium',
		...(withTime ? { timeStyle: 'short' } : {}),
		...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
	});
	try {
		return new Intl.DateTimeFormat(ctx.locale, options).format(date);
	} catch {
		return date.toISOString().slice(0, withTime ? 16 : 10);
	}
};

/** @param {Record<string, string> | null | undefined} address */
export const addressLine = (address) =>
	address
		? ['line1', 'line2', 'city', 'region', 'postalCode', 'country']
				.map((field) => address[field])
				.filter(Boolean)
				.join(', ')
		: '';

/**
 * Warranty text of a line from its snapshot: the label as placed, else days; "no warranty" for 0; '' without one.
 * @param {{ warranty?: { label: string | null, days: number | null } | null }} line
 * @param {DocContext} ctx
 */
export const warrantyText = (line, ctx) => {
	const warranty = line.warranty;
	if (!warranty) return '';
	if (warranty.label) return warranty.label;
	if (warranty.days === 0) return ctx.t('invoice.no_warranty');
	return typeof warranty.days === 'number' ? ctx.t('invoice.warranty_days', { days: warranty.days }) : '';
};

/** @param {DocContext} ctx */
const brandBlock = (ctx) =>
	`<div class="brand">${ctx.brand.logoUrl ? `<img src="${esc(ctx.brand.logoUrl)}" alt="${esc(ctx.brand.name)}">` : ''}<p><strong>${esc(ctx.brand.name)}</strong></p>${ctx.brand.addressLines.map((line) => `<p>${esc(line)}</p>`).join('')}${ctx.brand.contactLines.length > 0 ? `<p>${esc(ctx.brand.contactLines.join(' · '))}</p>` : ''}${ctx.brand.taxId ? `<p>${esc(ctx.t('invoice.tax_id', { id: ctx.brand.taxId }))}</p>` : ''}</div>`;

/**
 * Who the order is for: the billing address, else the delivery address, else the customer as placed (A8: a pickup
 * order still shows the customer's name and phone).
 * @param {Record<string, any>} order
 */
const recipientOf = (order) => {
	const address = order.billing ?? order.shipping ?? null;
	return {
		name: address?.name ?? order.customer?.name ?? '',
		phone: address?.phone ?? order.customer?.phone ?? '',
		email: order.customer?.email ?? '',
		line: addressLine(address),
	};
};

/**
 * @typedef {object} InvoiceOptions
 * @property {'customer' | 'internal'} kind
 * @property {string} invoiceNumber
 * @property {boolean} showWarranty
 * @property {boolean} showSerials
 * @property {boolean} showSku
 * @property {boolean} showTaxLines
 * @property {boolean} showPayments
 */

/**
 * An invoice or receipt.
 * @param {Record<string, any>} order
 * @param {DocContext} ctx
 * @param {InvoiceOptions} options
 */
export const invoiceHtml = (order, ctx, options) => {
	const { t } = ctx;
	const money = (/** @type {number} */ amount) => esc(formatMoney(amount, order.currency, ctx.locale));
	const summary = summarize(order);
	const title = options.kind === 'internal' ? t('invoice.internal_title') : t('invoice.title');
	const recipient = recipientOf(order);
	const lines = /** @type {any[]} */ (order.lines ?? []);
	const warrantyColumn = options.showWarranty && lines.some((line) => warrantyText(line, ctx) !== '');
	const rows = lines
		.map((line) => {
			const detail = [line.variantTitle, options.showSku && line.sku ? t('invoice.sku', { sku: line.sku }) : null]
				.filter(Boolean)
				.join(' · ');
			const serials =
				options.showSerials && (line.serials ?? []).length > 0
					? `<p class="small mono">${esc(t('invoice.serials', { serials: line.serials.join(', ') }))}</p>`
					: '';
			return `<tr><td><strong>${esc(line.title)}</strong>${detail ? `<p class="small">${esc(detail)}</p>` : ''}${serials}</td>${warrantyColumn ? `<td class="small">${esc(warrantyText(line, ctx) || '—')}</td>` : ''}<td class="num">${line.quantity}</td><td class="num">${money(line.unitAmount)}</td><td class="num">${money(line.totalAmount)}</td></tr>`;
		})
		.join('');
	/** @type {Array<[string, string, boolean?]>} */
	const totals = [[t('invoice.subtotal'), money(order.amounts.subtotal)]];
	if (order.amounts.discount > 0) totals.push([t('invoice.discount'), `−${money(order.amounts.discount)}`]);
	if (order.amounts.shipping > 0) totals.push([t('invoice.shipping'), money(order.amounts.shipping)]);
	for (const adjustment of order.adjustments ?? [])
		totals.push([adjustment.label, adjustment.amount < 0 ? `−${money(-adjustment.amount)}` : money(adjustment.amount)]);
	if (options.showTaxLines && (order.taxLines ?? []).length > 0)
		for (const tax of order.taxLines) totals.push([tax.rate ? `${tax.label} (${tax.rate})` : tax.label, money(tax.amount)]);
	else if (order.amounts.tax > 0) totals.push([t('invoice.tax'), money(order.amounts.tax)]);
	totals.push([t('invoice.total'), money(order.amounts.total), true]);
	const totalsRows = totals
		.map(
			([label, value, grand]) =>
				`<tr${grand ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${value}</td></tr>`,
		)
		.join('');
	const entries = [
		...(order.payments ?? []).map((/** @type {any} */ p) => ({ ...p, kind: 'payment' })),
		...(order.refunds ?? []).map((/** @type {any} */ r) => ({ ...r, kind: 'refund' })),
	];
	const payments =
		options.showPayments && entries.length > 0
			? `<table class="totals"><tbody>${entries
					.map((entry) => {
						const label = [
							t(entry.kind === 'refund' ? 'invoice.refunded' : 'invoice.paid'),
							ctx.methodLabel(entry.method),
							formatDate(entry.at, ctx),
							options.kind === 'internal' && entry.reference ? entry.reference : null,
						]
							.filter(Boolean)
							.join(' · ');
						return `<tr><td>${esc(label)}</td><td class="num">${entry.kind === 'refund' ? '−' : ''}${money(entry.amount)}</td></tr>`;
					})
					.join(
						'',
					)}${summary.refunded > 0 ? `<tr><td>${esc(t('invoice.net_paid'))}</td><td class="num">${money(summary.netPaid)}</td></tr>` : ''}${summary.balanceDue > 0 ? `<tr class="grand"><td>${esc(t(ctx.payOnDelivery(order) ? 'invoice.due_on_delivery' : 'invoice.balance_due'))}</td><td class="num">${money(summary.balanceDue)}</td></tr>` : ''}</tbody></table>`
			: '';
	const internal =
		options.kind === 'internal'
			? `<div class="legal"><h2>${esc(t('invoice.internal'))}</h2><p>${esc(t('invoice.status', { status: ctx.statusLabel(order.status) }))}</p>${order.notes?.internal ? `<p>${esc(order.notes.internal)}</p>` : ''}${(order.risk?.flags ?? []).length > 0 ? `<p>${esc(t('invoice.risk', { flags: order.risk.flags.join(', ') }))}</p>` : ''}${order.source ? `<p>${esc(t('invoice.source', { source: order.source }))}</p>` : ''}</div>`
			: '';
	const body = `<header><div><h1>${esc(title)}</h1><p>${esc(t('invoice.number', { number: options.invoiceNumber }))}</p><p>${esc(t('invoice.order', { number: order.number }))}</p></div>${brandBlock(ctx)}</header><div class="grid"><div><h2>${esc(t('invoice.billed_to'))}</h2><p><strong>${esc(recipient.name || t('invoice.customer'))}</strong></p>${recipient.phone ? `<p>${esc(recipient.phone)}</p>` : ''}${recipient.email ? `<p>${esc(recipient.email)}</p>` : ''}${recipient.line ? `<p>${esc(recipient.line)}</p>` : ''}</div><div class="end"><h2>${esc(t('invoice.details'))}</h2><p>${esc(t('invoice.date', { date: formatDate(order.placedAt, ctx) }))}</p><p>${esc(t('invoice.payment', { method: ctx.methodLabel(order.payment?.method) }))}</p><p>${esc(t('invoice.delivery', { method: ctx.deliveryLabel(order.delivery?.method) }))}</p></div></div><table><thead><tr><th>${esc(t('invoice.item'))}</th>${warrantyColumn ? `<th>${esc(t('invoice.warranty'))}</th>` : ''}<th class="num">${esc(t('invoice.qty'))}</th><th class="num">${esc(t('invoice.unit_price'))}</th><th class="num">${esc(t('invoice.line_total'))}</th></tr></thead><tbody>${rows}</tbody></table><table class="totals"><tbody>${totalsRows}</tbody></table>${payments}${internal}${ctx.brand.legalText ? `<div class="legal small">${esc(ctx.brand.legalText)}</div>` : ''}${ctx.brand.footerText ? `<p class="small end">${esc(ctx.brand.footerText)}</p>` : ''}`;
	return page({ title: `${title} ${options.invoiceNumber}`, lang: ctx.locale, body });
};

/**
 * @typedef {object} SlipOptions
 * @property {boolean} showPrices
 * @property {boolean} showCollect
 * @property {boolean} serialSlots
 * @property {boolean} signature
 */

/**
 * One serial slot per unit: captured serials first, blanks for the rest.
 * @param {{ quantity: number, serials?: string[] }} line
 * @returns {Array<string | null>}
 */
export const serialSlots = (line) => Array.from({ length: Math.max(0, line.quantity) }, (_, i) => line.serials?.[i] ?? null);

/**
 * Packing slips, one page per order.
 * @param {ReadonlyArray<Record<string, any>>} orders
 * @param {DocContext} ctx
 * @param {SlipOptions} options
 */
export const packingSlipsHtml = (orders, ctx, options) => {
	const { t } = ctx;
	const sections = orders.map((order) => {
		const money = (/** @type {number} */ amount) => esc(formatMoney(amount, order.currency, ctx.locale));
		const address = order.shipping ?? null;
		const units = (order.lines ?? []).reduce((/** @type {number} */ sum, /** @type {any} */ l) => sum + l.quantity, 0);
		const due = summarize(order).balanceDue;
		const collect = options.showCollect
			? `<div class="box">${ctx.payOnDelivery(order) && due > 0 ? `<strong>${esc(t('print.collect'))}</strong><span class="big">${money(due)}</span>` : `<strong>${esc(t('print.prepaid'))}</strong>`}</div>`
			: '';
		const rows = (order.lines ?? [])
			.map(
				(/** @type {any} */ line) =>
					`<tr><td><strong>${esc(line.title)}</strong>${[line.variantTitle, line.sku].filter(Boolean).length > 0 ? `<p class="small">${esc([line.variantTitle, line.sku].filter(Boolean).join(' · '))}</p>` : ''}</td><td class="num big">${line.quantity}</td>${options.showPrices ? `<td class="num">${money(line.totalAmount)}</td>` : ''}${
						options.serialSlots
							? `<td>${serialSlots(line)
									.map(
										(serial, index) =>
											`<p class="small">${index + 1}. ${serial ? `<span class="mono">${esc(serial)}</span>` : '<span class="slot"></span>'}</p>`,
									)
									.join('')}</td>`
							: ''
					}</tr>`,
			)
			.join('');
		const fulfilment = order.fulfilment ?? {};
		return `<section class="page"><header><div><h2>${esc(t('print.packing_slip'))}</h2><p class="big mono">${esc(order.number)}</p><p>${esc(t('invoice.date', { date: formatDate(order.placedAt, ctx) }))}</p></div><div class="brand"><p><strong>${esc(ctx.brand.name)}</strong></p>${ctx.brand.contactLines[0] ? `<p>${esc(ctx.brand.contactLines[0])}</p>` : ''}</div></header><div class="grid"><div><h2>${esc(t('print.deliver_to'))}</h2><p class="big">${esc(address?.name ?? order.customer?.name ?? t('invoice.customer'))}</p>${(address?.phone ?? order.customer?.phone) ? `<p class="mono">${esc(address?.phone ?? order.customer?.phone)}</p>` : ''}<p>${esc(addressLine(address))}</p></div><div class="end"><h2>${esc(t('print.shipping'))}</h2><p>${esc(ctx.deliveryLabel(order.delivery?.method))}</p>${fulfilment.carrierName ? `<p>${esc(fulfilment.carrierName)}${fulfilment.serviceLevel ? ` · ${esc(fulfilment.serviceLevel)}` : ''}</p>` : ''}${fulfilment.trackingNumber ? `<p class="mono">${esc(fulfilment.trackingNumber)}</p>` : ''}<p>${esc(ctx.methodLabel(order.payment?.method))}</p></div></div>${collect}<table><thead><tr><th>${esc(t('invoice.item'))}</th><th class="num">${esc(t('invoice.qty'))}</th>${options.showPrices ? `<th class="num">${esc(t('invoice.line_total'))}</th>` : ''}${options.serialSlots ? `<th>${esc(t('print.serials'))}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table>${order.notes?.customer ? `<p class="small">${esc(t('print.customer_note', { note: order.notes.customer }))}</p>` : ''}<p class="small">${esc(t('print.units', { count: units }))}${options.signature ? ` · ${esc(t('print.packed_by'))} <span class="slot"></span>` : ''}</p></section>`;
	});
	const body = sections.length > 0 ? sections.join('') : `<p>${esc(t('print.none'))}</p>`;
	return page({ title: t('print.packing_slips'), lang: ctx.locale, body });
};

/**
 * Lines of the selected orders aggregated by what is picked (variant, SKU or item and title).
 * @param {ReadonlyArray<Record<string, any>>} orders
 * @param {'title' | 'sku'} sort
 */
export const pickRows = (orders, sort) => {
	/** @type {Map<string, { key: string, title: string, variantTitle: string, sku: string, quantity: number, orders: string[] }>} */
	const rows = new Map();
	for (const order of orders)
		for (const line of order.lines ?? []) {
			const key = line.variantId ?? line.sku ?? `${line.itemId ?? ''}|${line.title}|${line.variantTitle ?? ''}`;
			const row = rows.get(key) ?? {
				key,
				title: line.title,
				variantTitle: line.variantTitle ?? '',
				sku: line.sku ?? '',
				quantity: 0,
				orders: /** @type {string[]} */ ([]),
			};
			row.quantity += line.quantity;
			if (!row.orders.includes(order.number)) row.orders.push(order.number);
			rows.set(key, row);
		}
	return [...rows.values()].sort((a, b) =>
		sort === 'sku'
			? a.sku.localeCompare(b.sku) || a.title.localeCompare(b.title)
			: a.title.localeCompare(b.title) || a.variantTitle.localeCompare(b.variantTitle),
	);
};

/**
 * A pick list across orders.
 * @param {ReadonlyArray<Record<string, any>>} orders
 * @param {DocContext} ctx
 * @param {{ sort: 'title' | 'sku' }} options
 */
export const pickListHtml = (orders, ctx, options) => {
	const { t } = ctx;
	const rows = pickRows(orders, options.sort);
	const units = rows.reduce((sum, row) => sum + row.quantity, 0);
	const table =
		rows.length === 0
			? `<p>${esc(t('print.none'))}</p>`
			: `<table><thead><tr><th></th><th>${esc(t('invoice.item'))}</th><th>${esc(t('print.variant'))}</th><th class="num">${esc(t('invoice.qty'))}</th><th>${esc(t('print.orders'))}</th></tr></thead><tbody>${rows
					.map(
						(row) =>
							`<tr><td><span class="check"></span></td><td><strong>${esc(row.title)}</strong>${row.sku ? `<p class="small mono">${esc(row.sku)}</p>` : ''}</td><td>${esc(row.variantTitle)}</td><td class="num big">${row.quantity}</td><td class="small mono">${esc(row.orders.join(', '))}</td></tr>`,
					)
					.join('')}</tbody></table>`;
	const body = `<header><div><h1>${esc(t('print.pick_list'))}</h1><p>${esc(t('print.summary', { orders: orders.length, lines: rows.length, units }))}</p></div><div class="brand"><p>${esc(t('print.printed', { date: formatDate(new Date(ctx.now ?? 0), ctx, true) }))}</p></div></header>${table}`;
	return page({ title: t('print.pick_list'), lang: ctx.locale, body });
};
