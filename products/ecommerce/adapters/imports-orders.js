/**
 * The shoppers' and orders' part of the import (PLAN 0.8.10 K10, Migration order step 6): customers, orders with their
 * lines, payments and history, loyalty, reviews, returns, alerts and wishlists, each checked in import mode by
 * `core/imports-orders.js` (nothing sent, no events, alerts or activity copies, no stock, slot or points moved). Its
 * finish steps (after the catalog's) recompute what the shop derives from them — customers' order and RTO counts and
 * last order, loyalty balances and lifetime points, products' units sold and rating (where their order lines or reviews
 * were moved too; otherwise the numbers imported stay), serials sold through order lines and the order counters — a
 * page of records at a time in `_id` order with aggregations, writing only what differs, so a second run changes
 * nothing. Its sums feed `ss-import verify`.
 * @module
 */
import {
	checkImportedAlert,
	checkImportedCustomer,
	checkImportedLoyalty,
	checkImportedOrder,
	checkImportedReturn,
	checkImportedReview,
	checkImportedWishlist,
	customerCounts,
	holdsSerials,
	importRules,
	rtoKeysOf,
	cancelKeysOf,
	serialsSoldTo,
} from '../core/imports-orders.js';
import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../core/model.js';
import { fieldsOn } from './catalog-store.js';
import { ratingSummary } from '../core/reviews.js';
import { setOrderCounter } from './ledger.js';
import { captureIndexes, counterIdOf, formNumbers, numberFormOf } from '../core/order-numbers.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/imports-orders.js').ImportRules} ImportRules */
/** @typedef {import('../core/imports-orders.js').ImportCheck} ImportCheck */

/** Records read per batch in finish's serial lookups. */
const BATCH = 1000;
/** A key in finish's `next`: a record's `_id` (24 hex digits). */
const OBJECT_KEY = /^[0-9a-f]{24}$/;

/**
 * The filter of one finish page: the records after the `_id` of the previous page's last one.
 * @param {string | null} after
 */
const afterId = (after) => (after === null ? {} : { _id: { $gt: ObjectId.createFromHexString(after) } });

/**
 * What a page read: how many, and the `_id` of the last (24 hex digits).
 * @param {Array<Record<string, any>>} batch
 * @returns {{ read: number, last: string | null }}
 */
const pageOf = (batch) => ({ read: batch.length, last: batch.length === 0 ? null : String(batch[batch.length - 1]?._id) });

/** @typedef {{ after: string | null, limit: number }} Page */

/** @param {unknown} at @returns {number | null} */
const timeOf = (at) => (at instanceof Date ? at.getTime() : null);

/**
 * Customers' order count, returned-packages count (orders whose package moved to a `returned_to_origin` status for a
 * reason that counts against the customer — none given counts, customer_return never — or that were canceled for a
 * reason that counts, as the ledger counts them; E19) and last order time, from their orders (by customer id). A page
 * of customers.
 * @param {WebsiteData} data
 * @param {{ rtoKeys: string[], cancelKeys: string[], notCounting: string[], countingCancels: string[] }} rules
 *   `notCounting`: failed-delivery reasons that do not count; `countingCancels`: cancel reasons that do
 * @param {Page} page
 */
const finishCustomers = async (data, { rtoKeys, cancelKeys, notCounting, countingCancels }, { after, limit }) => {
	const { websiteId } = data;
	const orders = data.collection(COLLECTIONS.orders);
	const customers = data.collection(COLLECTIONS.customers);
	const isRto = {
		$and: [
			{ $ne: ['$$this.from', '$$this.to'] },
			{
				$or: [
					{
						$and: [
							{ $in: ['$$this.to', rtoKeys] },
							{ $not: [{ $in: [{ $ifNull: ['$$this.reason', ''] }, [...notCounting, 'customer_return']] }] },
						],
					},
					{
						$and: [{ $in: ['$$this.to', cancelKeys] }, { $in: [{ $ifNull: ['$$this.reason', ''] }, countingCancels] }],
					},
				],
			},
		],
	};
	const rto = { $cond: [{ $gt: [{ $size: { $filter: { input: { $ifNull: ['$history', []] }, cond: isRto } } }, 0] }, 1, 0] };
	/** @param {string[]} ids customer ids */
	const sums = async (ids) =>
		new Map(
			(
				await orders
					.aggregate([
						{ $match: { websiteId, 'customer.customerId': { $in: ids } } },
						{
							$group: {
								_id: '$customer.customerId',
								count: { $sum: 1 },
								rto: { $sum: rto },
								last: { $max: '$placedAt' },
							},
						},
					])
					.toArray()
			).map((row) => [String(row._id), { count: Number(row.count), rto: Number(row.rto), last: row.last ?? null }]),
		);
	const batch = await customers
		.find(
			{ websiteId, ...afterId(after) },
			{ projection: { _id: 1, id: 1, orderCount: 1, rtoCount: 1, lastOrderAt: 1 }, sort: { _id: 1 }, limit },
		)
		.toArray();
	let updated = 0;
	if (batch.length > 0) {
		const byId = await sums(batch.map((customer) => String(customer.id)));
		for (const customer of batch) {
			const next = customerCounts(byId.get(String(customer.id)));
			if (
				customer.orderCount === next.orderCount &&
				customer.rtoCount === next.rtoCount &&
				timeOf(customer.lastOrderAt) === timeOf(next.lastOrderAt)
			)
				continue;
			await customers.updateOne({ websiteId, _id: customer._id }, { $set: next });
			updated += 1;
		}
	}
	return { ...pageOf(batch), counts: { customersUpdated: updated } };
};

/**
 * Loyalty accounts' balance (the points left in lots not expired now) and lifetime points (their earn entries, never
 * lowered), worked out by the database (`loyaltyDerived` in `core/imports-orders.js` is the same rule). A page of
 * accounts.
 * @param {WebsiteData} data @param {number} now @param {Page} page
 */
const finishLoyalty = async (data, now, { after, limit }) => {
	const { websiteId } = data;
	const accounts = data.collection(COLLECTIONS.loyalty);
	const at = new Date(now);
	const unexpired = {
		$or: [{ $eq: [{ $ifNull: ['$$this.expiresAt', null] }, null] }, { $gt: ['$$this.expiresAt', at] }],
	};
	const batch = await accounts
		.aggregate([
			{ $match: { websiteId, ...afterId(after) } },
			{ $sort: { _id: 1 } },
			{ $limit: limit },
			{
				$project: {
					balance: 1,
					lifetimeEarned: 1,
					left: {
						$sum: {
							$map: {
								input: { $filter: { input: { $ifNull: ['$lots', []] }, cond: unexpired } },
								in: '$$this.left',
							},
						},
					},
					earned: {
						$sum: {
							$map: {
								input: {
									$filter: { input: { $ifNull: ['$history', []] }, cond: { $eq: ['$$this.kind', 'earn'] } },
								},
								in: '$$this.points',
							},
						},
					},
				},
			},
		])
		.toArray();
	let updated = 0;
	for (const account of batch) {
		const balance = Number(account.left ?? 0);
		const lifetimeEarned = Math.max(Number(account.lifetimeEarned ?? 0), Number(account.earned ?? 0));
		if (account.balance === balance && account.lifetimeEarned === lifetimeEarned) continue;
		await accounts.updateOne({ websiteId, _id: account._id }, { $set: { balance, lifetimeEarned }, $inc: { version: 1 } });
		updated += 1;
	}
	return { ...pageOf(batch), counts: { loyaltyUpdated: updated } };
};

/**
 * Products' units sold and ordered and rating, each derived only from what it can be: `sold` (the units of delivered
 * orders, as delivery counts them) and `ordered` (the units of orders that hold their stock or were delivered, as
 * placing and giving back count them; P3-10) from the order lines when the product has at least one, `rating` from the
 * approved reviews when it has at least one review (of any status). A product with no order line or no review keeps
 * the number it was imported with (the old shop's count, whose orders or reviews were not moved). A page of products.
 * @param {WebsiteData} data @param {Page} page
 */
const finishSold = async (data, { after, limit }) => {
	const { websiteId } = data;
	const products = data.collection(COLLECTIONS.products);
	const batch = await products
		.find(
			{ websiteId, ...afterId(after) },
			{ projection: { _id: 1, id: 1, sold: 1, ordered: 1, rating: 1 }, sort: { _id: 1 }, limit },
		)
		.toArray();
	let updated = 0;
	if (batch.length > 0) {
		const ids = batch.map((product) => String(product.id));
		const delivered = { $ne: [{ $ifNull: ['$deliveredAt', null] }, null] };
		const counted = { $or: [delivered, { $eq: ['$stockHeld', true] }] };
		// a product with order lines, with its delivered units and its units ordered
		const units = new Map(
			(
				await data
					.collection(COLLECTIONS.orders)
					.aggregate([
						{ $match: { websiteId, 'lines.productId': { $in: ids } } },
						{ $unwind: '$lines' },
						{ $match: { 'lines.productId': { $in: ids } } },
						{
							$group: {
								_id: '$lines.productId',
								sold: { $sum: { $cond: [delivered, '$lines.quantity', 0] } },
								ordered: { $sum: { $cond: [counted, '$lines.quantity', 0] } },
							},
						},
					])
					.toArray()
			).map((row) => [String(row._id), { sold: Number(row.sold), ordered: Number(row.ordered) }]),
		);
		// a product with reviews, with its approved ones per star
		/** @type {Map<string, Array<{ rating: number, count: number }>>} */
		const stars = new Map();
		for (const row of await data
			.collection(COLLECTIONS.reviews)
			.aggregate([
				{ $match: { websiteId, productId: { $in: ids } } },
				{
					$group: {
						_id: { productId: '$productId', rating: '$rating' },
						count: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
					},
				},
			])
			.toArray()) {
			const id = String(row._id.productId);
			stars.set(id, [...(stars.get(id) ?? []), { rating: Number(row._id.rating), count: Number(row.count) }]);
		}
		for (const product of batch) {
			const id = String(product.id);
			/** @type {Record<string, unknown>} */
			const changed = {};
			const lines = units.get(id);
			if (lines !== undefined && product.sold !== lines.sold) changed.sold = lines.sold;
			if (lines !== undefined && product.ordered !== lines.ordered) changed.ordered = lines.ordered;
			const reviewed = stars.get(id);
			if (reviewed) {
				const { average, count } = ratingSummary(reviewed);
				if (product.rating?.average !== average || product.rating?.count !== count) changed.rating = { average, count };
			}
			if (Object.keys(changed).length === 0) continue;
			await products.updateOne({ websiteId, _id: product._id }, { $set: changed });
			updated += 1;
		}
	}
	return { ...pageOf(batch), counts: { productsSoldRatingUpdated: updated } };
};

/**
 * Serials sold through order lines: each serial number a line of a holding order lists (not canceled, returned or
 * refunded before delivery; not put back by a claim) is `sold` with its order and line. A serial sold to another order
 * is left as it is, and one without a record is only counted (the catalog import writes the serials). A page of the
 * orders whose lines list serials.
 * @param {WebsiteData} data @param {Page} page
 */
const finishSerials = async (data, { after, limit }) => {
	const { websiteId } = data;
	const serials = data.collection(COLLECTIONS.serials);
	const counts = { serialsSold: 0, serialsMissing: 0, serialsOnOtherOrders: 0 };
	const batch = await data
		.collection(COLLECTIONS.orders)
		.find(
			{ websiteId, 'lines.serials.0': { $exists: true }, ...afterId(after) },
			{
				projection: { _id: 1, id: 1, role: 1, deliveredAt: 1, 'lines.id': 1, 'lines.serials': 1 },
				sort: { _id: 1 },
				limit,
			},
		)
		.toArray();
	const holding = batch.filter(holdsSerials);
	if (holding.length > 0) {
		const claims = await data
			.collection(COLLECTIONS.returns)
			.find(
				{ websiteId, orderId: { $in: holding.map((order) => order.id) } },
				{ projection: { _id: 0, orderId: 1, restockedAt: 1, lines: 1 } },
			)
			.toArray();
		const wanted = serialsSoldTo(holding, /** @type {any[]} */ (claims));
		for (let start = 0; start < wanted.length; start += BATCH) {
			const chunk = wanted.slice(start, start + BATCH);
			const found = new Map(
				(
					await serials
						.find(
							{ websiteId, serial: { $in: chunk.map((want) => want.serial) } },
							{ projection: { _id: 0, serial: 1, status: 1, orderId: 1, lineId: 1 } },
						)
						.toArray()
				).map((record) => [String(record.serial), record]),
			);
			for (const want of chunk) {
				const record = found.get(want.serial);
				if (!record) counts.serialsMissing += 1;
				else if (record.status === 'sold' && record.orderId && record.orderId !== want.orderId)
					counts.serialsOnOtherOrders += 1;
				else if (record.status !== 'sold' || record.orderId !== want.orderId || record.lineId !== want.lineId) {
					await serials.updateOne(
						{ websiteId, serial: want.serial },
						{ $set: { status: 'sold', orderId: want.orderId, lineId: want.lineId } },
					);
					counts.serialsSold += 1;
				}
			}
		}
	}
	return { ...pageOf(batch), counts };
};

/**
 * The order counters (E30, E29): each counter of the website's number form (`core/order-numbers.js`) — the running
 * one, or each year's or month's that imported numbers use — behind the highest number in that form is set to it (by
 * the ledger's own `setOrderCounter`), so the next order placed gets the number after.
 * @param {WebsiteData} data
 * @param {import('../core/order-numbers.js').NumberForm} form
 */
const finishCounters = async (data, form) => {
	const { websiteId } = data;
	const numbers = formNumbers(form);
	const where = captureIndexes(form);
	/** @param {number} index */
	const part = (index) => (index < 0 ? null : { $toInt: { $arrayElemAt: ['$parts.captures', index] } });
	const rows = await data
		.collection(COLLECTIONS.orders)
		.aggregate([
			{ $match: { websiteId, number: { $regex: numbers } } },
			{ $project: { _id: 0, parts: { $regexFind: { input: '$number', regex: numbers } } } },
			{
				$group: {
					_id: { year: part(where.year), month: part(where.month) },
					highest: { $max: { $toLong: { $arrayElemAt: ['$parts.captures', where.sequence] } } },
				},
			},
		])
		.toArray();
	/** @type {Map<string, { at: import('../core/order-numbers.js').NumberAt, highest: number }>} */
	const highest = new Map();
	for (const row of rows) {
		const at = { year: Number(row._id?.year ?? 0), month: Number(row._id?.month ?? 0) };
		highest.set(counterIdOf(form, at), { at, highest: Number(row.highest) });
	}
	let set = 0;
	for (const [id, { at, highest: top }] of highest) {
		const counter = await data.collection(COLLECTIONS.counters).findOne({ websiteId, id }, { projection: { _id: 0, seq: 1 } });
		if (counter && Number(counter.seq) >= top) continue;
		await setOrderCounter(data, { form, at, next: top + 1 });
		set += 1;
	}
	return set;
};

/**
 * @param {import('./imports.js').ImportDeps} deps
 * @returns {import('./imports.js').ImportPart}
 */
export const orderImports = (deps) => {
	/**
	 * What every check of a call reads of the website: the order flow, the checkout and catalog settings, the
	 * business.json country (national phone numbers, K12), the order and customer fields, the time.
	 * @param {{ websiteId: string, data: import('@ss/app-kit').WebsiteData, now: () => number,
	 *   business: () => Promise<{ country?: string | null }> }} ctx
	 * @returns {Promise<ImportRules>}
	 */
	const prepare = async (ctx) =>
		importRules({
			flow: await deps.list(ctx.websiteId, 'order_flow'),
			checkout: await deps.settings(ctx.websiteId, 'checkout'),
			catalog: await deps.settings(ctx.websiteId, 'catalog'),
			country: (await ctx.business()).country,
			now: ctx.now(),
			fields: { order: await fieldsOn(ctx.data, 'order'), customer: await fieldsOn(ctx.data, 'customer') },
			claims: {
				kinds: /** @type {any[]} */ (await deps.list(ctx.websiteId, 'claim_kinds')),
				statuses: /** @type {any[]} */ (await deps.list(ctx.websiteId, 'claim_statuses')),
			},
		});

	/**
	 * @param {string} collection
	 * @param {(record: Record<string, unknown>, rules: ImportRules) => ImportCheck} check
	 * @param {string[]} [key]
	 * @returns {import('@ss/app-kit').ImportCollection}
	 */
	const collection = (collection, check, key) => ({
		collection,
		...(key ? { key } : {}),
		prepare,
		check: (record, ctx) => check(record, /** @type {ImportRules} */ (ctx.prepared)),
	});

	return {
		collections: {
			customers: collection(COLLECTIONS.customers, checkImportedCustomer),
			orders: collection(COLLECTIONS.orders, checkImportedOrder),
			loyalty: collection(COLLECTIONS.loyalty, checkImportedLoyalty, ['customerId']),
			reviews: collection(COLLECTIONS.reviews, checkImportedReview),
			returns: collection(COLLECTIONS.returns, checkImportedReturn),
			alerts: collection(COLLECTIONS.alerts, checkImportedAlert),
			wishlists: collection(COLLECTIONS.wishlists, checkImportedWishlist, ['userId']),
		},
		steps: [
			{
				name: 'customers',
				key: OBJECT_KEY,
				zero: { customersUpdated: 0 },
				run: async (ctx, page) => {
					const flow = /** @type {import('../core/model.js').OrderFlow} */ (await deps.list(ctx.websiteId, 'order_flow'));
					/** @type {Array<{ key: string, countsAgainst: boolean }>} */
					const failures = /** @type {any} */ (await deps.list(ctx.websiteId, 'delivery_failure_reasons'));
					/** @type {Array<{ key: string, countsAgainst: boolean }>} */
					const cancels = /** @type {any} */ (await deps.list(ctx.websiteId, 'cancel_reasons'));
					return finishCustomers(
						await ctx.data(),
						{
							rtoKeys: rtoKeysOf(flow),
							cancelKeys: cancelKeysOf(flow),
							notCounting: failures.filter((reason) => !reason.countsAgainst).map((reason) => reason.key),
							countingCancels: cancels.filter((reason) => reason.countsAgainst).map((reason) => reason.key),
						},
						page,
					);
				},
			},
			{
				name: 'loyalty',
				key: OBJECT_KEY,
				zero: { loyaltyUpdated: 0 },
				run: async (ctx, page) => finishLoyalty(await ctx.data(), deps.now(), page),
			},
			{
				name: 'sold',
				key: OBJECT_KEY,
				zero: { productsSoldRatingUpdated: 0 },
				run: async (ctx, page) => finishSold(await ctx.data(), page),
			},
			{
				name: 'serials',
				key: OBJECT_KEY,
				zero: { serialsSold: 0, serialsMissing: 0, serialsOnOtherOrders: 0 },
				run: async (ctx, page) => finishSerials(await ctx.data(), page),
			},
			{
				// one aggregation over the orders' numbers: no records read of the page
				name: 'counters',
				key: /^$/,
				zero: { countersSet: 0 },
				run: async (ctx) => ({
					read: 0,
					last: null,
					counts: {
						countersSet: await finishCounters(
							await ctx.data(),
							numberFormOf(await deps.settings(ctx.websiteId, 'checkout')),
						),
					},
				}),
			},
		],
		totals: async (ctx) => {
			const data = /** @type {WebsiteData} */ (await ctx.data());
			const { websiteId } = data;
			/** @type {Record<string, number>} */
			const sums = {};
			const byStatus = await data
				.collection(COLLECTIONS.orders)
				.aggregate([
					{ $match: { websiteId } },
					{ $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$totals.total' } } },
					{ $sort: { _id: 1 } },
				])
				.toArray();
			for (const row of byStatus) {
				sums[`orders.${String(row._id)}.count`] = Number(row.count);
				sums[`orders.${String(row._id)}.total`] = Number(row.total);
			}
			sums.customers = await data.collection(COLLECTIONS.customers).countDocuments({ websiteId });
			const [points] = await data
				.collection(COLLECTIONS.loyalty)
				.aggregate([{ $match: { websiteId } }, { $group: { _id: null, balance: { $sum: '$balance' } } }])
				.toArray();
			sums['loyalty.points'] = Number(points?.balance ?? 0);
			sums.reviews = await data.collection(COLLECTIONS.reviews).countDocuments({ websiteId });
			sums.returns = await data.collection(COLLECTIONS.returns).countDocuments({ websiteId });
			return sums;
		},
	};
};
