/**
 * The shop's ledger: every write that moves stock, offer uses, loyalty points or booked slots (PLAN 0.8.8). Placing
 * an order does all of them and inserts the order in **one database transaction** in the merchant database, with no
 * network call between the parts: either everything happens or nothing does. Giving them back (cancel, payment window
 * ended, return to origin, a return claim's restock) is guarded so it happens exactly once.
 *
 * Every function takes the website's guarded merchant database (`WebsiteData`, from `ctx.data()`) and, where it can
 * run inside a transaction, the driver session.
 * @module
 */
import { createId, zonedParts } from '@ss/contracts';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { balanceOf, compactLots, expireLots, spendFromLots, takeFromLots } from '../core/points.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('mongodb').ClientSession} Session */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').LoyaltyRecord} LoyaltyRecord */

/** Loyalty history entries kept per account (the newest). */
const HISTORY_KEPT = 200;

/**
 * Indexes the ledger relies on (merged into the product's index list): the unique ones are what make the guards hold.
 * @type {import('@ss/app-kit').IndexDefinition[]}
 */
export const LEDGER_INDEXES = [
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.orders, keys: { websiteId: 1, number: 1 }, name: 'by_number', unique: true },
	{
		collection: COLLECTIONS.orders,
		keys: { websiteId: 1, 'customer.userId': 1, idempotencyKey: 1 },
		name: 'by_checkout_key',
		unique: true,
	},
	{ collection: COLLECTIONS.counters, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{
		collection: COLLECTIONS.couponUses,
		keys: { websiteId: 1, couponId: 1, userId: 1, seq: 1 },
		name: 'per_customer',
		unique: true,
	},
	{ collection: COLLECTIONS.couponUses, keys: { websiteId: 1, orderId: 1 }, name: 'by_order' },
	{ collection: COLLECTIONS.loyalty, keys: { websiteId: 1, userId: 1 }, name: 'by_user', unique: true },
	{ collection: COLLECTIONS.slots, keys: { websiteId: 1, productId: 1, start: 1 }, name: 'one_booking', unique: true },
	{ collection: COLLECTIONS.slots, keys: { websiteId: 1, orderId: 1 }, name: 'by_order' },
	{ collection: COLLECTIONS.customers, keys: { websiteId: 1, userId: 1 }, name: 'by_user', unique: true },
];

/**
 * @typedef {object} StockLine
 * @property {string} productId
 * @property {string} variantId
 * @property {number} quantity
 * @property {string | null} [locationId] where it was taken (release, restock)
 */

/** @param {unknown} error */
const isDuplicate = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/** @param {unknown} error @param {string} collection the unprefixed name */
const duplicateIn = (error, collection) =>
	isDuplicate(error) && String(/** @type {any} */ (error).message ?? '').includes(`_${collection} `);

/**
 * Sum the quantities of lines naming the same variant (two cart lines of one variant are one stock hold).
 * @param {StockLine[]} lines
 * @returns {StockLine[]}
 */
export const mergeStockLines = (lines) => {
	/** @type {Map<string, StockLine>} */
	const merged = new Map();
	for (const line of lines) {
		const key = `${line.productId}|${line.variantId}`;
		const found = merged.get(key);
		if (found) found.quantity += line.quantity;
		else merged.set(key, { productId: line.productId, variantId: line.variantId, quantity: line.quantity });
	}
	return [...merged.values()];
};

/**
 * Recompute `inStock` and `price` of products after their variants changed.
 * @param {WebsiteData} data
 * @param {string[]} productIds
 * @param {Session} [session]
 */
export const refreshProducts = async (data, productIds, session) => {
	const products = data.collection(COLLECTIONS.products);
	for (const id of [...new Set(productIds)]) {
		const product = /** @type {any} */ (await products.findOne({ websiteId: data.websiteId, id }, { session }));
		if (!product) continue;
		const active = (product.variants ?? []).filter((/** @type {any} */ v) => v.active);
		const inStock = active.some((/** @type {any} */ v) => !product.trackStock || v.stock > 0);
		const price = active.length > 0 ? Math.min(...active.map((/** @type {any} */ v) => v.price)) : 0;
		if (inStock !== product.inStock || price !== product.price)
			await products.updateOne({ websiteId: data.websiteId, id }, { $set: { inStock, price } }, { session });
	}
};

/**
 * Hold stock for lines (an order's placement). Stock is taken from the variant's `stock`, and with locations from the
 * first location in `locationOrder` that has the whole quantity. A product that does not track stock is not touched.
 * @param {WebsiteData} data
 * @param {StockLine[]} lines
 * @param {{ locationOrder?: string[], session?: Session }} [options]
 * @returns {Promise<{ ok: true, taken: Array<StockLine & { locationId: string | null }> } | { ok: false, productId: string, variantId: string }>}
 */
export const holdStock = async (data, lines, { locationOrder = [], session } = {}) => {
	const products = data.collection(COLLECTIONS.products);
	/** @type {Array<StockLine & { locationId: string | null }>} */
	const taken = [];
	for (const line of mergeStockLines(lines)) {
		const product = /** @type {any} */ (
			await products.findOne(
				{ websiteId: data.websiteId, id: line.productId },
				{ session, projection: { _id: 0, trackStock: 1 } },
			)
		);
		if (!product) return { ok: false, productId: line.productId, variantId: line.variantId };
		if (!product.trackStock) {
			taken.push({ ...line, locationId: null });
			continue;
		}
		const tries = locationOrder.length > 0 ? locationOrder : [null];
		let held = false;
		for (const locationId of tries) {
			/** @type {Record<string, unknown>} */
			const match = { id: line.variantId, active: true, stock: { $gte: line.quantity } };
			/** @type {Record<string, number>} */
			const inc = { 'variants.$.stock': -line.quantity };
			if (locationId !== null) {
				match[`locations.${locationId}`] = { $gte: line.quantity };
				inc[`variants.$.locations.${locationId}`] = -line.quantity;
			}
			const result = await products.updateOne(
				{ websiteId: data.websiteId, id: line.productId, status: 'active', variants: { $elemMatch: match } },
				{ $inc: inc },
				{ session },
			);
			if (result.modifiedCount === 1) {
				taken.push({ ...line, locationId });
				held = true;
				break;
			}
		}
		if (!held) return { ok: false, productId: line.productId, variantId: line.variantId };
	}
	await refreshProducts(
		data,
		taken.map((line) => line.productId),
		session,
	);
	return { ok: true, taken };
};

/**
 * Give stock back (cancel, payment window ended, return to origin, restock of a return). Products that do not track
 * stock, and variants that were deleted meanwhile, are skipped.
 * @param {WebsiteData} data
 * @param {StockLine[]} lines
 * @param {Session} [session]
 */
const releaseStock = async (data, lines, session) => {
	const products = data.collection(COLLECTIONS.products);
	for (const line of lines) {
		if (line.quantity <= 0) continue;
		/** @type {Record<string, number>} */
		const inc = { 'variants.$.stock': line.quantity };
		if (line.locationId) inc[`variants.$.locations.${line.locationId}`] = line.quantity;
		await products.updateOne(
			{ websiteId: data.websiteId, id: line.productId, trackStock: true, 'variants.id': line.variantId },
			{ $inc: inc },
			{ session },
		);
	}
	await refreshProducts(
		data,
		lines.map((line) => line.productId),
		session,
	);
};

/**
 * Count one use of each offer an order applied (the coupon, deals and bundles), within their limits; a coupon's
 * per-customer limit is held by a unique use record.
 * @param {WebsiteData} data
 * @param {{ couponId: string | null, dealIds: string[], bundleIds: string[], userId: string, orderId: string,
 *   perCustomer?: number | null }} uses
 * @param {Session} [session]
 * @returns {Promise<{ ok: true } | { ok: false, offerId: string }>}
 */
const useOffers = async (data, { couponId, dealIds, bundleIds, userId, orderId, perCustomer = null }, session) => {
	const websiteId = data.websiteId;
	const underLimit = { $or: [{ limit: null }, { $expr: { $lt: ['$used', '$limit'] } }] };
	/** @type {Array<[string, string]>} */
	const targets = [
		...(couponId ? [/** @type {[string, string]} */ ([COLLECTIONS.coupons, couponId])] : []),
		...dealIds.map((id) => /** @type {[string, string]} */ ([COLLECTIONS.deals, id])),
		...bundleIds.map((id) => /** @type {[string, string]} */ ([COLLECTIONS.bundles, id])),
	];
	for (const [collection, id] of targets) {
		const result = await data
			.collection(collection)
			.updateOne({ websiteId, id, active: true, ...underLimit }, { $inc: { used: 1 } }, { session });
		if (result.modifiedCount !== 1) return { ok: false, offerId: id };
	}
	if (couponId) {
		const uses = data.collection(COLLECTIONS.couponUses);
		const count = await uses.countDocuments({ websiteId, couponId, userId }, { session });
		if (perCustomer !== null && count >= perCustomer) return { ok: false, offerId: couponId };
		// a concurrent checkout of the same customer takes the same seq and fails on the unique index
		await uses.insertOne({ couponId, userId, orderId, seq: count + 1 }, { session });
	}
	return { ok: true };
};

/**
 * Give back the uses an order counted (cancel).
 * @param {WebsiteData} data
 * @param {{ couponId: string | null, dealIds: string[], bundleIds: string[], orderId: string }} uses
 * @param {Session} [session]
 */
const releaseOffers = async (data, { couponId, dealIds, bundleIds, orderId }, session) => {
	const websiteId = data.websiteId;
	/** @type {Array<[string, string]>} */
	const targets = [
		...(couponId ? [/** @type {[string, string]} */ ([COLLECTIONS.coupons, couponId])] : []),
		...dealIds.map((id) => /** @type {[string, string]} */ ([COLLECTIONS.deals, id])),
		...bundleIds.map((id) => /** @type {[string, string]} */ ([COLLECTIONS.bundles, id])),
	];
	for (const [collection, id] of targets)
		await data.collection(collection).updateOne({ websiteId, id, used: { $gt: 0 } }, { $inc: { used: -1 } }, { session });
	if (couponId) await data.collection(COLLECTIONS.couponUses).deleteMany({ websiteId, orderId }, { session });
};

// ------------------------------------------------------------------------------------------------------- loyalty

/**
 * A user's loyalty account with expired lots written off (written back when anything expired).
 * @param {WebsiteData} data
 * @param {string} userId
 * @param {{ now: number, session?: Session }} options
 * @returns {Promise<LoyaltyRecord>}
 */
export const loyaltyAccount = async (data, userId, { now, session }) => {
	const accounts = data.collection(COLLECTIONS.loyalty);
	const found = /** @type {LoyaltyRecord | null} */ (
		await accounts.findOne({ websiteId: data.websiteId, userId }, { session, projection: { _id: 0 } })
	);
	if (!found) return { userId, balance: 0, lots: [], history: [], version: 0 };
	const { lots, expired } = expireLots(found.lots, now);
	if (expired === 0) return found;
	const next = { ...found, lots: compactLots(lots), balance: balanceOf(lots), version: found.version + 1 };
	const entry = { at: new Date(now), kind: 'expire', points: expired, orderId: null, note: '' };
	const result = await accounts.updateOne(
		{ websiteId: data.websiteId, userId, version: found.version },
		{
			$set: { lots: next.lots, balance: next.balance },
			$inc: { version: 1 },
			$push: { history: { $each: [entry], $slice: -HISTORY_KEPT } },
		},
		{ session },
	);
	// someone else changed it meanwhile: read it again
	if (result.modifiedCount !== 1) return loyaltyAccount(data, userId, { now, session });
	return { ...next, history: [...found.history, /** @type {any} */ (entry)].slice(-HISTORY_KEPT) };
};

/**
 * Write a changed account, only if nobody changed it since it was read (`version`).
 * @param {WebsiteData} data
 * @param {LoyaltyRecord} before
 * @param {LoyaltyRecord['lots']} lots
 * @param {LoyaltyRecord['history'][number]} entry
 * @param {Session} [session]
 */
const writeAccount = async (data, before, lots, entry, session) => {
	const accounts = data.collection(COLLECTIONS.loyalty);
	const compacted = compactLots(lots);
	const update = {
		$set: { lots: compacted, balance: balanceOf(compacted) },
		$inc: { version: 1 },
		$push: { history: { $each: [entry], $slice: -HISTORY_KEPT } },
	};
	if (before.version === 0) {
		const result = await accounts.updateOne(
			{ websiteId: data.websiteId, userId: before.userId },
			{ ...update, $setOnInsert: { userId: before.userId } },
			{ session, upsert: true },
		);
		return result.upsertedCount === 1 || result.modifiedCount === 1;
	}
	const result = await accounts.updateOne(
		{ websiteId: data.websiteId, userId: before.userId, version: before.version },
		update,
		{ session },
	);
	return result.modifiedCount === 1;
};

/**
 * Spend points (redeemed at checkout).
 * @param {WebsiteData} data
 * @param {{ userId: string, points: number, orderId: string, note?: string }} spend
 * @param {{ now: number, session?: Session }} options
 * @returns {Promise<boolean>} false when the balance is too low or changed meanwhile
 */
export const spendPoints = async (data, { userId, points, orderId, note = '' }, { now, session }) => {
	if (points <= 0) return true;
	const account = await loyaltyAccount(data, userId, { now, session });
	const spent = spendFromLots(account.lots, points);
	if (!spent.ok) return false;
	return writeAccount(data, account, spent.lots, { at: new Date(now), kind: 'redeem', points, orderId, note }, session);
};

/**
 * Give points: earned on a delivered order, given back after a cancel (`refund`), or a staff adjustment.
 * @param {WebsiteData} data
 * @param {{ userId: string, points: number, orderId: string | null, kind: 'earn' | 'refund' | 'adjust', expiresAt: Date | null,
 *   note?: string }} give
 * @param {{ now: number, session?: Session }} options
 * @returns {Promise<boolean>} false when the account changed meanwhile (try again)
 */
export const givePoints = async (data, { userId, points, orderId, kind, expiresAt, note = '' }, { now, session }) => {
	if (points <= 0) return true;
	const account = await loyaltyAccount(data, userId, { now, session });
	const lot = { id: createId('lot'), points, left: points, earnedAt: new Date(now), expiresAt, orderId };
	return writeAccount(data, account, [...account.lots, lot], { at: new Date(now), kind, points, orderId, note }, session);
};

/**
 * Take points back (`reverse`: the order that earned them was returned; `adjust`: staff), never below 0.
 * @param {WebsiteData} data
 * @param {{ userId: string, points: number, orderId: string | null, kind: 'reverse' | 'adjust', note?: string }} take
 * @param {{ now: number, session?: Session }} options
 * @returns {Promise<{ ok: boolean, taken: number }>}
 */
export const takePoints = async (data, { userId, points, orderId, kind, note = '' }, { now, session }) => {
	const account = await loyaltyAccount(data, userId, { now, session });
	const { lots, taken } = takeFromLots(account.lots, points, orderId);
	if (taken === 0) return { ok: true, taken: 0 };
	const ok = await writeAccount(data, account, lots, { at: new Date(now), kind, points: taken, orderId, note }, session);
	return { ok, taken: ok ? taken : 0 };
};

// ------------------------------------------------------------------------------------------------- slots, numbers

/**
 * Hold booked slots (a unique index forbids two bookings of one product at one start).
 * @param {WebsiteData} data
 * @param {Array<{ productId: string, start: Date, end: Date, orderId: string, lineId: string }>} slots
 * @param {Session} [session]
 */
const holdSlots = async (data, slots, session) => {
	if (slots.length === 0) return;
	await data.collection(COLLECTIONS.slots).insertMany(
		slots.map((slot) => ({ ...slot, id: createId(ID_PREFIX.slot) })),
		{ session },
	);
};

/**
 * Free an order's slots.
 * @param {WebsiteData} data
 * @param {string} orderId
 * @param {Session} [session]
 */
const releaseSlots = (data, orderId, session) =>
	data.collection(COLLECTIONS.slots).deleteMany({ websiteId: data.websiteId, orderId }, { session });

/**
 * The next order number of a year (the year in the business time zone, PLAN 0.8.10 K8):
 * `<prefix><year>-<6-digit sequence>` (`2026-000042`).
 * @param {WebsiteData} data
 * @param {{ prefix: string, year: number, session?: Session }} options
 */
const nextOrderNumber = async (data, { prefix, year, session }) => {
	const counter = /** @type {any} */ (
		await data
			.collection(COLLECTIONS.counters)
			.findOneAndUpdate(
				{ websiteId: data.websiteId, id: `orders-${year}` },
				{ $inc: { seq: 1 }, $setOnInsert: { id: `orders-${year}` } },
				{ session, upsert: true, returnDocument: 'after', projection: { _id: 0, seq: 1 } },
			)
	);
	return `${prefix}${year}-${String(counter?.seq ?? 1).padStart(6, '0')}`;
};

// ------------------------------------------------------------------------------------------------- placing orders

/**
 * @typedef {object} Placement
 * @property {Omit<OrderRecord, 'number' | 'createdAt' | 'updatedAt'>} order the order to insert (its lines' `locationId`
 *   are filled from where the stock was taken)
 * @property {string} numberPrefix the `checkout` setting (may be '')
 * @property {string[]} [locationOrder] locations to take stock from, in order (multi_location)
 * @property {number | null} [couponPerCustomer] the coupon's per-customer limit
 * @property {Array<{ productId: string, start: Date, end: Date, lineId: string }>} [slots] booked slots
 */

/**
 * @typedef {{ ok: true, order: OrderRecord, duplicate: boolean }
 *   | { ok: false, code: 'out_of_stock', productId: string, variantId: string }
 *   | { ok: false, code: 'offer_unavailable', offerId: string }
 *   | { ok: false, code: 'points_changed' }
 *   | { ok: false, code: 'slot_taken' }} PlacementResult
 *   `duplicate`: the same customer already placed an order with this checkout key (that order is returned)
 */

/**
 * A business-rule refusal inside the transaction: thrown, it aborts everything.
 * @param {Exclude<PlacementResult, { ok: true }>} result
 */
const refused = (result) => Object.assign(new Error(result.code), { refused: result });

/**
 * Place an order in one transaction: number it, hold its stock, count its offer uses, spend its points, hold its
 * booked slots and insert it. Nothing is written when any part fails.
 * @param {WebsiteData} data
 * @param {Placement} placement
 * @param {{ now: number, timeZone?: string }} clock `timeZone`: the business.json time zone (UTC when missing), whose
 *   year numbers the order
 * @returns {Promise<PlacementResult>}
 */
export const placeOrder = async (data, placement, { now, timeZone = 'UTC' }) => {
	const { order } = placement;
	const orders = data.collection(COLLECTIONS.orders);
	const existing = async () =>
		/** @type {OrderRecord | null} */ (
			await orders.findOne(
				{ websiteId: data.websiteId, 'customer.userId': order.customer.userId, idempotencyKey: order.idempotencyKey },
				{ projection: { _id: 0 } },
			)
		);
	const before = await existing();
	if (before) return { ok: true, order: before, duplicate: true };
	try {
		const placed = await data.transaction(async (session) => {
			const number = await nextOrderNumber(data, {
				prefix: placement.numberPrefix,
				year: zonedParts(now, timeZone).year,
				session,
			});
			const stock = await holdStock(
				data,
				order.lines
					.filter((line) => line.kind === 'physical')
					.map((line) => ({ productId: line.productId, variantId: line.variantId, quantity: line.quantity })),
				{ locationOrder: placement.locationOrder ?? [], session },
			);
			if (!stock.ok)
				throw refused({ ok: false, code: 'out_of_stock', productId: stock.productId, variantId: stock.variantId });
			const where = new Map(stock.taken.map((line) => [`${line.productId}|${line.variantId}`, line.locationId]));
			const { promotions } = order;
			const offers = await useOffers(
				data,
				{
					couponId: promotions.couponId,
					dealIds: promotions.dealIds,
					bundleIds: promotions.bundleIds,
					userId: order.customer.userId,
					orderId: order.id,
					perCustomer: placement.couponPerCustomer ?? null,
				},
				session,
			);
			if (!offers.ok) throw refused({ ok: false, code: 'offer_unavailable', offerId: offers.offerId });
			if (promotions.pointsRedeemed > 0) {
				const spent = await spendPoints(
					data,
					{ userId: order.customer.userId, points: promotions.pointsRedeemed, orderId: order.id, note: number },
					{ now, session },
				);
				if (!spent) throw refused({ ok: false, code: 'points_changed' });
			}
			await holdSlots(
				data,
				(placement.slots ?? []).map((slot) => ({ ...slot, orderId: order.id })),
				session,
			);
			const record = {
				...order,
				number,
				lines: order.lines.map((line) => ({
					...line,
					locationId: line.kind === 'physical' ? (where.get(`${line.productId}|${line.variantId}`) ?? null) : null,
				})),
			};
			await orders.insertOne({ ...record }, { session });
			return record;
		});
		return { ok: true, order: /** @type {OrderRecord} */ (/** @type {unknown} */ (placed)), duplicate: false };
	} catch (error) {
		if (error instanceof Error && 'refused' in error) return /** @type {any} */ (error).refused;
		if (duplicateIn(error, COLLECTIONS.slots)) return { ok: false, code: 'slot_taken' };
		if (duplicateIn(error, COLLECTIONS.couponUses))
			return { ok: false, code: 'offer_unavailable', offerId: order.promotions.couponId ?? '' };
		if (duplicateIn(error, COLLECTIONS.orders)) {
			const won = await existing();
			if (won) return { ok: true, order: won, duplicate: true };
		}
		throw error;
	}
};

/**
 * Give back what an order holds (cancel before shipping, payment or confirmation window ended): its stock and slots
 * (once, `stockHeld`), and its offer uses and redeemed points (once, `promotions.released`). Runs in one transaction
 * with the status change the caller makes through `update` (which receives the session).
 * @param {WebsiteData} data
 * @param {OrderRecord} order as read before
 * @param {{ now: number, update: (session: Session) => Promise<boolean> }} options `update` returns false when the
 *   order changed meanwhile: then nothing is given back
 * @returns {Promise<boolean>} whether the order was changed
 */
export const releaseOrder = async (data, order, { now, update }) =>
	data.transaction(async (session) => {
		const orders = data.collection(COLLECTIONS.orders);
		const claimed = await orders.updateOne(
			{ websiteId: data.websiteId, id: order.id, updatedAt: order.updatedAt },
			{ $set: { stockHeld: false, 'promotions.released': true } },
			{ session },
		);
		if (claimed.modifiedCount !== 1) return false;
		if (!(await update(session))) throw new Error('order changed');
		if (order.stockHeld) {
			await releaseStock(
				data,
				order.lines
					.filter((line) => line.kind === 'physical')
					.map((line) => ({
						productId: line.productId,
						variantId: line.variantId,
						quantity: line.quantity,
						locationId: line.locationId,
					})),
				session,
			);
			await releaseSlots(data, order.id, session);
		}
		if (!order.promotions.released) {
			const { couponId, dealIds, bundleIds, pointsRedeemed } = order.promotions;
			await releaseOffers(data, { couponId, dealIds, bundleIds, orderId: order.id }, session);
			if (pointsRedeemed > 0)
				await givePoints(
					data,
					{
						userId: order.customer.userId,
						points: pointsRedeemed,
						orderId: order.id,
						kind: 'refund',
						expiresAt: null,
						note: order.number,
					},
					{ now, session },
				);
		}
		return true;
	});

/**
 * Put a parcel's stock back after a return to origin (RTO), once (`stockHeld`), with the status change in `update`.
 * Offer uses stay counted and points stay spent (the shopper used them); the customer's RTO count rises.
 * @param {WebsiteData} data
 * @param {OrderRecord} order
 * @param {{ update: (session: Session) => Promise<boolean> }} options
 * @returns {Promise<boolean>}
 */
export const returnToOrigin = async (data, order, { update }) =>
	data.transaction(async (session) => {
		const claimed = await data
			.collection(COLLECTIONS.orders)
			.updateOne(
				{ websiteId: data.websiteId, id: order.id, updatedAt: order.updatedAt },
				{ $set: { stockHeld: false } },
				{ session },
			);
		if (claimed.modifiedCount !== 1) return false;
		if (!(await update(session))) throw new Error('order changed');
		if (order.stockHeld)
			await releaseStock(
				data,
				order.lines
					.filter((line) => line.kind === 'physical')
					.map((line) => ({
						productId: line.productId,
						variantId: line.variantId,
						quantity: line.quantity,
						locationId: line.locationId,
					})),
				session,
			);
		await data
			.collection(COLLECTIONS.customers)
			.updateOne(
				{ websiteId: data.websiteId, userId: order.customer.userId },
				{ $inc: { rtoCount: 1 }, $setOnInsert: { userId: order.customer.userId } },
				{ session, upsert: true },
			);
		return true;
	});

/**
 * Restock the items of a return claim, exactly once (`restockedAt`), and mark the serials back in stock.
 * @param {WebsiteData} data
 * @param {{ claimId: string, lines: StockLine[], serials?: string[], now: number }} restock
 * @returns {Promise<boolean>} false when the claim was already restocked
 */
export const restockClaim = async (data, { claimId, lines, serials = [], now }) =>
	data.transaction(async (session) => {
		const claimed = await data
			.collection(COLLECTIONS.returns)
			.updateOne(
				{ websiteId: data.websiteId, id: claimId, restockedAt: null },
				{ $set: { restockedAt: new Date(now) } },
				{ session },
			);
		if (claimed.modifiedCount !== 1) return false;
		await releaseStock(data, lines, session);
		if (serials.length > 0)
			await data
				.collection(COLLECTIONS.serials)
				.updateMany(
					{ websiteId: data.websiteId, serial: { $in: serials }, status: 'sold' },
					{ $set: { status: 'in_stock', orderId: null, lineId: null } },
					{ session },
				);
		return true;
	});
