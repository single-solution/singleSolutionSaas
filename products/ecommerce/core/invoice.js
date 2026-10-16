/**
 * Invoices, packing slips and pick lists (PLAN 0.8.8: invoices and packing slips with the serial numbers on each line;
 * E35) as printable, self-contained HTML: inline `<style>`, no script, every value HTML-escaped. Everything printed
 * comes from the order snapshot, business.json (name, address, email, phone) and the `invoices` settings, whose texts
 * the merchant edits (`INVOICE_TEXTS` are the English defaults); payment methods are named as the website's
 * `payment_methods` list names them (E2, E16) and payment states are the website's texts (`orders.payment.*`; decision
 * 10), so each word lives in one place. The invoice's line columns
 * are the merchant's (`columns`, E26): item, SKU, quantity, unit price, discount, tax and amount, and any product or
 * variant field by `field.<slug>` (an HS code, a material …); the seller details under the business and the footer take
 * `{business}`, `{email}`, `{phone}`, `{address}`, `{number}`, `{date}` and `{field.<slug>}` of the order's and its
 * customer's fields ({@link fieldPlaceholders}; a tax number is typed there). The invoice number is the order number; the invoice
 * shows the fee, the role discount and points apart, the payments and refunds (staff names on the staff copy only) and
 * the cash due on delivery. The packing slip has no prices; the batch of slips adds the cash to collect and empty slots
 * for serial numbers still to be written. The pick list adds up the units per variant. Money and dates follow the
 * website's Format, dates in the business time zone (PLAN 0.8.10 K7, K8). No I/O.
 * @module
 */
import { addressLines as placeLines, countryName } from '@ss/contracts/address';
import { formatDate, formatMoney } from '@ss/contracts/format';
import { durationText } from './durations.js';
import { fieldPlaceholders, fieldValuesShown, unitsShown } from './fields.js';
import { isSlug } from './catalog.js';
import { WAITING_ROLES } from './flow.js';
import { placedGross, quantityLabel } from './measure.js';
import { orderMoney } from './orders.js';
import { PAY_LATER_KINDS, VIA_PAYMENTS } from './payment-methods.js';

/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {{ name: string, email: string | null, phone: string | null, address: string | null }} BusinessLike */
/**
 * The merchant fields a document may print (PLAN 0.8.10 dynamic model §2): the unit, order, customer, product and
 * variant fields, the values of the printed orders' units (order id → serial → values by unit field), of their
 * customers (customer id → values) and of their lines' products (product id → its specs and each variant's attributes,
 * for the invoice's field columns, E26). A unit, order or customer field prints where its `show` says (`invoice`,
 * `packingSlip`); a product or variant field only as a column the merchant chose.
 * @typedef {{ list: ReadonlyArray<import('./model.js').AttributeRecord>,
 *   units: ReadonlyMap<string, ReadonlyMap<string, Record<string, string[]>>>,
 *   customers: ReadonlyMap<string, Record<string, import('./fields.js').FieldValue>>,
 *   products?: ReadonlyMap<string, { specs: Record<string, import('./fields.js').FieldValue>,
 *     variants: ReadonlyMap<string, Record<string, import('./fields.js').FieldValue>> }> }} DocumentFields
 */

/**
 * The order's and its customer's field values a document prints (each field shown on it), as `Name: value` lines.
 * @param {OrderRecord} order @param {DocumentContext} context @param {'invoice' | 'packingSlip'} place
 */
const fieldLines = (order, context, place) =>
	[
		...fieldValuesShown(
			order.fields ?? {},
			context.fields.list.filter((field) => field.on === 'order'),
			place,
		),
		...fieldValuesShown(
			context.fields.customers.get(order.customer.customerId ?? '') ?? {},
			context.fields.list.filter((field) => field.on === 'customer'),
			place,
		),
	]
		.map((entry) => `<p class="small">${esc(`${entry.name}: ${entry.label}`)}</p>`)
		.join('');
/**
 * What a document is printed with: the business, the texts, the payment words of the website's texts
 * ({@link documentWordsOf}), the invoice's columns ({@link invoiceColumnsOf}), the website's Format and business time
 * zone, and the merchant fields.
 * @typedef {{ business: BusinessLike, texts: InvoiceTexts, words: DocumentWords, columns: string[],
 *   format: import('@ss/contracts/format').Format, timeZone: string, fields: DocumentFields }} DocumentContext
 */

/**
 * The payment words a document prints, from the website's texts (decision 10): each method's
 * (its name in the `payment_methods` list, by key; `online`: the first method paid online, which names an advance
 * Payments took, E16) and each payment state's (`orders.payment.<state>`).
 * @typedef {{ methods: Readonly<Record<string, string>>, online: string, states: Readonly<Record<string, string>> }}
 *   DocumentWords
 */

/**
 * The payment words of a website: its payment methods' names and its texts' payment states.
 * @param {Readonly<Record<string, string>>} texts
 * @param {ReadonlyArray<{ key: string, name: string, kind: string }>} [methods] the `payment_methods` list
 * @returns {DocumentWords}
 */
export const documentWordsOf = (texts, methods = []) => {
	/** @param {string} prefix */
	const under = (prefix) =>
		Object.fromEntries(
			Object.entries(texts)
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, value]) => [key.slice(prefix.length), value]),
		);
	return {
		methods: Object.fromEntries(methods.map((method) => [method.key, method.name])),
		online: methods.find((method) => method.kind === 'gateway')?.name ?? '',
		states: under('orders.payment.'),
	};
};

/** The line columns an invoice may have besides fields (`field.<slug>`), and those of a new website. */
export const INVOICE_COLUMNS = Object.freeze(['item', 'sku', 'quantity', 'unitPrice', 'discount', 'tax', 'amount']);
export const DEFAULT_COLUMNS = Object.freeze(['item', 'quantity', 'unitPrice', 'amount']);
/**
 * The field slug a column names (`field.<slug>`), or null.
 * @param {string} column
 */
const fieldSlugOf = (column) => (column.startsWith('field.') && isSlug(column.slice(6)) ? column.slice(6) : null);

/**
 * The invoice's line columns from the `invoices` setting `columns`, in its order (each once; the unknown left out; the
 * defaults when none is left).
 * @param {Record<string, unknown>} settings
 * @returns {string[]}
 */
export const invoiceColumnsOf = (settings) => {
	const asked = Array.isArray(settings.columns) ? settings.columns : [];
	const columns = [
		...new Set(
			asked.filter(
				(column) => typeof column === 'string' && (INVOICE_COLUMNS.includes(column) || fieldSlugOf(column) !== null),
			),
		),
	];
	return columns.length > 0 ? columns : [...DEFAULT_COLUMNS];
};

/**
 * Whether a shopper may read their order's invoice (E35; `GET /v1/shop/orders/:id/invoice` and the order's `invoice`):
 * with the invoices setting `shopperFrom: confirmed`, not while the order waits nor once it is canceled; else always.
 * @param {Pick<OrderRecord, 'role'>} order
 * @param {Record<string, unknown>} settings the invoices settings
 */
export const shopperInvoiceReady = (order, settings) =>
	settings.shopperFrom !== 'confirmed' || !(WAITING_ROLES.includes(order.role) || order.role === 'cancelled');

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
	labelWarranty: 'Warranty: {time}',
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
	labelFee: 'Cash handling',
	labelRoleDiscount: 'Member discount',
	labelPoints: 'Points ({points})',
	labelCashDue: 'Cash due on delivery',
	labelPayments: 'Payments',
	labelRefunds: 'Refunds',
	pickListTitle: 'Pick list',
	sellerDetails: '',
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
				typeof settings[key] === 'string' && (settings[key] !== '' || key === 'footer' || key === 'sellerDetails')
					? settings[key]
					: fallback,
			]),
		)
	);

/**
 * The day an order was placed, by the Format in the business time zone.
 * @param {OrderRecord} order
 * @param {DocumentContext} context
 */
const placedOn = (order, { format, timeZone }) => formatDate(order.placedAt, format, { timeZone, style: 'date' });

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
.entries td { border-bottom: 1px dotted; }
.due { border: 2px solid; display: inline-block; font-size: 15px; font-weight: 700; margin-bottom: 16px; padding: 6px 10px; }
.slot { border-bottom: 1px solid; display: inline-block; height: 20px; margin: 4px 12px 0 0; min-width: 180px; }
.sheet + .sheet { break-before: page; border-top: 2px dashed; margin-top: 32px; padding-top: 24px; }
@media print { body { padding: 0; } .sheet + .sheet { border-top: 0; margin-top: 0; padding-top: 0; } }
`;

/**
 * A complete HTML document.
 * @param {string} title
 * @param {string} body
 */
const page = (title, body) =>
	`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

/** @param {BusinessLike} business @param {string} [seller] the seller details, filled and escaped (E26) */
const businessBlock = (business, seller = '') =>
	`<div class="end"><p><strong>${esc(business.name)}</strong></p>${[business.address, business.email, business.phone]
		.filter(Boolean)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('')}${seller}</div>`;

/**
 * The delivery address as its country writes it (`@ss/contracts/address`), the country by name.
 * @param {NonNullable<OrderRecord['address']>} address
 */
const addressBlock = (address) =>
	[address.name, address.phone, ...placeLines(address), countryName(address.country)]
		.filter(Boolean)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('');

/**
 * What each line says under its name: the variant, SKU, grade, warranty, and its units' numbers the document prints
 * (plain serial numbers, and each unit field shown on it with its values).
 * @param {OrderRecord} order
 * @param {OrderRecord['lines'][number]} line
 * @param {DocumentContext} context
 * @param {'invoice' | 'packingSlip'} place
 */
const lineDetail = (order, line, context, place) => {
	const t = context.texts;
	const parts = [
		line.variantName,
		line.sku && !(place === 'invoice' && context.columns.includes('sku')) ? `${t.labelSku} ${line.sku}` : '',
		line.gradeLabel ? `${t.labelGrade}: ${line.gradeLabel}` : '',
		// the warranty kept at placement (E12)
		line.warrantyTime && line.warrantyTime.amount > 0
			? t.labelWarranty.replaceAll('{time}', durationText(line.warrantyTime, context.format.locale))
			: '',
	].filter(Boolean);
	const detail = parts.length > 0 ? `<p class="small">${esc(parts.join(' · '))}</p>` : '';
	const units = unitsShown(
		line.serials,
		context.fields.units.get(order.id) ?? new Map(),
		context.fields.list.filter((field) => field.on === 'unit'),
		place,
	);
	const serials =
		units.serials.length > 0 ? `<p class="small mono">${esc(`${t.labelSerials}: ${units.serials.join(', ')}`)}</p>` : '';
	const values = units.values
		.map((entry) => `<p class="small mono">${esc(`${entry.name}: ${entry.values.join(', ')}`)}</p>`)
		.join('');
	return `${detail}${serials}${values}`;
};

/**
 * How a payment or refund entry was made (E26, E16), by the names of the website's payment methods: a recorded way is
 * its method's name (`other` has none and shows its reference only, never another method's name); money Payments took
 * or gave back reads as the order's own method, or, for the advance of a method paid later, as the method paid online.
 * @param {string} way @param {OrderRecord} order @param {DocumentWords} words
 */
const wayText = (way, order, words) =>
	way === VIA_PAYMENTS
		? PAY_LATER_KINDS.includes(order.payment.kind)
			? words.online
			: (words.methods[order.payment.method] ?? '')
		: (words.methods[way] ?? '');

/**
 * A text with its `{placeholders}` filled ({business}, {email}, {phone}, {address}, {number}, {date} and
 * `{field.<slug>}`); a placeholder it does not know stays as written.
 * @param {string} text @param {Readonly<Record<string, string>>} values
 */
const filled = (text, values) =>
	text.replace(/\{([^{}\s]{1,130})\}/gu, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));

/**
 * The `{field.<slug>}` values of an order (E26, E28): its own fields, its customer's, and its lines' — each product or
 * variant field and each unit field with the lines' values, each once, joined with `, `.
 * @param {OrderRecord} order @param {DocumentFields} fields
 * @returns {Record<string, string>}
 */
export const orderPlaceholders = (order, fields) => {
	/** @type {Map<string, Set<string>>} */
	const lines = new Map();
	const add = (/** @type {string} */ key, /** @type {string} */ label) => {
		if (label !== '') lines.set(key, (lines.get(key) ?? new Set()).add(label));
	};
	const lineFields = fields.list.filter((field) => field.on === 'product' || field.on === 'variant');
	const unitFields = fields.list.filter((field) => field.on === 'unit');
	for (const line of order.lines) {
		const product = fields.products?.get(line.productId);
		for (const field of lineFields) {
			const values = field.on === 'variant' ? product?.variants.get(line.variantId) : product?.specs;
			add(`field.${field.slug}`, fieldValuesShown(values ?? {}, [field], null)[0]?.label ?? '');
		}
		const units = fields.units.get(order.id);
		for (const field of unitFields)
			for (const serial of line.serials)
				for (const value of units?.get(serial)?.[field.id] ?? []) add(`field.${field.slug}`, value);
	}
	return {
		...Object.fromEntries([...lines].map(([key, labels]) => [key, [...labels].join(', ')])),
		...fieldPlaceholders([
			{ values: order.fields ?? {}, fields: fields.list.filter((field) => field.on === 'order') },
			{
				values: fields.customers.get(order.customer.customerId ?? '') ?? {},
				fields: fields.list.filter((field) => field.on === 'customer'),
			},
		]),
	};
};

/**
 * What the seller details and the footer of an order's documents may name (E26): the business's name and contacts,
 * the order number and day, and the order's, its customer's and its lines' fields ({@link orderPlaceholders}).
 * @param {OrderRecord} order @param {DocumentContext} context
 * @returns {Record<string, string>}
 */
const documentValues = (order, context) => ({
	business: context.business.name,
	email: context.business.email ?? '',
	phone: context.business.phone ?? '',
	address: context.business.address ?? '',
	number: order.number,
	date: placedOn(order, context),
	...orderPlaceholders(order, context.fields),
});

/**
 * The seller details printed under the business, and the footer, filled ('' each when not written).
 * @param {OrderRecord} order @param {DocumentContext} context
 */
const sellerAndFooter = (order, context) => {
	const values = documentValues(order, context);
	const seller = context.texts.sellerDetails.trim();
	const footer = context.texts.footer.trim();
	return {
		seller: seller ? `<p class="small seller">${esc(filled(seller, values))}</p>` : '',
		footer: footer ? `<div class="footer small">${esc(filled(footer, values))}</div>` : '',
	};
};

/**
 * A line's value of a product or variant field (`field.<slug>` column, E26): the variant's own, else the product's;
 * '' without one.
 * @param {OrderRecord['lines'][number]} line @param {string} slug @param {DocumentContext} context
 */
const lineFieldValue = (line, slug, context) => {
	const field = context.fields.list.find((entry) => entry.slug === slug && (entry.on === 'product' || entry.on === 'variant'));
	const product = context.fields.products?.get(line.productId);
	if (!field || !product) return '';
	const values = field.on === 'variant' ? (product.variants.get(line.variantId) ?? {}) : product.specs;
	return fieldValuesShown(values, [field], null)[0]?.label ?? '';
};

/**
 * The header and the cell of one invoice column for a line.
 * @param {string} column @param {DocumentContext} context
 * @returns {{ head: (t: InvoiceTexts) => string, cell: (line: OrderRecord['lines'][number], money: (amount: number) => string,
 *   order: OrderRecord) => string, num: boolean }}
 */
const columnOf = (column, context) => {
	const slug = fieldSlugOf(column);
	if (slug !== null) {
		const field = context.fields.list.find((entry) => entry.slug === slug);
		return { head: () => field?.name ?? slug, cell: (line) => esc(lineFieldValue(line, slug, context)), num: false };
	}
	switch (column) {
		case 'sku':
			return { head: (t) => t.labelSku, cell: (line) => `<span class="mono">${esc(line.sku)}</span>`, num: false };
		case 'quantity':
			return { head: (t) => t.labelQuantity, cell: (line) => esc(quantityLabel(line.quantity, line.measure)), num: true };
		case 'unitPrice':
			return {
				head: (t) => t.labelUnitPrice,
				cell: (line, money) => `${money(line.unitPrice)}${line.measure ? ` / ${esc(line.measure.unit)}` : ''}`,
				num: true,
			};
		case 'discount':
			return {
				head: (t) => t.labelDiscount,
				cell: (line, money) => (line.discount > 0 ? `−${money(line.discount)}` : ''),
				num: true,
			};
		case 'tax':
			return { head: (t) => t.labelTax, cell: (line, money) => (line.tax > 0 ? money(line.tax) : ''), num: true };
		case 'amount':
			return {
				head: (t) => t.labelAmount,
				cell: (line, money, order) => money(placedGross(line, order.totals.taxIncluded)),
				num: true,
			};
		default:
			return {
				head: (t) => t.labelItem,
				cell: (line, _money, order) => `<strong>${esc(line.name)}</strong>${lineDetail(order, line, context, 'invoice')}`,
				num: false,
			};
	}
};

/**
 * What is still owed, counted the one way ({@link orderMoney}): the total less what was paid, nothing once the order is
 * closed (a canceled order never shows cash to collect).
 * @param {OrderRecord} order
 */
const dueOf = (order) => orderMoney(order).due;

/**
 * The money the courier still collects: what is owed on an order paid on delivery, not yet paid (E35).
 * @param {OrderRecord} order
 */
export const cashToCollect = (order) =>
	order.payment.kind === 'on_delivery' && (order.payment.state === 'unpaid' || order.payment.state === 'pending')
		? dueOf(order)
		: 0;

/**
 * Who prints a document: staff (and the merchant's server) see who recorded each payment; the shopper does not.
 * @typedef {{ shopper?: boolean }} InvoiceOptions
 */

/**
 * The payments or the refunds of an order, each with its day, method, reference and amount (E26); staff also see the
 * note and who recorded it.
 * @param {string} title
 * @param {Array<import('./model.js').OrderPaymentEntry | import('./model.js').OrderRefundEntry>} entries
 * @param {OrderRecord} order
 * @param {DocumentContext} context
 * @param {(amount: number) => string} money
 * @param {boolean} shopper
 */
const entriesBlock = (title, entries, order, context, money, shopper) => {
	if (entries.length === 0) return '';
	const { format, timeZone } = context;
	const rows = entries
		.map((entry) => {
			const detail = [
				wayText(entry.method, order, context.words),
				entry.reference,
				...(shopper ? [] : [entry.note, entry.by?.name ?? '']),
			]
				.filter(Boolean)
				.join(' · ');
			return `<tr><td>${esc(formatDate(entry.at, format, { timeZone, style: 'date' }))}</td><td>${esc(detail)}</td><td class="num">${money(entry.amount)}</td></tr>`;
		})
		.join('');
	return `<h2>${esc(title)}</h2><table class="entries small"><tbody>${rows}</tbody></table>`;
};

/**
 * The invoice of an order.
 * @param {OrderRecord} order
 * @param {DocumentContext} context
 * @param {InvoiceOptions} [options]
 */
export const invoiceHtml = (order, context, { shopper = false } = {}) => {
	const { business, texts: t, format } = context;
	const { currency } = order.totals;
	const money = (/** @type {number} */ amount) => esc(formatMoney(amount, currency, format));
	// the merchant's columns, in their order (E26)
	const columns = context.columns.map((column) => columnOf(column, context));
	const head = columns.map((column) => `<th${column.num ? ' class="num"' : ''}>${esc(column.head(t))}</th>`).join('');
	const rows = order.lines
		.map(
			(line) =>
				`<tr>${columns.map((column) => `<td${column.num ? ' class="num"' : ''}>${column.cell(line, money, order)}</td>`).join('')}</tr>`,
		)
		.join('');
	const { subtotal, discount, delivery, tax, total, taxIncluded } = order.totals;
	const fee = order.totals.fee ?? 0;
	const roleDiscount = order.totals.roleDiscount ?? 0;
	const { pointsValue, pointsRedeemed, role } = order.promotions;
	// `discount` holds the role discount (E19) and the points (E20) too: they are printed apart
	const offers = Math.max(0, discount - roleDiscount - pointsValue);
	/** @type {Array<[string, string, boolean?]>} */
	const totals = [[t.labelSubtotal, money(subtotal)]];
	if (offers > 0) totals.push([t.labelDiscount, `−${money(offers)}`]);
	if (roleDiscount > 0) totals.push([role?.label || t.labelRoleDiscount, `−${money(roleDiscount)}`]);
	if (pointsValue > 0) totals.push([t.labelPoints.replaceAll('{points}', String(pointsRedeemed)), `−${money(pointsValue)}`]);
	// the delivery rate the shopper picked, by its name then (E5)
	const rateName = order.delivery.rateName ?? '';
	if (delivery > 0) totals.push([rateName ? `${t.labelDelivery} (${rateName})` : t.labelDelivery, money(delivery)]);
	if (fee > 0) totals.push([t.labelFee, money(fee)]);
	if (tax > 0) totals.push([taxIncluded ? t.labelTaxIncluded : t.labelTax, money(tax)]);
	totals.push([t.labelTotal, money(total), true]);
	const { payment } = order;
	if (payment.paid > 0) totals.push([t.labelPaid, money(payment.paid)]);
	if (payment.refunded > 0) totals.push([t.labelRefunded, `−${money(payment.refunded)}`]);
	const due = dueOf(order);
	if (due > 0 && payment.paid > 0) totals.push([t.labelBalance, money(due)]);
	const cash = cashToCollect(order);
	if (cash > 0) totals.push([t.labelCashDue, money(cash), true]);
	const totalsRows = totals
		.map(
			([label, value, grand]) =>
				`<tr${grand ? ' class="grand"' : ''}><td>${esc(label)}</td><td class="num">${value}</td></tr>`,
		)
		.join('');
	// the website's own words for the method and the state (decision 10)
	const paymentWords = [context.words.methods[payment.method] ?? '', context.words.states[payment.state] ?? '']
		.filter(Boolean)
		.join(' · ');
	const { seller, footer } = sellerAndFooter(order, context);
	const entries =
		entriesBlock(t.labelPayments, order.payments ?? [], order, context, money, shopper) +
		entriesBlock(t.labelRefunds, order.refunds ?? [], order, context, money, shopper);
	const customer = order.customer;
	const billed = [customer.name, customer.email, customer.phone]
		.filter(Boolean)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('');
	const rate = order.delivery.rateName ? `<p class="small">${esc(order.delivery.rateName)}</p>` : '';
	const shipTo = order.address
		? `<div><h2>${esc(t.labelShipTo)}</h2>${addressBlock(order.address)}${rate}</div>`
		: order.delivery.method === 'pickup'
			? `<div><h2>${esc(t.labelShipTo)}</h2><p>${esc(t.labelPickup)}</p>${rate}</div>`
			: '<div></div>';
	const body = `<header><div><h1>${esc(t.title)}</h1><p>${esc(t.labelNumber)} <strong class="mono">${esc(order.number)}</strong></p><p>${esc(t.labelDate)} ${esc(placedOn(order, context))}</p></div>${businessBlock(business, seller)}</header><div class="grid"><div><h2>${esc(t.labelBilledTo)}</h2>${billed}${fieldLines(order, context, 'invoice')}</div>${shipTo}</div><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table><table class="totals"><tbody>${totalsRows}</tbody></table>${paymentWords ? `<p>${esc(t.labelPayment)}: ${esc(paymentWords)}</p>` : ''}${entries}${footer}`;
	return page(`${t.title} ${order.number}`, body);
};

/**
 * One packing slip (no prices). In a batch (E35) it also shows the cash to collect on delivery and an empty slot for
 * each serial number a line whose item type numbers its units still lacks.
 * @param {OrderRecord} order
 * @param {DocumentContext} context
 * @param {{ numbered: ReadonlySet<string> } | null} batch ids of the products whose units are numbered, in a batch
 */
const slipBody = (order, context, batch) => {
	const { business, texts: t, format } = context;
	const slots = (/** @type {OrderRecord['lines'][number]} */ line) => {
		const missing = batch && batch.numbered.has(line.productId) ? Math.max(0, line.quantity - line.serials.length) : 0;
		return missing > 0 ? `<p class="small">${esc(t.labelSerials)}: ${'<span class="slot"></span>'.repeat(missing)}</p>` : '';
	};
	const rows = order.lines
		.filter((line) => line.kind === 'physical')
		.map(
			(line) =>
				`<tr><td><strong>${esc(line.name)}</strong>${lineDetail(order, line, context, 'packingSlip')}${slots(line)}</td><td class="num">${esc(quantityLabel(line.quantity, line.measure))}</td></tr>`,
		)
		.join('');
	const shipTo = order.address
		? addressBlock(order.address)
		: `<p>${esc(order.delivery.method === 'pickup' ? t.labelPickup : order.customer.name)}</p>`;
	const shipment = order.shipment
		? `<p>${esc(t.labelCourier)}: ${esc(order.shipment.courier)}</p><p>${esc(t.labelTracking)}: <span class="mono">${esc(order.shipment.trackingNumber)}</span></p>`
		: '';
	const cash = batch ? cashToCollect(order) : 0;
	const collect =
		cash > 0 ? `<p class="due">${esc(t.labelCashDue)}: ${esc(formatMoney(cash, order.totals.currency, format))}</p>` : '';
	const note = order.note ? `<p class="small">${esc(t.labelNote)}: ${esc(order.note)}</p>` : '';
	const { seller, footer } = sellerAndFooter(order, context);
	return `<header><div><h1>${esc(t.packingSlipTitle)}</h1><p><strong class="mono">${esc(order.number)}</strong></p><p>${esc(t.labelDate)} ${esc(placedOn(order, context))}</p></div>${businessBlock(business, seller)}</header><div class="grid"><div><h2>${esc(t.labelShipTo)}</h2>${shipTo}${fieldLines(order, context, 'packingSlip')}</div><div class="end">${shipment}</div></div>${collect}<table><thead><tr><th>${esc(t.labelItem)}</th><th class="num">${esc(t.labelQuantity)}</th></tr></thead><tbody>${rows}</tbody></table>${note}${footer}`;
};

/**
 * The packing slip of an order (no prices).
 * @param {OrderRecord} order
 * @param {DocumentContext} context
 */
export const packingSlipHtml = (order, context) =>
	page(`${context.texts.packingSlipTitle} ${order.number}`, slipBody(order, context, null));

/**
 * The packing slips of several orders as one document, one slip per printed page (E35).
 * @param {OrderRecord[]} orders
 * @param {DocumentContext} context
 * @param {ReadonlySet<string>} numbered ids of the orders' products whose item type numbers their units
 */
export const packingSlipsHtml = (orders, context, numbered) =>
	page(
		context.texts.packingSlipTitle,
		orders.map((order) => `<section class="sheet">${slipBody(order, context, { numbered })}</section>`).join(''),
	);

/**
 * The units to pick for several orders: their physical lines added up per variant (E35), by name, with the orders'
 * numbers.
 * @param {OrderRecord[]} orders
 * @param {DocumentContext} context
 */
export const pickListHtml = (orders, context) => {
	const { business, texts: t } = context;
	/** @type {Map<string, { line: OrderRecord['lines'][number], quantity: number }>} */
	const variants = new Map();
	for (const order of orders)
		for (const line of order.lines) {
			if (line.kind !== 'physical') continue;
			const known = variants.get(line.variantId);
			if (known) known.quantity += line.quantity;
			else variants.set(line.variantId, { line, quantity: line.quantity });
		}
	const rows = [...variants.values()]
		.sort((a, b) => a.line.name.localeCompare(b.line.name) || a.line.variantName.localeCompare(b.line.variantName))
		.map(({ line, quantity }) => {
			const detail = [
				line.variantName,
				line.sku ? `${t.labelSku} ${line.sku}` : '',
				line.gradeLabel ? `${t.labelGrade}: ${line.gradeLabel}` : '',
			]
				.filter(Boolean)
				.join(' · ');
			return `<tr><td><strong>${esc(line.name)}</strong>${detail ? `<p class="small">${esc(detail)}</p>` : ''}</td><td class="num">${esc(quantityLabel(quantity, line.measure))}</td></tr>`;
		})
		.join('');
	const numbers = orders.map((order) => order.number).join(', ');
	const body = `<header><div><h1>${esc(t.pickListTitle)}</h1><p class="small mono">${esc(numbers)}</p></div>${businessBlock(business)}</header><table><thead><tr><th>${esc(t.labelItem)}</th><th class="num">${esc(t.labelQuantity)}</th></tr></thead><tbody>${rows}</tbody></table>`;
	return page(t.pickListTitle, body);
};
