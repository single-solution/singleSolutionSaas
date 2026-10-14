/**
 * Documents for several orders at once (E35): the packing slips of up to {@link MAX_SLIPS} orders as one printable
 * document (with the cash to collect and empty slots for serial numbers still to be written) and the pick list of up
 * to {@link MAX_PICK} orders (the units per variant). The merchant's server asks with its token, the orders widget with
 * a ticket (`orders.read`), as for one order's packing slip (`server/orders.js`). Orders are named by `?ids=` (comma
 * separated); an unknown id is a 404.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { invoiceTexts, packingSlipsHtml, pickListHtml } from '../core/invoice.js';
import { COLLECTIONS } from '../core/model.js';
import { isSerialized } from '../core/orders.js';
import { DOCUMENT_HEADERS } from './orders.js';
import { SERVER_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Packing slips printed together, at most. */
const MAX_SLIPS = 50;
/** Orders on one pick list, at most. */
const MAX_PICK = 100;

const ORDER_ID = /^ord_[A-Za-z0-9_-]{1,64}$/;
const serverLimits = [...SERVER_LIMITS];

/**
 * @param {Product} _product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createOrderDocuments = (_product, service) => {
	/**
	 * The orders of a request's `?ids=`, in the order asked (each once), or a refusal.
	 * @param {Site} s @param {any} ctx @param {number} max
	 * @returns {Promise<OrderRecord[]>}
	 */
	const ordersOf = async (s, ctx, max) => {
		const ids = [
			...new Set(
				(typeof ctx.query.ids === 'string' ? ctx.query.ids : '')
					.split(',')
					.map((/** @type {string} */ id) => id.trim())
					.filter(Boolean),
			),
		];
		if (ids.length === 0 || ids.length > max) throw service.invalid('ids', `List 1–${max} order ids.`);
		if (!ids.every((id) => ORDER_ID.test(id))) throw service.invalid('ids', 'Unknown order id.');
		const found = /** @type {OrderRecord[]} */ (
			await (
				await s.data()
			)
				.collection(COLLECTIONS.orders)
				.find({ websiteId: s.websiteId, id: { $in: ids } }, { projection: { _id: 0 } })
				.toArray()
		);
		const byId = new Map(found.map((order) => [order.id, order]));
		return ids.map((id) => {
			const order = byId.get(id);
			if (!order) throw problem('not_found', 'There is no such order.');
			return order;
		});
	};

	/**
	 * The ids of the orders' products that are serialized (E11): none without Grades and serials.
	 * @param {Site} s @param {OrderRecord[]} orders
	 * @returns {Promise<Set<string>>}
	 */
	const serializedOf = async (s, orders) => {
		if (!s.has('grades_serials')) return new Set();
		const data = await s.data();
		const ids = [
			...new Set(
				orders.flatMap((order) => order.lines.filter((line) => line.kind === 'physical').map((line) => line.productId)),
			),
		];
		const products = await data
			.collection(COLLECTIONS.products)
			.find({ websiteId: s.websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1, serialized: 1, categoryIds: 1 } })
			.toArray();
		const categories = new Map(
			(
				await data
					.collection(COLLECTIONS.categories)
					.find({ websiteId: s.websiteId }, { projection: { _id: 0, id: 1, path: 1, requiresSerial: 1 } })
					.limit(5000)
					.toArray()
			).map((row) => [String(row.id), { path: row.path, requiresSerial: row.requiresSerial }]),
		);
		return new Set(
			products
				.filter((row) => isSerialized({ serialized: row.serialized, categoryIds: row.categoryIds }, categories))
				.map((row) => String(row.id)),
		);
	};

	/**
	 * What a document is printed with.
	 * @param {Site} s
	 * @returns {Promise<import('../core/invoice.js').DocumentContext>}
	 */
	const contextOf = async (s) => {
		const [business, settings, { format, timeZone }] = await Promise.all([s.business(), s.values('invoices'), s.format()]);
		return {
			business: /** @type {import('../core/invoice.js').BusinessLike} */ (business),
			texts: invoiceTexts(settings),
			format,
			timeZone,
		};
	};

	/** @param {any} ctx */
	const packingSlips = async (ctx) => {
		const s = await service.site(ctx);
		const orders = await ordersOf(s, ctx, MAX_SLIPS);
		const [context, serialized] = await Promise.all([contextOf(s), serializedOf(s, orders)]);
		return new Response(packingSlipsHtml(orders, context, serialized), { headers: DOCUMENT_HEADERS });
	};

	/** @param {any} ctx */
	const pickList = async (ctx) => {
		const s = await service.site(ctx);
		const orders = await ordersOf(s, ctx, MAX_PICK);
		return new Response(pickListHtml(orders, await contextOf(s)), { headers: DOCUMENT_HEADERS });
	};

	return {
		routes: [
			defineRoute({
				method: 'GET',
				path: '/v1/orders/packing-slips',
				auth: 'server',
				feature: 'invoices',
				rateLimit: serverLimits,
				handler: packingSlips,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/packing-slips',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: packingSlips,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/pick-list',
				auth: 'server',
				feature: 'invoices',
				rateLimit: serverLimits,
				handler: pickList,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/pick-list',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: pickList,
			}),
		],
	};
};
