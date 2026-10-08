/**
 * The promotions part's queries in the merchant database: coupons, deals and bundles (read for pricing, written by the
 * merchant's staff and server), the references their scopes name, and the data-rights reads and deletes of loyalty
 * accounts and coupon uses. Offer use counters and loyalty points are changed only by the ledger (`adapters/ledger.js`).
 * @module
 */
import { COLLECTIONS } from '../core/model.js';
import { normaliseCode } from '../core/coupons.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').DealRecord} DealRecord */
/** @typedef {import('../core/model.js').BundleRecord} BundleRecord */
/** @typedef {import('../core/model.js').CouponRecord} CouponRecord */
/** @typedef {'coupons' | 'deals' | 'bundles'} OfferCollection */

/** Most deals or bundles loaded for one cart. */
const MAX_LIVE_OFFERS = 500;

/** Merchant database indexes of this part. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: COLLECTIONS.coupons, keys: { websiteId: 1, code: 1 }, name: 'by_code', unique: true },
	{ collection: COLLECTIONS.coupons, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.coupons, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: COLLECTIONS.deals, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.deals, keys: { websiteId: 1, active: 1, startsAt: 1, endsAt: 1 }, name: 'live' },
	{ collection: COLLECTIONS.deals, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: COLLECTIONS.bundles, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.bundles, keys: { websiteId: 1, active: 1, startsAt: 1, endsAt: 1 }, name: 'live' },
	{ collection: COLLECTIONS.bundles, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
];

/**
 * A duplicate-key error of the driver (a single write, or a bulk write whose every failure is one).
 * @param {unknown} error
 */
export const isDuplicate = (error) => {
	if (typeof error !== 'object' || error === null) return false;
	const failures = /** @type {any} */ (error).writeErrors;
	if (Array.isArray(failures) && failures.length > 0) return failures.every((item) => item?.code === 11000);
	return /** @type {any} */ (error).code === 11000;
};

/**
 * Live offers of a collection: switched on, started, not ended, under their use limit.
 * @param {WebsiteData} data
 * @param {'deals' | 'bundles'} collection
 * @param {number} now
 */
const liveOffers = async (data, collection, now) => {
	const at = new Date(now);
	return /** @type {Promise<any[]>} */ (
		data
			.collection(COLLECTIONS[collection])
			.find(
				{
					websiteId: data.websiteId,
					active: true,
					$and: [
						{ $or: [{ startsAt: null }, { startsAt: { $lte: at } }] },
						{ $or: [{ endsAt: null }, { endsAt: { $gt: at } }] },
						{ $or: [{ limit: null }, { $expr: { $lt: ['$used', '$limit'] } }] },
					],
				},
				{ projection: { _id: 0, websiteId: 0, merchantId: 0 } },
			)
			.sort({ id: 1 })
			.limit(MAX_LIVE_OFFERS)
			.toArray()
	);
};

/**
 * The offers that may apply now: active deals and bundles within their dates and under their limits, and the coupon of
 * a code (null when the code is empty or unknown; an inactive or expired coupon is returned so pricing can say why it
 * does not apply). Checkout prices carts with them, and the Chat lookups quote savings with them.
 * @param {WebsiteData} data
 * @param {{ now: number, couponCode?: string, deals?: boolean, bundles?: boolean }} options `deals` / `bundles`: whether
 *   those features are on (off: none are loaded)
 * @returns {Promise<{ deals: DealRecord[], bundles: BundleRecord[], coupon: CouponRecord | null }>}
 */
export const loadOffers = async (data, { now, couponCode = '', deals = false, bundles = false }) => {
	const code = normaliseCode(couponCode);
	const [dealList, bundleList, coupon] = await Promise.all([
		deals ? liveOffers(data, 'deals', now) : [],
		bundles ? liveOffers(data, 'bundles', now) : [],
		code
			? data
					.collection(COLLECTIONS.coupons)
					.findOne({ websiteId: data.websiteId, code }, { projection: { _id: 0, websiteId: 0, merchantId: 0 } })
			: null,
	]);
	return { deals: dealList, bundles: bundleList, coupon: /** @type {CouponRecord | null} */ (coupon) };
};

// -------------------------------------------------------------------------------------------- merchant writes

/**
 * One page of offers, newest first (`after`: the cursor `[createdAt ISO, id]` of the last one shown).
 * @param {WebsiteData} data
 * @param {OfferCollection} collection
 * @param {{ after: unknown, limit: number, active?: boolean, q?: string }} options `q`: a coupon code or offer name prefix
 */
export const listOffers = async (data, collection, { after, limit, active, q }) => {
	/** @type {Record<string, unknown>} */
	const filter = { websiteId: data.websiteId };
	if (active !== undefined) filter.active = active;
	if (q) {
		const prefix = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		filter[collection === 'coupons' ? 'code' : 'name'] = {
			$regex: `^${collection === 'coupons' ? prefix.toUpperCase() : prefix}`,
			...(collection === 'coupons' ? {} : { $options: 'i' }),
		};
	}
	if (Array.isArray(after) && typeof after[0] === 'string' && typeof after[1] === 'string') {
		const at = new Date(after[0]);
		filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, id: { $lt: after[1] } }];
	}
	return /** @type {Promise<any[]>} */ (
		data
			.collection(COLLECTIONS[collection])
			.find(filter, { projection: { _id: 0, websiteId: 0, merchantId: 0 } })
			.sort({ createdAt: -1, id: -1 })
			.limit(limit)
			.toArray()
	);
};

/**
 * @param {WebsiteData} data
 * @param {OfferCollection} collection
 * @param {string} id
 */
export const getOffer = async (data, collection, id) =>
	/** @type {Promise<any>} */ (
		data
			.collection(COLLECTIONS[collection])
			.findOne({ websiteId: data.websiteId, id }, { projection: { _id: 0, websiteId: 0, merchantId: 0 } })
	);

/**
 * Insert offers (a duplicate coupon code throws the driver's duplicate-key error).
 * @param {WebsiteData} data
 * @param {OfferCollection} collection
 * @param {Array<Record<string, unknown>>} records
 * @param {{ skipDuplicates?: boolean }} [options] insert the others when some codes are taken (batches)
 * @returns {Promise<string[]>} ids inserted
 */
export const insertOffers = async (data, collection, records, { skipDuplicates = false } = {}) => {
	if (records.length === 0) return [];
	try {
		await data.collection(COLLECTIONS[collection]).insertMany(
			records.map((record) => ({ ...record })),
			{ ordered: !skipDuplicates },
		);
		return records.map((record) => String(record.id));
	} catch (error) {
		if (!skipDuplicates || !isDuplicate(error)) throw error;
		/** @type {any[]} */
		const failures = /** @type {any} */ (error).writeErrors ?? [];
		const failed = new Set(failures.map((item) => item.index ?? item.err?.index));
		return records.filter((_, index) => !failed.has(index)).map((record) => String(record.id));
	}
};

/**
 * Replace the editable fields of an offer (never `used`).
 * @param {WebsiteData} data
 * @param {OfferCollection} collection
 * @param {string} id
 * @param {Record<string, unknown>} fields
 */
export const updateOffer = async (data, collection, id, fields) => {
	const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'used' && key !== 'id'));
	return /** @type {Promise<any>} */ (
		data
			.collection(COLLECTIONS[collection])
			.findOneAndUpdate(
				{ websiteId: data.websiteId, id },
				{ $set: rest },
				{ returnDocument: 'after', projection: { _id: 0, websiteId: 0, merchantId: 0 } },
			)
	);
};

/**
 * @param {WebsiteData} data
 * @param {OfferCollection} collection
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export const deleteOffer = async (data, collection, id) =>
	(await data.collection(COLLECTIONS[collection]).deleteOne({ websiteId: data.websiteId, id })).deletedCount === 1;

/**
 * The ids a scope names that do not exist (products, categories, brands).
 * @param {WebsiteData} data
 * @param {{ productIds: string[], categoryIds: string[], brandIds: string[] }} refs
 * @returns {Promise<{ productIds: string[], categoryIds: string[], brandIds: string[] }>}
 */
export const missingRefs = async (data, refs) => {
	/** @param {'products' | 'categories' | 'brands'} collection @param {string[]} ids */
	const missing = async (collection, ids) => {
		if (ids.length === 0) return [];
		const found = new Set(
			(
				await data
					.collection(COLLECTIONS[collection])
					.find({ websiteId: data.websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1 } })
					.toArray()
			).map((doc) => doc.id),
		);
		return ids.filter((id) => !found.has(id));
	};
	const [productIds, categoryIds, brandIds] = await Promise.all([
		missing('products', refs.productIds),
		missing('categories', refs.categoryIds),
		missing('brands', refs.brandIds),
	]);
	return { productIds, categoryIds, brandIds };
};

// ---------------------------------------------------------------------------------------------- shopper reads

/**
 * An active product.
 * @param {WebsiteData} data
 * @param {string} id
 * @returns {Promise<import('../core/model.js').ProductRecord | null>}
 */
export const activeProduct = async (data, id) =>
	/** @type {Promise<any>} */ (
		data
			.collection(COLLECTIONS.products)
			.findOne({ websiteId: data.websiteId, id, status: 'active' }, { projection: { _id: 0, websiteId: 0, merchantId: 0 } })
	);

/**
 * Categories with all their ancestors (from each category's `path`).
 * @param {WebsiteData} data
 * @param {string[]} categoryIds
 * @returns {Promise<string[]>}
 */
export const categoryTrail = async (data, categoryIds) => {
	if (categoryIds.length === 0) return [];
	const found = await data
		.collection(COLLECTIONS.categories)
		.find({ websiteId: data.websiteId, id: { $in: categoryIds } }, { projection: { _id: 0, id: 1, path: 1 } })
		.toArray();
	return [...new Set([...categoryIds, ...found.flatMap((doc) => (Array.isArray(doc.path) ? doc.path : []))])];
};

// ------------------------------------------------------------------------------------------------ data rights

/**
 * A person's loyalty account (as stored) and coupon uses.
 * @param {WebsiteData} data
 * @param {string} userId
 */
export const personRecords = async (data, userId) => {
	const [loyalty, uses] = await Promise.all([
		data
			.collection(COLLECTIONS.loyalty)
			.findOne({ websiteId: data.websiteId, userId }, { projection: { _id: 0, websiteId: 0, merchantId: 0 } }),
		data
			.collection(COLLECTIONS.couponUses)
			.find({ websiteId: data.websiteId, userId }, { projection: { _id: 0, websiteId: 0, merchantId: 0 } })
			.toArray(),
	]);
	return { loyalty, uses };
};

/**
 * Delete a person's loyalty account and coupon-use records (the coupons' `used` counts stay).
 * @param {WebsiteData} data
 * @param {string} userId
 * @returns {Promise<number>} records deleted
 */
export const deletePerson = async (data, userId) => {
	const [loyalty, uses] = await Promise.all([
		data.collection(COLLECTIONS.loyalty).deleteOne({ websiteId: data.websiteId, userId }),
		data.collection(COLLECTIONS.couponUses).deleteMany({ websiteId: data.websiteId, userId }),
	]);
	return loyalty.deletedCount + uses.deletedCount;
};
