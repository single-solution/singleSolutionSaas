/**
 * Documents service: invoices and receipts (metered per render, `render`), packing slips and pick lists — printable
 * HTML rendered on the server from the order snapshot with the merchant's business details and the website's language
 * and time zone. Invoice numbers come from a gap-free counter of their own (or the order number), given once at the
 * first render and kept on the order.
 */
import { invoiceHtml, packingSlipsHtml, pickListHtml } from '../core/documents.js';
import { formatNumber } from '../core/orders.js';
import { docContext } from './context.js';

/**
 * @param {import('./context.js').Deps} deps
 */
export const createDocuments = (deps) => {
	/**
	 * The order's invoice number (given on first use).
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @returns {Promise<string>}
	 */
	const invoiceNumberOf = async (site, order) => {
		const config = site.settings.invoices;
		if (config.numbering === 'order') return String(order.number);
		if (order.invoiceNumber) return order.invoiceNumber;
		const number = formatNumber(config.number_prefix, await site.repos.counters.next('invoice'), config.number_padding);
		const changed = await site.repos.orders.change(order.id, { invoiceNumber: null }, { $set: { invoiceNumber: number } });
		if (changed) return number;
		// another render won the race: use its number (the counter value is spent, which only happens on a race)
		return (await site.repos.orders.get(order.id))?.invoiceNumber ?? number;
	};

	/**
	 * Render an invoice (customer or internal) and meter it.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @param {'customer' | 'internal'} kind
	 * @returns {Promise<{ html: string, number: string, title: string }>}
	 */
	const invoice = async (site, order, kind) => {
		const number = await invoiceNumberOf(site, order);
		const config = site.settings.invoices;
		const ctx = docContext(deps, site, kind === 'customer' ? order.lang : null);
		const html = invoiceHtml(order, ctx, {
			kind,
			invoiceNumber: number,
			showWarranty: config.show_warranty,
			showSerials: config.show_serials,
			showSku: config.show_sku,
			showTaxLines: config.show_tax_lines,
			showPayments: config.show_payments,
		});
		await Promise.resolve(
			deps.usage({ websiteId: site.websiteId, unit: 'render', quantity: 1, idempotencyKey: `render:${deps.newId('rnd')}` }),
		).catch(() => undefined);
		return { html, number, title: `${ctx.t(kind === 'internal' ? 'invoice.internal_title' : 'invoice.title')} ${number}` };
	};

	/**
	 * Packing slips for orders.
	 * @param {import('./context.js').Site} site
	 * @param {ReadonlyArray<Record<string, any>>} orders
	 */
	const packingSlips = (site, orders) => {
		const config = site.settings.print;
		return packingSlipsHtml(orders, docContext(deps, site), {
			showPrices: config.slip_show_prices,
			showCollect: config.slip_show_collect,
			serialSlots: config.slip_serial_slots,
			signature: config.slip_signature,
		});
	};

	/**
	 * A pick list across orders.
	 * @param {import('./context.js').Site} site
	 * @param {ReadonlyArray<Record<string, any>>} orders
	 */
	const pickList = (site, orders) => pickListHtml(orders, docContext(deps, site), { sort: site.settings.print.pick_list_sort });

	return Object.freeze({ invoice, packingSlips, pickList, invoiceNumberOf });
};

/** @typedef {ReturnType<typeof createDocuments>} Documents */
