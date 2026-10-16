/**
 * The shop's ledger: every write that moves stock, offer uses, loyalty points, booked slots or serial numbers (PLAN
 * 0.8.8). Placing an order does all of them and inserts the order in **one database transaction** in the merchant
 * database, with no network call between the parts: either everything happens or nothing does. A transition of an
 * order (`applyTransition`: the order engine's plan, `core/transitions.js`) writes the order and every ledger effect of
 * it in one transaction too, guarded by the order's facts, so giving back (cancel, payment window ended, return to
 * origin, a delete) happens exactly once; a return claim's restock is guarded per line.
 *
 * Every function takes the website's guarded merchant database (`WebsiteData`, from `ctx.data()`) and, where it can
 * run inside a transaction, the driver session.
 * @module
 */
import { createId } from '@ss/contracts';
import { zonedParts } from '@ss/contracts/format';
import { summarize } from '../core/catalog.js';
import { unitKeys } from '../core/fields.js';
import { COLLECTIONS, ID_PREFIX, isDuplicate } from '../core/model.js';
import { lotsByRule } from '../core/loyalty.js';
import { piecesOf } from '../core/measure.js';
import { counterIdOf, counterNumbers, numberFormOf, orderNumberOf } from '../core/order-numbers.js';
import { balanceOf, compactLots, expireLots, spendFromLots, takeFromLots } from '../core/points.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('mongodb').ClientSession} Session */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').LoyaltyRecord} LoyaltyRecord */
/** @typedef {import('../core/order-numbers.js').NumberForm} NumberForm */
/** @typedef {import('../core/order-numbers.js').NumberAt} NumberAt */

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

/**
 * Units an order took from a variant that tracks stock, and what the variant holds after (for the stock events, E44).
 * @typedef {{ productId: string, variantId: string, quantity: number, left: number }} TakenStock
 */

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
 * and `grades` (PLAN 0.8.10 E2, E8); a change of the price or of whether it can be bought also stamps
 * `contentUpdatedAt`.
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
		if (same) continue;
		// whether it can be bought, or its price, changed: what its page shows changed (the sitemap's lastmod, G8.4), at
		// the time of this write
		const shown = next.price !== product.price || next.priceMax !== product.priceMax || next.inStock !== product.inStock;
		const written = await products.findOneAndUpdate(
			{ websiteId: data.websiteId, id },
			{ $set: next },
			{ session, returnDocument: 'after', projection: { _id: 0, updatedAt: 1 } },
		);
		if (shown && written)
			await products.updateOne(
				{ websiteId: data.websiteId, id },
				{ $set: { contentUpdatedAt: written.updatedAt, updatedAt: written.updatedAt } },
				{ session },
			);
	}
};

/**
 * Hold stock for lines (an order's placement). Stock is taken from the variant's `stock`, and with locations from the
 * first location in `locationOrder` that has the whole quantity. A product that does not track stock is not touched.
 * `left` is what the variant holds right after (null when stock is not tracked), read in the same write.
 * @param {WebsiteData} data
 * @param {StockLine[]} lines
 * @param {{ locationOrder?: string[], session?: Session }} [options]
 * @returns {Promise<{ ok: true, taken: Array<StockLine & { locationId: string | null, left: number | null }> } | { ok: false, productId: string, variantId: string }>}
 */
export const holdStock = async (data, lines, { locationOrder = [], session } = {}) => {
	const products = data.collection(COLLECTIONS.products);
	/** @type {Array<StockLine & { locationId: string | null, left: number | null }>} */
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
			taken.push({ ...line, locationId: null, left: null });
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
			const after = /** @type {{ variants: Array<{ id: string, stock: number }> } | null} */ (
				await products.findOneAndUpdate(
					{ websiteId: data.websiteId, id: line.productId, status: 'active', variants: { $elemMatch: match } },
					{ $inc: inc },
					{ session, returnDocument: 'after', projection: { _id: 0, 'variants.id': 1, 'variants.stock': 1 } },
				)
			);
			if (after) {
				const left = after.variants.find((variant) => variant.id === line.variantId)?.stock ?? 0;
				taken.push({ ...line, locationId, left });
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
		// the next number after the highest kept (a use a cancel gave back leaves a gap, so the count could repeat one);
		// a concurrent checkout of the same customer takes the same seq and fails on the unique index
		const [last] = await uses
			.find({ websiteId, couponId, userId }, { session, projection: { _id: 0, seq: 1 } })
			.sort({ seq: -1 })
			.limit(1)
			.toArray();
		await uses.insertOne({ couponId, userId, orderId, seq: Number(last?.seq ?? 0) + 1 }, { session });
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

/**
 * The highest sequence one counter already gave (0 when none), whatever its digits: the numbers of its month, its year
 * or all time, as the form's period is.
 * @param {WebsiteData} data
 * @param {{ form: NumberForm, at: NumberAt, session?: Session }} options
 * @returns {Promise<number>}
 */
const highestNumber = async (data, { form, at, session }) => {
	const numbers = counterNumbers(form, at);
	const [found] = await data
		.collection(COLLECTIONS.orders)
		.aggregate(
			[
				{ $match: { websiteId: data.websiteId, number: { $regex: numbers } } },
				{ $project: { found: { $regexFind: { input: '$number', regex: numbers } } } },
				{ $project: { n: { $toLong: { $arrayElemAt: ['$found.captures', 0] } } } },
				{ $group: { _id: null, max: { $max: '$n' } } },
			],
			{ session },
		)
		.toArray();
	return Number(found?.max ?? 0);
};

/**
 * The next order number (E30, E29, `core/order-numbers.js`): the website's pattern filled with the sequence of its
 * counter — one running counter, or the counter of the year or month (in the business time zone, PLAN 0.8.10 K8). A
 * missing counter starts after the highest number already used in its form.
 * @param {WebsiteData} data
 * @param {{ form: NumberForm, at: NumberAt, session?: Session }} options
 */
const nextOrderNumber = async (data, { form, at, session }) => {
	const counters = data.collection(COLLECTIONS.counters);
	const id = counterIdOf(form, at);
	const bump = () =>
		counters.findOneAndUpdate(
			{ websiteId: data.websiteId, id },
			{ $inc: { seq: 1 } },
			{ session, returnDocument: 'after', projection: { _id: 0, seq: 1 } },
		);
	let counter = /** @type {any} */ (await bump());
	if (!counter) {
		const used = await highestNumber(data, { form, at, ...(session ? { session } : {}) });
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
	return orderNumberOf(form, { ...at, sequence: Number(counter?.seq ?? 1) });
};

/**
 * Set the next sequence of a counter (E30 `POST /v1/orders/counter`: the running one, or a year's or month's), never at
 * or below one already used.
 * @param {WebsiteData} data
 * @param {{ form: NumberForm, at: NumberAt, next: number }} input `at`: only a form with a year (and month) reads it
 * @returns {Promise<{ ok: true, next: number } | { ok: false, used: number }>}
 */
export const setOrderCounter = async (data, { form, at, next }) => {
	const used = await highestNumber(data, { form, at });
	if (next <= used) return { ok: false, used };
	const id = counterIdOf(form, at);
	await data
		.collection(COLLECTIONS.counters)
		.updateOne({ websiteId: data.websiteId, id }, { $set: { seq: next - 1 }, $setOnInsert: { id } }, { upsert: true });
	return { ok: true, next };
};

/**
 * Move a counter past the highest number already used in its form, never back (it fell behind them: set back while an
 * order was placed, or orders imported before it moved on).
 * @param {WebsiteData} data
 * @param {{ form: NumberForm, at: NumberAt }} numbering
 */
const counterPast = async (data, { form, at }) => {
	const used = await highestNumber(data, { form, at });
	const id = counterIdOf(form, at);
	await data
		.collection(COLLECTIONS.counters)
		.updateOne({ websiteId: data.websiteId, id }, { $max: { seq: used }, $setOnInsert: { id } }, { upsert: true });
};

// ------------------------------------------------------------------------------------------------- placing orders

/**
 * @typedef {object} Placement
 * @property {Omit<OrderRecord, 'number' | 'createdAt' | 'updatedAt'>} order the order to insert (its lines' `locationId`
 *   are filled from where the stock was taken)
 * @property {string} numberPrefix the `checkout` setting (may be '')
 * @property {number} [numberDigits] the `checkout` setting (E30; default 6)
 * @property {string} [numberPattern] the `checkout` setting (E30, E29; default one running counter)
 * @property {string} [numberSuffix] the `checkout` setting (E29; may be '')
 * @property {string[]} [lockedDealIds] deals whose locks the order keeps (E18)
 * @property {string[]} [locationOrder] locations to take stock from, in order (multi_location)
 * @property {number | null} [couponPerCustomer] the coupon's per-customer limit
 * @property {string} [offersOwner] whose uses of a coupon the order counts when not its customer's own: the member a
 *   guest's phone names (K-6)
 * @property {Array<{ productId: string, start: Date, end: Date, lineId: string }>} [slots] booked slots
 */

/**
 * @typedef {{ ok: true, order: OrderRecord, duplicate: boolean, taken: TakenStock[] }
 *   | { ok: false, code: 'out_of_stock', productId: string, variantId: string }
 *   | { ok: false, code: 'offer_unavailable', offerId: string }
 *   | { ok: false, code: 'points_changed' }
 *   | { ok: false, code: 'slot_taken' }} PlacementResult
 *   `duplicate`: the same customer already placed an order with this checkout key (that order is returned); `taken`: the
 *   stock the order took (none for a duplicate)
 */

/**
 * The held lines of variants that track stock, as the stock events take them.
 * @param {Array<StockLine & { left: number | null }>} taken
 * @returns {TakenStock[]}
 */
const tracked = (taken) =>
	taken.flatMap((line) =>
		line.left === null
			? []
			: [{ productId: line.productId, variantId: line.variantId, quantity: line.quantity, left: line.left }],
	);

/**
 * Add units to the products' `ordered` counts (parity P3-10: units of orders placed and not given back before delivery),
 * one write per product; negative units take them off. Counted in pieces: a measured line is one (`core/measure.js`).
 * @param {WebsiteData} data @param {ReadonlyArray<{ productId: string, quantity: number }>} lines @param {Session} [session]
 */
const countOrdered = async (data, lines, session) => {
	/** @type {Map<string, number>} */
	const units = new Map();
	for (const line of lines) units.set(line.productId, (units.get(line.productId) ?? 0) + line.quantity);
	for (const [productId, quantity] of units)
		if (quantity !== 0)
			await data
				.collection(COLLECTIONS.products)
				.updateOne({ websiteId: data.websiteId, id: productId }, { $inc: { ordered: quantity } }, { session });
};

/**
 * A business-rule refusal inside the transaction: thrown, it aborts everything.
 * @param {Exclude<PlacementResult, { ok: true }>} result
 */
const refused = (result) => Object.assign(new Error(result.code), { refused: result });

/**
 * Place an order in one transaction: number it, hold its stock, count its offer uses, spend its points, hold its
 * booked slots, count its units as ordered and insert it. Nothing is written when any part fails. A number used already
 * (its counter fell behind the numbers of its form) moves the counter past the highest and places it again, once.
 * @param {WebsiteData} data
 * @param {Placement} placement
 * @param {{ now: number, timeZone?: string }} clock `timeZone`: the business.json time zone (UTC when missing), whose
 *   year numbers the order
 * @returns {Promise<PlacementResult>}
 */
export const placeOrder = async (data, placement, { now, timeZone = 'UTC' }) => {
	const { order } = placement;
	const orders = data.collection(COLLECTIONS.orders);
	// whose coupon uses: the member (a guest on a member's phone counts as that member), else the guest's customer id
	const owner = placement.offersOwner || order.customer.userId || order.customer.customerId || '';
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
	if (before) return { ok: true, order: before, duplicate: true, taken: [] };
	const { year, month } = zonedParts(now, timeZone);
	const numbering = { form: numberFormOf(placement), at: { year, month } };
	for (let attempt = 1; ; attempt += 1) {
		try {
			const placed = await data.transaction(async (session) => {
				const number = await nextOrderNumber(data, { ...numbering, session });
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
				await countOrdered(
					data,
					order.lines.map((line) => ({ productId: line.productId, quantity: piecesOf(line) })),
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
				return { record, taken: tracked(stock.taken) };
			});
			return {
				ok: true,
				order: /** @type {OrderRecord} */ (/** @type {unknown} */ (placed.record)),
				duplicate: false,
				taken: placed.taken,
			};
		} catch (error) {
			if (error instanceof Error && 'refused' in error) return /** @type {any} */ (error).refused;
			if (duplicateIn(error, COLLECTIONS.slots)) return { ok: false, code: 'slot_taken' };
			if (duplicateIn(error, COLLECTIONS.couponUses))
				return { ok: false, code: 'offer_unavailable', offerId: order.promotions.couponId ?? '' };
			if (duplicateIn(error, COLLECTIONS.orders)) {
				const won = await existing();
				if (won) return { ok: true, order: won, duplicate: true, taken: [] };
				// its number is used already: the counter fell behind the numbers of its form (set back while an order was
				// placed, or orders imported before it moved on), so it moves past the highest and the order is numbered
				// again, once
				if (attempt === 1) {
					await counterPast(data, numbering);
					continue;
				}
			}
			throw error;
		}
	}
};

/**
 * Swap the stock an edited order holds (E29), in one transaction: its old physical lines go back, the new ones are
 * held, its old lines leave the `ordered` counts (while it held them) and its new ones join them, and `update` writes
 * the order (claimed by its `updatedAt`). Nothing changes when the new stock is short or the order changed meanwhile.
 * `taken`: the variants the edit leaves with fewer units than before, by how many.
 * @param {WebsiteData} data
 * @param {OrderRecord} order as read
 * @param {{ lines: StockLine[], ordered: ReadonlyArray<{ productId: string, quantity: number }>,
 *   update: (session: Session) => Promise<boolean> }} swap `ordered`: every new line (any kind)
 * @returns {Promise<{ ok: true, taken: TakenStock[] } | { ok: false, code: 'out_of_stock', productId: string, variantId: string } | { ok: false, code: 'changed' }>}
 */
export const swapOrderStock = async (data, order, { lines, ordered, update }) => {
	try {
		return await data.transaction(async (session) => {
			await countOrdered(
				data,
				[
					...(order.stockHeld ? order.lines.map((line) => ({ productId: line.productId, quantity: -piecesOf(line) })) : []),
					...ordered,
				],
				session,
			);
			const back = order.stockHeld
				? order.lines
						.filter((line) => line.kind === 'physical')
						.map((line) => ({
							productId: line.productId,
							variantId: line.variantId,
							quantity: line.quantity,
							locationId: line.locationId,
						}))
				: [];
			if (back.length > 0) await releaseStock(data, back, session);
			const held = await holdStock(data, lines, { session });
			if (!held.ok) throw refused({ ok: false, code: 'out_of_stock', productId: held.productId, variantId: held.variantId });
			if (!(await update(session))) throw Object.assign(new Error('changed'), { changed: true });
			// what each variant lost overall: the units held now less those the old lines gave back
			const returned = new Map(mergeStockLines(back).map((line) => [`${line.productId}|${line.variantId}`, line.quantity]));
			const taken = tracked(held.taken).flatMap((line) => {
				const quantity = line.quantity - (returned.get(`${line.productId}|${line.variantId}`) ?? 0);
				return quantity > 0 ? [{ ...line, quantity }] : [];
			});
			return /** @type {{ ok: true, taken: TakenStock[] }} */ ({ ok: true, taken });
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

// ---------------------------------------------------------------------------------------------- serial numbers

/**
 * A serial number the shop refuses (thrown inside a transaction, which it aborts): the field and the message.
 * @param {string} lineId @param {string} message
 */
const unitRefused = (lineId, message) => Object.assign(new Error('serial'), { refusal: { field: `serials/${lineId}`, message } });

/**
 * The refusal a serial number write threw, or null.
 * @param {unknown} error
 * @returns {{ field: string, message: string } | null}
 */
export const unitRefusalOf = (error) =>
	typeof error === 'object' && error !== null && typeof (/** @type {any} */ (error).refusal?.field) === 'string'
		? /** @type {any} */ (error).refusal
		: null;

/**
 * Capture the units of a plan (E11, dynamic model §1): units of a line whose item type picks them from stock move from
 * stock to the order; typed ones are recorded as sold to it with their values (a unit in stock typed by staff is taken
 * from stock; a unit sharing any number with another unit is refused). Units a line no longer lists go back in stock
 * (typed ones are forgotten).
 * @param {WebsiteData} data
 * @param {{ orderId: string, plan: import('../core/transitions.js').UnitsPlan }} capture
 * @param {Session} session
 */
const captureUnits = async (data, { orderId, plan }, session) => {
	const serials = data.collection(COLLECTIONS.serials);
	for (const line of plan) {
		const typedUnits = new Map((line.units ?? []).map((unit) => [unit.serial, unit]));
		const removed = line.before.filter((serial) => !line.serials.includes(serial));
		if (removed.length > 0) {
			const mine = { websiteId: data.websiteId, orderId, lineId: line.lineId, serial: { $in: removed }, status: 'sold' };
			await serials.deleteMany({ ...mine, typed: true }, { session });
			await serials.updateMany(mine, { $set: { status: 'in_stock', orderId: null, lineId: null } }, { session });
		}
		for (const serial of line.serials) {
			if (line.before.includes(serial)) continue;
			const taken = await serials.updateOne(
				{ websiteId: data.websiteId, variantId: line.variantId, serial, status: 'in_stock' },
				{ $set: { status: 'sold', orderId, lineId: line.lineId } },
				{ session },
			);
			if (taken.modifiedCount === 1) continue;
			if (line.capture === 'stock') throw unitRefused(line.lineId, `Serial number ${serial} is not in stock for this item.`);
			const unit = typedUnits.get(serial) ?? { serial, values: {}, keys: unitKeys(serial) };
			const known = await serials.findOne(
				{ websiteId: data.websiteId, keys: { $in: unit.keys } },
				{ session, projection: { _id: 0, serial: 1 } },
			);
			if (known)
				throw unitRefused(line.lineId, `A number of unit ${serial} is already recorded for unit ${String(known.serial)}.`);
			await serials
				.insertOne(
					{
						id: createId(ID_PREFIX.serial),
						productId: line.productId,
						variantId: line.variantId,
						serial,
						values: unit.values,
						keys: unit.keys,
						status: 'sold',
						orderId,
						lineId: line.lineId,
						locationId: null,
						typed: true,
					},
					{ session },
				)
				.catch((/** @type {unknown} */ error) => {
					// another unit took one of its numbers meanwhile (the unique keys)
					throw isDuplicate(error)
						? unitRefused(line.lineId, `A number of unit ${serial} is already recorded for another unit.`)
						: error;
				});
		}
	}
};

/**
 * Serial numbers of an order back in stock (cancel, return, back from packed, delete); numbers typed for it (E11) were
 * never in stock, so their records go.
 * @param {WebsiteData} data @param {string} orderId @param {Session} session
 */
const releaseUnits = async (data, orderId, session) => {
	const serials = data.collection(COLLECTIONS.serials);
	await serials.deleteMany({ websiteId: data.websiteId, orderId, status: 'sold', typed: true }, { session });
	await serials.updateMany(
		{ websiteId: data.websiteId, orderId, status: 'sold' },
		{ $set: { status: 'in_stock', orderId: null, lineId: null } },
		{ session },
	);
};

// ------------------------------------------------------------------------------------------------- transitions

/** A loyalty account changed while a transition wrote it (thrown inside the transaction: try the transition again). */
const pointsChanged = () => Object.assign(new Error('points changed'), { pointsChanged: true });

/**
 * Whether a transition failed because a loyalty account changed meanwhile (try it again).
 * @param {unknown} error
 */
export const isPointsChanged = (error) =>
	typeof error === 'object' && error !== null && /** @type {any} */ (error).pointsChanged === true;

/**
 * One ledger effect of a transition, in its transaction.
 * @param {WebsiteData} data @param {string} orderId
 * @param {import('../core/transitions.js').LedgerEffect} effect
 * @param {{ now: number, session: Session }} options
 */
const applyEffect = async (data, orderId, effect, { now, session }) => {
	const { websiteId } = data;
	switch (effect.kind) {
		case 'release_stock':
			await releaseStock(data, effect.lines, session);
			return;
		case 'release_slots':
			await releaseSlots(data, orderId, session);
			return;
		case 'release_offers':
			await releaseOffers(data, { ...effect, orderId }, session);
			return;
		case 'give_points': {
			const given = await givePoints(
				data,
				{
					userId: effect.owner,
					points: effect.points,
					orderId,
					kind: effect.reason,
					expiresAt: effect.expiresAt,
					note: effect.note,
				},
				{ now, session },
			);
			if (!given) throw pointsChanged();
			return;
		}
		case 'take_points': {
			const taken = await takePoints(
				data,
				{ userId: effect.owner, points: effect.points, orderId, kind: 'reverse', note: effect.note },
				{ now, session },
			);
			if (!taken.ok) throw pointsChanged();
			return;
		}
		case 'restock_return': {
			// units a return claim already put back are not put back again (OR-10)
			const back = await restockedByClaims(data, orderId, session);
			await releaseStock(
				data,
				effect.lines.map((line) => ({ ...line, quantity: Math.max(0, line.quantity - (back.get(line.lineId) ?? 0)) })),
				session,
			);
			return;
		}
		case 'count_sold':
			for (const line of effect.lines)
				await data
					.collection(COLLECTIONS.products)
					.updateOne({ websiteId, id: line.productId }, { $inc: { sold: line.quantity } }, { session });
			return;
		case 'count_ordered':
			await countOrdered(data, effect.lines, session);
			return;
		case 'count_rto':
			// a package that came back counts on its customer's record (K-6)
			await data
				.collection(COLLECTIONS.customers)
				.updateOne({ websiteId, id: effect.customerId }, { $inc: { rtoCount: 1 } }, { session });
			return;
		case 'release_units':
			await releaseUnits(data, orderId, session);
			return;
		case 'capture_units':
			await captureUnits(data, { orderId, plan: effect.plan }, session);
			return;
		default:
			throw new Error(`unknown ledger effect ${/** @type {any} */ (effect).kind}`);
	}
};

/**
 * Apply a transition of an order in one transaction: the order's write, only while it still matches `guard` (its
 * status, `updatedAt` and facts as read: compare-and-set), then each ledger effect of the plan, and with `remove` the
 * order's delete (E31: what it gives back and the delete happen together). Nothing is written when the order changed
 * meanwhile; a refused serial number or a loyalty account that changed meanwhile aborts it all (`unitRefusalOf`,
 * `isPointsChanged`).
 * @param {WebsiteData} data
 * @param {{ orderId: string, guard: Record<string, unknown>, update: Record<string, unknown>,
 *   effects: ReadonlyArray<import('../core/transitions.js').LedgerEffect>, remove?: boolean }} transition
 * @param {{ now: number }} clock
 * @returns {Promise<boolean>} false when the order changed meanwhile
 */
export const applyTransition = (data, { orderId, guard, update, effects, remove = false }, { now }) =>
	data.transaction(async (session) => {
		const orders = data.collection(COLLECTIONS.orders);
		const written = await orders.updateOne({ ...guard, websiteId: data.websiteId, id: orderId }, update, { session });
		if (written.modifiedCount !== 1) return false;
		for (const effect of effects) await applyEffect(data, orderId, effect, { now, session });
		if (remove) await orders.deleteOne({ websiteId: data.websiteId, id: orderId }, { session });
		return true;
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
