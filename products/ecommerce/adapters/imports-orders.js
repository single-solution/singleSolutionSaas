/**
 * The shoppers' and orders' part of the import (PLAN 0.8.10 K10, Migration order step 6): customers, orders with their
 * lines, payments and history, loyalty, reviews, returns, alerts and wishlists, each checked in import mode by
 * `core/imports-orders.js` (nothing sent, no events, alerts or activity copies, no stock, slot or points moved). Its
 * finish (after the catalog's) recomputes what the shop derives from them — customers' order and RTO counts and last
 * order, loyalty balances and lifetime points, products' units sold and rating (where their order lines or reviews were
 * moved too; otherwise the numbers imported stay), serials sold through order lines and the order counters — in batches of at most 1,000 records with aggregations, writing only what differs, so a second
 * run changes nothing. Its sums feed `ss-import verify`.
 * @module
 */
import {
	NUMBER_PARTS,
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
	serialsSoldTo,
} from '../core/imports-orders.js';
import { COLLECTIONS } from '../core/model.js';
import { ratingSummary } from '../core/reviews.js';
import { counterId, setOrderCounter } from './ledger.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/imports-orders.js').ImportRules} ImportRules */
/** @typedef {import('../core/imports-orders.js').ImportCheck} ImportCheck */

/** Records read per batch in finish. */
const BATCH = 1000;

/**
 * Walk a website's records batch by batch in `_id` order (bounded memory, one read per batch).
 * @param {(after: Record<string, unknown>) => Promise<any[]>} read the batch after the last `_id` read ({} at first)
 * @param {(batch: any[]) => Promise<void>} each
 */
const inBatches = async (read, each) => {
	/** @type {Record<string, unknown>} */
	let after = {};
	for (;;) {
		const batch = await read(after);
		if (batch.length > 0) await each(batch);
		if (batch.length < BATCH) return;
		after = { _id: { $gt: batch[batch.length - 1]._id } };
	}
};

/** @param {unknown} at @returns {number | null} */
const timeOf = (at) => (at instanceof Date ? at.getTime() : null);

/**
 * Customers' order count, RTO count (parcels moved to a `returned_to_origin` status for another reason than a
 * customer's return, as the ledger counts them) and last order time, from their orders: a customer's by customer id,
 * and a member's older orders without one by user id.
 * @param {WebsiteData} data @param {string[]} rtoKeys
 */
const finishCustomers = async (data, rtoKeys) => {
	const { websiteId } = data;
	const orders = data.collection(COLLECTIONS.orders);
	const customers = data.collection(COLLECTIONS.customers);
	const isRto = {
		$and: [
			{ $in: ['$$this.to', rtoKeys] },
			{ $ne: ['$$this.from', '$$this.to'] },
			{ $ne: ['$$this.reason', 'customer_return'] },
		],
	};
	const rto = { $cond: [{ $gt: [{ $size: { $filter: { input: { $ifNull: ['$history', []] }, cond: isRto } } }, 0] }, 1, 0] };
	/** @param {Record<string, unknown>} match @param {string} by */
	const sums = async (match, by) =>
		new Map(
			(
				await orders
					.aggregate([
						{ $match: { websiteId, ...match } },
						{ $group: { _id: by, count: { $sum: 1 }, rto: { $sum: rto }, last: { $max: '$placedAt' } } },
					])
					.toArray()
			).map((row) => [String(row._id), { count: Number(row.count), rto: Number(row.rto), last: row.last ?? null }]),
		);
	let updated = 0;
	await inBatches(
		(after) =>
			customers
				.find(
					{ websiteId, ...after },
					{
						projection: { _id: 1, id: 1, userId: 1, orderCount: 1, rtoCount: 1, lastOrderAt: 1 },
						sort: { _id: 1 },
						limit: BATCH,
					},
				)
				.toArray(),
		async (batch) => {
			const ids = batch.map((customer) => customer.id).filter((id) => typeof id === 'string');
			const users = batch.map((customer) => customer.userId).filter((id) => typeof id === 'string' && id !== '');
			const byId = await sums({ 'customer.customerId': { $in: ids } }, '$customer.customerId');
			const byUser =
				users.length === 0
					? new Map()
					: await sums(
							{ 'customer.userId': { $in: users }, 'customer.customerId': { $in: [null, ''] } },
							'$customer.userId',
						);
			for (const customer of batch) {
				const next = customerCounts(
					[byId.get(String(customer.id)), customer.userId ? byUser.get(String(customer.userId)) : undefined].filter(
						(row) => row !== undefined,
					),
				);
				if (
					customer.orderCount === next.orderCount &&
					customer.rtoCount === next.rtoCount &&
					timeOf(customer.lastOrderAt) === timeOf(next.lastOrderAt)
				)
					continue;
				await customers.updateOne({ websiteId, _id: customer._id }, { $set: next });
				updated += 1;
			}
		},
	);
	return updated;
};

/**
 * Loyalty accounts' balance (the points left in lots not expired now) and lifetime points (their earn entries, never
 * lowered), worked out by the database (`loyaltyDerived` in `core/imports-orders.js` is the same rule).
 * @param {WebsiteData} data @param {number} now
 */
const finishLoyalty = async (data, now) => {
	const { websiteId } = data;
	const accounts = data.collection(COLLECTIONS.loyalty);
	const at = new Date(now);
	const unexpired = {
		$or: [{ $eq: [{ $ifNull: ['$$this.expiresAt', null] }, null] }, { $gt: ['$$this.expiresAt', at] }],
	};
	let updated = 0;
	await inBatches(
		(after) =>
			accounts
				.aggregate([
					{ $match: { websiteId, ...after } },
					{ $sort: { _id: 1 } },
					{ $limit: BATCH },
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
				.toArray(),
		async (batch) => {
			for (const account of batch) {
				const balance = Number(account.left ?? 0);
				const lifetimeEarned = Math.max(Number(account.lifetimeEarned ?? 0), Number(account.earned ?? 0));
				if (account.balance === balance && account.lifetimeEarned === lifetimeEarned) continue;
				await accounts.updateOne(
					{ websiteId, _id: account._id },
					{ $set: { balance, lifetimeEarned }, $inc: { version: 1 } },
				);
				updated += 1;
			}
		},
	);
	return updated;
};

/**
 * Products' units sold and rating, each derived only from what it can be: `sold` from the order lines (the units of
 * delivered orders, as delivery counts them) when the product has at least one order line, `rating` from the approved
 * reviews when it has at least one review (of any status). A product with no order line or no review keeps the number
 * it was imported with (the old shop's count, whose orders or reviews were not moved).
 * @param {WebsiteData} data
 */
const finishProducts = async (data) => {
	const { websiteId } = data;
	const products = data.collection(COLLECTIONS.products);
	let updated = 0;
	await inBatches(
		(after) =>
			products
				.find({ websiteId, ...after }, { projection: { _id: 1, id: 1, sold: 1, rating: 1 }, sort: { _id: 1 }, limit: BATCH })
				.toArray(),
		async (batch) => {
			const ids = batch.map((product) => String(product.id));
			const delivered = { $ne: [{ $ifNull: ['$deliveredAt', null] }, null] };
			// a product with order lines, with its delivered units
			const sold = new Map(
				(
					await data
						.collection(COLLECTIONS.orders)
						.aggregate([
							{ $match: { websiteId, 'lines.productId': { $in: ids } } },
							{ $unwind: '$lines' },
							{ $match: { 'lines.productId': { $in: ids } } },
							{ $group: { _id: '$lines.productId', units: { $sum: { $cond: [delivered, '$lines.quantity', 0] } } } },
						])
						.toArray()
				).map((row) => [String(row._id), Number(row.units)]),
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
				const units = sold.get(id);
				if (units !== undefined && product.sold !== units) changed.sold = units;
				const reviewed = stars.get(id);
				if (reviewed) {
					const { average, count } = ratingSummary(reviewed);
					if (product.rating?.average !== average || product.rating?.count !== count) changed.rating = { average, count };
				}
				if (Object.keys(changed).length === 0) continue;
				await products.updateOne({ websiteId, _id: product._id }, { $set: changed });
				updated += 1;
			}
		},
	);
	return updated;
};

/**
 * Serials sold through order lines: each serial number a line of a holding order lists (not cancelled, returned or
 * refunded before delivery; not put back by a claim) is `sold` with its order and line. A serial sold to another order
 * is left as it is, and one without a record is only counted (the catalog import writes the serials).
 * @param {WebsiteData} data
 */
const finishSerials = async (data) => {
	const { websiteId } = data;
	const serials = data.collection(COLLECTIONS.serials);
	const counts = { serialsSold: 0, serialsMissing: 0, serialsOnOtherOrders: 0 };
	await inBatches(
		(after) =>
			data
				.collection(COLLECTIONS.orders)
				.find(
					{ websiteId, 'lines.serials.0': { $exists: true }, ...after },
					{
						projection: { _id: 1, id: 1, role: 1, deliveredAt: 1, 'lines.id': 1, 'lines.serials': 1 },
						sort: { _id: 1 },
						limit: BATCH,
					},
				)
				.toArray(),
		async (batch) => {
			const holding = batch.filter(holdsSerials);
			if (holding.length === 0) return;
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
		},
	);
	return counts;
};

/**
 * The order counters (E30): for each prefix and year the orders' numbers use, a counter behind the highest number is
 * set to it (by the ledger's own `setOrderCounter`), so the next order placed gets the number after.
 * @param {WebsiteData} data
 */
const finishCounters = async (data) => {
	const { websiteId } = data;
	const rows = await data
		.collection(COLLECTIONS.orders)
		.aggregate([
			{ $match: { websiteId, number: { $type: 'string' } } },
			{ $project: { _id: 0, parts: { $regexFind: { input: '$number', regex: NUMBER_PARTS } } } },
			{ $match: { parts: { $ne: null } } },
			{
				$group: {
					_id: { prefix: { $arrayElemAt: ['$parts.captures', 0] }, year: { $arrayElemAt: ['$parts.captures', 1] } },
					highest: { $max: { $toLong: { $arrayElemAt: ['$parts.captures', 2] } } },
				},
			},
		])
		.toArray();
	let set = 0;
	for (const row of rows) {
		const prefix = String(row._id.prefix);
		const year = Number(row._id.year);
		const highest = Number(row.highest);
		const counter = await data
			.collection(COLLECTIONS.counters)
			.findOne({ websiteId, id: counterId(prefix, year) }, { projection: { _id: 0, seq: 1 } });
		if (counter && Number(counter.seq) >= highest) continue;
		await setOrderCounter(data, { prefix, year, next: highest + 1 });
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
	 * business.json country (national phone numbers, K12), the time.
	 * @param {{ websiteId: string, now: () => number, business: () => Promise<{ country?: string | null }> }} ctx
	 * @returns {Promise<ImportRules>}
	 */
	const prepare = async (ctx) =>
		importRules({
			flow: await deps.list(ctx.websiteId, 'order_flow'),
			checkout: await deps.settings(ctx.websiteId, 'checkout'),
			catalog: await deps.settings(ctx.websiteId, 'catalog'),
			country: (await ctx.business()).country,
			now: ctx.now(),
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
		finish: async (ctx) => {
			const data = /** @type {WebsiteData} */ (await ctx.data());
			const flow = /** @type {import('../core/model.js').OrderFlow} */ (await deps.list(ctx.websiteId, 'order_flow'));
			return {
				customersUpdated: await finishCustomers(data, rtoKeysOf(flow)),
				loyaltyUpdated: await finishLoyalty(data, deps.now()),
				productsSoldRatingUpdated: await finishProducts(data),
				...(await finishSerials(data)),
				countersSet: await finishCounters(data),
			};
		},
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
