/**
 * Documents for several orders at once (E35): the packing slips of up to {@link MAX_SLIPS} orders as one printable
 * document (with the cash to collect and empty slots for serial numbers still to be written) and the pick list of up
 * to {@link MAX_PICK} orders (the units per variant). The merchant's server asks with its token, the orders widget with
 * a ticket (`orders.read`), as for one order's packing slip (`server/orders.js`). Orders are named by `?ids=` (comma
 * separated); an unknown id is a 404.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { unitRulesOf } from '../adapters/catalog-store.js';
import { packingSlipsHtml, pickListHtml } from '../core/invoice.js';
import { COLLECTIONS } from '../core/model.js';
import { ORDER_ID } from '../core/orders.js';
import { DOCUMENT_HEADERS, documentContextOf } from './orders.js';
import { SERVER_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Packing slips printed together, at most. */
const MAX_SLIPS = 50;
/** Orders on one pick list, at most. */
const MAX_PICK = 100;

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
	 * The ids of the orders' products whose item type numbers their units (none without Condition grades and unit numbers).
	 * @param {Site} s @param {OrderRecord[]} orders
	 * @returns {Promise<Set<string>>}
	 */
	const numberedOf = async (s, orders) => {
		const ids = [
			...new Set(
				orders.flatMap((order) => order.lines.filter((line) => line.kind === 'physical').map((line) => line.productId)),
			),
		];
		const rules = await unitRulesOf(await s.data(), ids, { types: await s.list('item_types'), has: s.has });
		return new Set(rules.keys());
	};

	/**
	 * What the orders' documents are printed with.
	 * @param {Site} s @param {OrderRecord[]} orders
	 * @returns {Promise<import('../core/invoice.js').DocumentContext>}
	 */
	const contextOf = documentContextOf;

	/** @param {any} ctx */
	const packingSlips = async (ctx) => {
		const s = await service.site(ctx);
		const orders = await ordersOf(s, ctx, MAX_SLIPS);
		const [context, numbered] = await Promise.all([contextOf(s, orders), numberedOf(s, orders)]);
		return new Response(packingSlipsHtml(orders, context, numbered), { headers: DOCUMENT_HEADERS });
	};

	/** @param {any} ctx */
	const pickList = async (ctx) => {
		const s = await service.site(ctx);
		const orders = await ordersOf(s, ctx, MAX_PICK);
		return new Response(pickListHtml(orders, await contextOf(s, orders)), { headers: DOCUMENT_HEADERS });
	};

	return {
		routes: [
			defineRoute({
				method: 'GET',
				path: '/v1/orders/packing-slips',
				auth: 'server',
				permission: 'orders.read',
				feature: 'invoices',
				rateLimit: SERVER_LIMITS,
				handler: packingSlips,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/packing-slips',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: packingSlips,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/pick-list',
				auth: 'server',
				permission: 'orders.read',
				feature: 'invoices',
				rateLimit: SERVER_LIMITS,
				handler: pickList,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/pick-list',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: pickList,
			}),
		],
	};
};
