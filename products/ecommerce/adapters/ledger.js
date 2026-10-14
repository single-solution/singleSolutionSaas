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
import { summarize } from '../core/catalog.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { lotsByRule } from '../core/loyalty.js';
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
		keys: { websiteId: 1, 'customer.userId': 1, 'customer.customerId': 1, idempotencyKey: 1 },
		name: 'by_checkout',
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
	{
		collection: COLLECTIONS.loyalty,
		keys: { websiteId: 1, userId: 1 },
		name: 'by_user',
		unique: true,
		partialFilterExpression: { userId: { $type: 'string' } },
	},
	{
		collection: COLLECTIONS.loyalty,
		keys: { websiteId: 1, customerId: 1 },
		name: 'by_customer',
		unique: true,
		partialFilterExpression: { customerId: { $type: 'string' } },
	},
	{ collection: COLLECTIONS.slots, keys: { websiteId: 1, productId: 1, start: 1 }, name: 'one_booking', unique: true },
	{ collection: COLLECTIONS.slots, keys: { websiteId: 1, orderId: 1 }, name: 'by_order' },
	{
		collection: COLLECTIONS.customers,
		keys: { websiteId: 1, userId: 1 },
		name: 'by_user',
		unique: true,
		partialFilterExpression: { userId: { $type: 'string' } },
	},
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
 * Recompute what listings use of products after their variants changed: `price`, `priceMax`, `inStock`, `stockState`
 * and `grades` (PLAN 0.8.10 E2, E8).
 * @param {WebsiteData} data
 * @param {string[]} productIds
 * @param {Session} [session]
 */
export const refreshProducts = async (data, productIds, session) => {
	const products = data.collection(COLLECTIONS.products);
	for (const id of [...new Set(productIds)]) {
		const product = /** @type {any} */ (await products.findOne({ websiteId: data.websiteId, id }, { session }));
		if (!product) continue;
		const next = summarize(product.variants, product.trackStock === true);
		const same =
			next.price === product.price &&
			next.priceMax === product.priceMax &&
			next.inStock === product.inStock &&
			next.stockState === product.stockState &&
			JSON.stringify(next.grades) === JSON.stringify(product.grades);
		if (!same) await products.updateOne({ websiteId: data.websiteId, id }, { $set: next }, { session });
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
				{ session, projection: { _id: 0, trackStock: 1, variants: { id: 1, active: 1, soldOut: 1 } } },
			)
		);
		if (!product) return { ok: false, productId: line.productId, variantId: line.variantId };
		// a variant marked sold out is not sold, whatever its stock (E9)
		const variant = (product.variants ?? []).find((/** @type {any} */ v) => v.id === line.variantId);
		if (variant?.soldOut === true) return { ok: false, productId: line.productId, variantId: line.variantId };
		if (!product.trackStock) {
			taken.push({ ...line, locationId: null });
			continue;
		}
		const tries = locationOrder.length > 0 ? locationOrder : [null];
		let held = false;
		for (const locationId of tries) {
			/** @type {Record<string, unknown>} */
			const match = { id: line.variantId, active: true, soldOut: { $ne: true }, stock: { $gte: line.quantity } };
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
 *   perCustomer?: number | null, lockedDealIds?: string[] }} uses `userId`: the member, or a guest's customer id
 * @param {Session} [session]
 * @returns {Promise<{ ok: true } | { ok: false, offerId: string }>}
 */
const useOffers = async (
	data,
	{ couponId, dealIds, bundleIds, userId, orderId, perCustomer = null, lockedDealIds = [] },
	session,
) => {
	const websiteId = data.websiteId;
	const underLimit = { $or: [{ limit: null }, { $expr: { $lt: ['$used', '$limit'] } }] };
	/** @type {Array<[string, string]>} */
	const targets = [
		...(couponId ? [/** @type {[string, string]} */ ([COLLECTIONS.coupons, couponId])] : []),
		...dealIds.map((id) => /** @type {[string, string]} */ ([COLLECTIONS.deals, id])),
		...bundleIds.map((id) => /** @type {[string, string]} */ ([COLLECTIONS.bundles, id])),
	];
	for (const [collection, id] of targets) {
		// a deal a lock kept counts even when it ended or was switched off meanwhile (E18), never when deleted or used up
		const kept = collection === COLLECTIONS.deals && lockedDealIds.includes(id);
		const result = await data
			.collection(collection)
			.updateOne({ websiteId, id, ...(kept ? {} : { active: true }), ...underLimit }, { $inc: { used: 1 } }, { session });
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
 * Whose loyalty account (E20): a member by Accounts user id (a string is one), or a guest by their customer id (`cus_…`,
 * E21); a member's account also carries their customer id.
 * @typedef {string | { userId?: string | null, customerId?: string | null }} LoyaltyOwner
 */

/**
 * The account's key in the collection.
 * @param {LoyaltyOwner} owner
 * @returns {{ userId: string } | { customerId: string }}
 */
const keyOf = (owner) => {
	if (typeof owner === 'string') return { userId: owner };
	if (owner.userId) return { userId: owner.userId };
	return { customerId: String(owner.customerId ?? '') };
};

/**
 * What expiry follows when the account is read (E20 `expiryRule: current`): the `loyalty` settings and the business
 * time zone; without them each lot keeps the expiry it was given.
 * @typedef {{ settings: Record<string, any>, timeZone: string }} LoyaltyRulesContext
 */

/**
 * A loyalty account with expired lots written off (written back when anything expired).
 * @param {WebsiteData} data
 * @param {LoyaltyOwner} owner
 * @param {{ now: number, session?: Session, rules?: LoyaltyRulesContext }} options
 * @returns {Promise<LoyaltyRecord>}
 */
export const loyaltyAccount = async (data, owner, { now, session, rules }) => {
	const accounts = data.collection(COLLECTIONS.loyalty);
	const key = keyOf(owner);
	const found = /** @type {LoyaltyRecord | null} */ (
		await accounts.findOne({ websiteId: data.websiteId, ...key }, { session, projection: { _id: 0 } })
	);
	if (!found)
		return {
			userId: 'userId' in key ? key.userId : /** @type {any} */ (null),
			...('customerId' in key ? { customerId: key.customerId } : {}),
			balance: 0,
			lifetimeEarned: 0,
			lots: [],
			history: [],
			version: 0,
		};
	const ruled = rules ? lotsByRule(found.lots, rules.settings, rules.timeZone) : found.lots;
	const { lots, expired } = expireLots(ruled, now);
	if (expired === 0) return { ...found, lots };
	const next = { ...found, lots: compactLots(lots), balance: balanceOf(lots), version: found.version + 1 };
	const entry = { at: new Date(now), kind: 'expire', points: expired, orderId: null, note: '' };
	const result = await accounts.updateOne(
		{ websiteId: data.websiteId, ...key, version: found.version },
		{
			$set: { lots: next.lots, balance: next.balance },
			$inc: { version: 1 },
			$push: { history: { $each: [entry], $slice: -HISTORY_KEPT } },
		},
		{ session },
	);
	// someone else changed it meanwhile: read it again
	if (result.modifiedCount !== 1) return loyaltyAccount(data, owner, { now, session, ...(rules ? { rules } : {}) });
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
	const key = before.userId ? { userId: before.userId } : { customerId: String(before.customerId ?? '') };
	const update = {
		$set: { lots: compacted, balance: balanceOf(compacted) },
		$inc: { version: 1, ...(entry.kind === 'earn' ? { lifetimeEarned: entry.points } : {}) },
		$push: { history: { $each: [entry], $slice: -HISTORY_KEPT } },
	};
	if (before.version === 0) {
		const result = await accounts.updateOne(
			{ websiteId: data.websiteId, ...key },
			{
				...update,
				$setOnInsert: {
					userId: before.userId ?? null,
					...(before.customerId ? { customerId: before.customerId } : {}),
					// an upsert gets no createdAt from the kit (CU-4)
					createdAt: entry.at,
				},
			},
			{ session, upsert: true },
		);
		return result.upsertedCount === 1 || result.modifiedCount === 1;
	}
	const result = await accounts.updateOne({ websiteId: data.websiteId, ...key, version: before.version }, update, {
		session,
	});
	return result.modifiedCount === 1;
};

/**
 * Spend points (redeemed at checkout).
 * @param {WebsiteData} data
 * @param {{ userId: LoyaltyOwner, points: number, orderId: string, note?: string }} spend
 * @param {{ now: number, session?: Session, rules?: LoyaltyRulesContext }} options
 * @returns {Promise<boolean>} false when the balance is too low or changed meanwhile
 */
export const spendPoints = async (data, { userId, points, orderId, note = '' }, { now, session, rules }) => {
	if (points <= 0) return true;
	const account = await loyaltyAccount(data, userId, { now, session, ...(rules ? { rules } : {}) });
	const spent = spendFromLots(account.lots, points);
	if (!spent.ok) return false;
	return writeAccount(data, account, spent.lots, { at: new Date(now), kind: 'redeem', points, orderId, note }, session);
};

/**
 * Give points: earned on a delivered order, given back after a cancel (`refund`), or a staff adjustment.
 * @param {WebsiteData} data
 * @param {{ userId: LoyaltyOwner, points: number, orderId: string | null, kind: 'earn' | 'refund' | 'adjust',
 *   expiresAt: Date | null, note?: string, customerId?: string | null }} give `customerId`: kept on a member's new account
 * @param {{ now: number, session?: Session, rules?: LoyaltyRulesContext }} options
 * @returns {Promise<boolean>} false when the account changed meanwhile (try again)
 */
export const givePoints = async (
	data,
	{ userId, points, orderId, kind, expiresAt, note = '', customerId = null },
	{ now, session, rules },
) => {
	if (points <= 0) return true;
	const account = await loyaltyAccount(data, userId, { now, session, ...(rules ? { rules } : {}) });
	if (account.version === 0 && customerId && !account.customerId) account.customerId = customerId;
	const lot = { id: createId('lot'), points, left: points, earnedAt: new Date(now), expiresAt, orderId, kind };
	return writeAccount(data, account, [...account.lots, lot], { at: new Date(now), kind, points, orderId, note }, session);
};

/**
 * Take points back (`reverse`: the order that earned them was returned; `adjust`: staff), never below 0.
 * @param {WebsiteData} data
 * @param {{ userId: LoyaltyOwner, points: number, orderId: string | null, kind: 'reverse' | 'adjust', note?: string }} take
 * @param {{ now: number, session?: Session, rules?: LoyaltyRulesContext }} options
 * @returns {Promise<{ ok: boolean, taken: number }>}
 */
export const takePoints = async (data, { userId, points, orderId, kind, note = '' }, { now, session, rules }) => {
	const account = await loyaltyAccount(data, userId, { now, session, ...(rules ? { rules } : {}) });
	const { lots, taken } = takeFromLots(account.lots, points, orderId);
	if (taken === 0) return { ok: true, taken: 0 };
	const ok = await writeAccount(data, account, lots, { at: new Date(now), kind, points: taken, orderId, note }, session);
	return { ok, taken: ok ? taken : 0 };
};

/**
 * Move a guest's loyalty account into a member's (E21: the member's verified phone matches the guest): the guest's lots
 * and history join the member's account, which takes the guest's customer id when it has none.
 * @param {WebsiteData} data
 * @param {{ customerId: string, userId: string }} move
 * @param {Session} [session]
 * @returns {Promise<number>} the points moved
 */
export const mergeLoyalty = async (data, { customerId, userId }, session) => {
	const accounts = data.collection(COLLECTIONS.loyalty);
	const guest = /** @type {LoyaltyRecord | null} */ (
		await accounts.findOne({ websiteId: data.websiteId, customerId, userId: null }, { session, projection: { _id: 0 } })
	);
	if (!guest) return 0;
	const member = /** @type {LoyaltyRecord | null} */ (
		await accounts.findOne({ websiteId: data.websiteId, userId }, { session, projection: { _id: 0 } })
	);
	if (!member) {
		await accounts.updateOne({ websiteId: data.websiteId, customerId, userId: null }, { $set: { userId } }, { session });
		return guest.balance;
	}
	const lots = compactLots([...member.lots, ...guest.lots]);
	const history = [...member.history, ...guest.history]
		.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
		.slice(-HISTORY_KEPT);
	await accounts.deleteOne({ websiteId: data.websiteId, customerId, userId: null }, { session });
	await accounts.updateOne(
		{ websiteId: data.websiteId, userId },
		{
			$set: { lots, history, balance: balanceOf(lots), ...(member.customerId ? {} : { customerId }) },
			$inc: { version: 1, lifetimeEarned: guest.lifetimeEarned ?? 0 },
		},
		{ session },
	);
	return guest.balance;
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

/** Escape a text for a regular expression. @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The highest sequence already used by an order number of a prefix and year (0 when none), whatever its digits.
 * @param {WebsiteData} data
 * @param {{ prefix: string, year: number, session?: Session }} options
 * @returns {Promise<number>}
 */
export const highestNumber = async (data, { prefix, year, session }) => {
	const [found] = await data
		.collection(COLLECTIONS.orders)
		.aggregate(
			[
				{ $match: { websiteId: data.websiteId, number: { $regex: `^${escapeRegex(prefix)}${year}-\\d{1,12}$` } } },
				{ $project: { n: { $toLong: { $arrayElemAt: [{ $split: ['$number', '-'] }, -1] } } } },
				{ $group: { _id: null, max: { $max: '$n' } } },
			],
			{ session },
		)
		.toArray();
	return Number(found?.max ?? 0);
};

/**
 * The counter of a prefix and year (E30).
 * @param {string} prefix @param {number} year
 */
export const counterId = (prefix, year) => `orders-${prefix}${year}`;

/**
 * The next order number of a year (the year in the business time zone, PLAN 0.8.10 K8; E30):
 * `<prefix><year>-<sequence of numberDigits>` (`SH-2026-0043`). A missing yearly counter starts after the highest
 * number already used for that prefix and year.
 * @param {WebsiteData} data
 * @param {{ prefix: string, year: number, digits?: number, session?: Session }} options
 */
const nextOrderNumber = async (data, { prefix, year, digits = 6, session }) => {
	const counters = data.collection(COLLECTIONS.counters);
	const id = counterId(prefix, year);
	const bump = () =>
		counters.findOneAndUpdate(
			{ websiteId: data.websiteId, id },
			{ $inc: { seq: 1 } },
			{ session, returnDocument: 'after', projection: { _id: 0, seq: 1 } },
		);
	let counter = /** @type {any} */ (await bump());
	if (!counter) {
		const used = await highestNumber(data, { prefix, year, ...(session ? { session } : {}) });
		try {
			await counters.updateOne(
				{ websiteId: data.websiteId, id },
				{ $setOnInsert: { id, seq: used } },
				{ session, upsert: true },
			);
		} catch (error) {
			if (!isDuplicate(error)) throw error;
		}
		counter = /** @type {any} */ (await bump());
	}
	return `${prefix}${year}-${String(counter?.seq ?? 1).padStart(Math.min(8, Math.max(4, digits)), '0')}`;
};

/**
 * Set the next order number of a prefix and year (E30 `POST /v1/orders/counter`), never at or below one already used.
 * @param {WebsiteData} data
 * @param {{ prefix: string, year: number, next: number }} input
 * @returns {Promise<{ ok: true, next: number } | { ok: false, used: number }>}
 */
export const setOrderCounter = async (data, { prefix, year, next }) => {
	const used = await highestNumber(data, { prefix, year });
	if (next <= used) return { ok: false, used };
	const id = counterId(prefix, year);
	await data
		.collection(COLLECTIONS.counters)
		.updateOne({ websiteId: data.websiteId, id }, { $set: { seq: next - 1 }, $setOnInsert: { id } }, { upsert: true });
	return { ok: true, next };
};

/**
 * The next order number a prefix and year would get (the counter's next, else after the highest used).
 * @param {WebsiteData} data
 * @param {{ prefix: string, year: number }} input
 */
export const peekOrderCounter = async (data, { prefix, year }) => {
	const counter = /** @type {any} */ (
		await data
			.collection(COLLECTIONS.counters)
			.findOne({ websiteId: data.websiteId, id: counterId(prefix, year) }, { projection: { _id: 0, seq: 1 } })
	);
	const used = await highestNumber(data, { prefix, year });
	return { next: Math.max(Number(counter?.seq ?? 0), used) + 1, used };
};

// ------------------------------------------------------------------------------------------------- placing orders

/**
 * @typedef {object} Placement
 * @property {Omit<OrderRecord, 'number' | 'createdAt' | 'updatedAt'>} order the order to insert (its lines' `locationId`
 *   are filled from where the stock was taken)
 * @property {string} numberPrefix the `checkout` setting (may be '')
 * @property {number} [numberDigits] the `checkout` setting (E30; default 6)
 * @property {string[]} [lockedDealIds] deals whose locks the order keeps (E18)
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
	// a guest's checkout key is theirs: guests are told apart by their customer id
	const owner = order.customer.userId || order.customer.customerId || '';
	const existing = async () =>
		/** @type {OrderRecord | null} */ (
			await orders.findOne(
				{
					websiteId: data.websiteId,
					'customer.userId': order.customer.userId,
					...(order.customer.userId ? {} : { 'customer.customerId': order.customer.customerId }),
					idempotencyKey: order.idempotencyKey,
				},
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
				digits: placement.numberDigits ?? 6,
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
					userId: owner,
					orderId: order.id,
					perCustomer: placement.couponPerCustomer ?? null,
					lockedDealIds: placement.lockedDealIds ?? [],
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
 * Swap the stock an edited order holds (E29), in one transaction: its old physical lines go back, the new ones are
 * held, and `update` writes the order (claimed by its `updatedAt`). Nothing changes when the new stock is short or the
 * order changed meanwhile.
 * @param {WebsiteData} data
 * @param {OrderRecord} order as read
 * @param {{ lines: StockLine[], update: (session: Session) => Promise<boolean> }} swap
 * @returns {Promise<{ ok: true } | { ok: false, code: 'out_of_stock', productId: string, variantId: string } | { ok: false, code: 'changed' }>}
 */
export const swapOrderStock = async (data, order, { lines, update }) => {
	try {
		return await data.transaction(async (session) => {
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
			const held = await holdStock(data, lines, { session });
			if (!held.ok) throw refused({ ok: false, code: 'out_of_stock', productId: held.productId, variantId: held.variantId });
			if (!(await update(session))) throw Object.assign(new Error('changed'), { changed: true });
			return /** @type {{ ok: true }} */ ({ ok: true });
		});
	} catch (error) {
		const failed = /** @type {any} */ (error);
		if (failed?.refused) return failed.refused;
		if (failed?.changed) return { ok: false, code: 'changed' };
		throw error;
	}
};

/**
 * The units of an order's lines its return claims already put back in stock (each line restocked once, E33; an
 * imported claim restocked as a whole, every line it did not keep out).
 * @param {WebsiteData} data @param {string} orderId @param {Session} [session]
 * @returns {Promise<Map<string, number>>} order line id → units
 */
const restockedByClaims = async (data, orderId, session) => {
	const claims =
		/** @type {Array<{ restockedAt?: Date | null, lines: Array<{ lineId: string, quantity: number,
		 *   restock?: boolean, restockedAt?: Date | null }> }>} */ (
			await data
				.collection(COLLECTIONS.returns)
				.find({ websiteId: data.websiteId, orderId }, { session, projection: { _id: 0, restockedAt: 1, lines: 1 } })
				.toArray()
		);
	/** @type {Map<string, number>} */
	const back = new Map();
	for (const claim of claims)
		for (const line of claim.lines)
			if (line.restockedAt || (claim.restockedAt && line.restock !== false))
				back.set(line.lineId, (back.get(line.lineId) ?? 0) + line.quantity);
	return back;
};

/**
 * Put a parcel's stock back after a return to origin (RTO) or a customer return (E27), once (`stockHeld`), with the
 * status change in `update`. Offer uses stay counted and points stay spent (the shopper used them); an RTO raises the
 * customer's RTO count (`countRto`); `restock: false` keeps the stock out (`returnRestock: no`). Units a return claim
 * already put back are not put back again, and a claim restocked later puts none back (`returnRestocked`, OR-10).
 * @param {WebsiteData} data
 * @param {OrderRecord} order
 * @param {{ update: (session: Session) => Promise<boolean>, restock?: boolean, countRto?: boolean }} options
 * @returns {Promise<boolean>}
 */
export const returnToOrigin = async (data, order, { update, restock = true, countRto = true }) =>
	data.transaction(async (session) => {
		const restocks = order.stockHeld && restock;
		const claimed = await data
			.collection(COLLECTIONS.orders)
			.updateOne(
				{ websiteId: data.websiteId, id: order.id, updatedAt: order.updatedAt },
				{ $set: { stockHeld: false, ...(restocks ? { returnRestocked: true } : {}) } },
				{ session },
			);
		if (claimed.modifiedCount !== 1) return false;
		if (!(await update(session))) throw new Error('order changed');
		if (restocks) {
			const back = await restockedByClaims(data, order.id, session);
			await releaseStock(
				data,
				order.lines
					.filter((line) => line.kind === 'physical')
					.map((line) => ({
						productId: line.productId,
						variantId: line.variantId,
						quantity: Math.max(0, line.quantity - (back.get(line.id) ?? 0)),
						locationId: line.locationId,
					})),
				session,
			);
		}
		if (countRto) await countReturnedParcel(data, order, session);
		return true;
	});

/**
 * Count a parcel that came back on its customer's record (K-6).
 * @param {WebsiteData} data @param {OrderRecord} order @param {Session} [session]
 */
const countReturnedParcel = async (data, order, session) => {
	await data
		.collection(COLLECTIONS.customers)
		.updateOne({ websiteId: data.websiteId, id: order.customer.customerId }, { $inc: { rtoCount: 1 } }, { session });
};

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

/**
 * Restock some lines of a return claim, each exactly once (the line's `restockedAt`), and mark their serials back in
 * stock (E33: restock per line). When no line is left to restock (each restocked, or kept out by staff with
 * `restock: false`), the claim's `restockedAt` is set too. An imported claim restocked as a whole is left alone. When
 * the order's own return already put its units back (`returnRestocked`), the lines are only marked (OR-10); the order
 * is written in the same transaction, so a return and a claim restocking at once never both put the units back.
 * @param {WebsiteData} data
 * @param {{ claimId: string, orderId?: string, lines: Array<StockLine & { lineId: string, serials: string[] }>,
 *   now: number }} restock non-physical lines come with quantity 0 (only marked)
 * @returns {Promise<string[]>} the line ids restocked now
 */
export const restockClaimLines = async (data, { claimId, orderId, lines, now }) =>
	data.transaction(async (session) => {
		const claims = data.collection(COLLECTIONS.returns);
		const at = new Date(now);
		const free = orderId
			? (
					await data
						.collection(COLLECTIONS.orders)
						.updateOne(
							{ websiteId: data.websiteId, id: orderId, returnRestocked: { $ne: true } },
							{ $set: { claimRestockedAt: at } },
							{ session },
						)
				).matchedCount === 1
			: true;
		/** @type {string[]} */
		const done = [];
		for (const raw of lines) {
			const line = free ? raw : { ...raw, quantity: 0 };
			const marked = await claims.updateOne(
				{
					websiteId: data.websiteId,
					id: claimId,
					restockedAt: null,
					lines: { $elemMatch: { lineId: line.lineId, restockedAt: null } },
				},
				{ $set: { 'lines.$.restockedAt': at } },
				{ session },
			);
			if (marked.modifiedCount !== 1) continue;
			done.push(line.lineId);
			await releaseStock(data, [line], session);
			if (line.serials.length > 0)
				await data
					.collection(COLLECTIONS.serials)
					.updateMany(
						{ websiteId: data.websiteId, serial: { $in: line.serials }, status: 'sold' },
						{ $set: { status: 'in_stock', orderId: null, lineId: null } },
						{ session },
					);
		}
		const claim = /** @type {{ lines: Array<{ restock?: boolean, restockedAt?: Date | null }> } | null} */ (
			await claims.findOne({ websiteId: data.websiteId, id: claimId }, { session, projection: { _id: 0, lines: 1 } })
		);
		if (claim && claim.lines.every((line) => line.restock === false || line.restockedAt))
			await claims.updateOne(
				{ websiteId: data.websiteId, id: claimId, restockedAt: null },
				{ $set: { restockedAt: at } },
				{ session },
			);
		return done;
	});

/**
 * What the `products.changed` hook needs (`{ productIds, before }`, back-in-stock alerts, E34) about the stock an
 * order holds, read before it is given back (cancel, an ended window, a refund before delivery, a return to origin or
 * a customer's return); null when the order holds no stock.
 * @param {WebsiteData} data
 * @param {OrderRecord} order as read before
 * @returns {Promise<{ productIds: string[], before: Map<string, { price: number, inStock: boolean }> } | null>}
 */
export const heldStockBefore = async (data, order) => {
	const ids = [...new Set(order.lines.filter((line) => line.kind === 'physical').map((line) => line.productId))];
	if (!order.stockHeld || ids.length === 0) return null;
	const found = /** @type {Array<{ id: string, price: number, inStock: boolean }>} */ (
		await data
			.collection(COLLECTIONS.products)
			.find({ websiteId: data.websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1, price: 1, inStock: 1 } })
			.toArray()
	);
	return { productIds: ids, before: new Map(found.map((p) => [p.id, { price: p.price, inStock: p.inStock }])) };
};
