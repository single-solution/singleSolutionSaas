/**
 * Ecommerce's data model: the records every part of the shop shares in the merchant database (PLAN 0.8.8), as JSDoc
 * types plus the collection names, id prefixes and the order-status roles. This file is the contract between the
 * catalog, checkout and orders, promotions, returns and the shopper extras: each part keeps its own queries, but every
 * record has exactly this shape. Collections are `ss_ecommerce_<name>` (the kit adds the prefix and the tenant guard:
 * every query carries `websiteId`; inserts are stamped with `websiteId`, `merchantId`, `createdAt` and `updatedAt`).
 * Money is integer minor units of the shop's currency (the `catalog` setting `currency`); times are `Date`s, ISO-8601
 * UTC on the wire. No I/O.
 * @module
 */

/** Collection names (unprefixed). */
export const COLLECTIONS = Object.freeze({
	products: 'products',
	categories: 'categories',
	brands: 'brands',
	attributes: 'attributes',
	locations: 'locations',
	serials: 'serials',
	orders: 'orders',
	counters: 'counters',
	customers: 'customers',
	coupons: 'coupons',
	couponUses: 'coupon_uses',
	deals: 'deals',
	bundles: 'bundles',
	loyalty: 'loyalty',
	slots: 'slots',
	licences: 'licences',
	returns: 'returns',
	reviews: 'reviews',
	wishlists: 'wishlists',
	alerts: 'alerts',
	staff: 'staff',
});

/** Id prefixes (`createId(prefix)` from `@ss/contracts`). */
export const ID_PREFIX = Object.freeze({
	product: 'prd',
	variant: 'var',
	category: 'cat',
	brand: 'brd',
	attribute: 'att',
	location: 'loc',
	serial: 'ser',
	order: 'ord',
	line: 'oln',
	coupon: 'cpn',
	deal: 'deal',
	bundle: 'bnd',
	licence: 'lic',
	slot: 'slot',
	claim: 'ret',
	review: 'rev',
	alert: 'alr',
});

// ------------------------------------------------------------------------------------------------------- catalog

/** @typedef {'physical' | 'digital' | 'booking'} ProductKind */
/** @typedef {'draft' | 'active' | 'archived'} ProductStatus */

/**
 * One file in the merchant's storage (`ecommerce/<kind>/<id>/<name>`), presigned for upload and read.
 * @typedef {object} MediaRecord
 * @property {string} key storage key
 * @property {string} type content type
 * @property {number} size bytes
 * @property {string} alt alternative text
 */

/**
 * A sellable variant. Without the `variants` feature a product has exactly one variant (`options` empty).
 * @typedef {object} VariantRecord
 * @property {string} id `var_…`
 * @property {string} sku unique per website among active products ('' = none)
 * @property {Record<string, string>} options option name → value (`{ Colour: 'Red' }`)
 * @property {number} price minor units
 * @property {number | null} compareAtPrice the "was" price, minor units
 * @property {number | null} cost what the merchant paid (margin reports), minor units
 * @property {number} stock units available to sell now (all locations together); reservations take from it
 * @property {Record<string, number>} locations location id → units (multi_location); its values add up to `stock`
 * @property {string | null} grade a grade key of the `grades` list (grades_serials)
 * @property {boolean} active
 */

/**
 * @typedef {object} ProductRecord
 * @property {string} id `prd_…`
 * @property {string} slug unique per website
 * @property {string} name
 * @property {ProductKind} kind
 * @property {ProductStatus} status only `active` products are shown and sold
 * @property {string} summary short plain text
 * @property {string} description plain text (paragraphs separated by blank lines)
 * @property {string[]} categoryIds
 * @property {string | null} brandId
 * @property {string[]} tags
 * @property {MediaRecord[]} media the first is the main image
 * @property {Record<string, string | number | boolean>} specs attribute id → value
 * @property {Array<{ name: string, values: string[] }>} options variant axes (variants)
 * @property {VariantRecord[]} variants at least one
 * @property {boolean} trackStock false = never runs out (services, made to order)
 * @property {boolean} serialized each unit has a serial number captured when packed (grades_serials)
 * @property {{ files: MediaRecord[], licenceKeys: boolean, downloadLimit: number } | null} digital digital goods
 * @property {{ durationMinutes: number } | null} booking bookings
 * @property {{ title: string, description: string }} seo '' = derived from name and summary
 * @property {number | null} returnDays this item's return window in days after delivery (null = the grade's, else the
 *   `returns` setting)
 * @property {number | null} warrantyDays this item's warranty in days after delivery (null = the grade's, else the setting)
 * @property {number} sold units sold (delivered orders), for top products
 * @property {{ average: number, count: number }} rating approved reviews
 * @property {number} price lowest active variant price (listings, sorting)
 * @property {boolean} inStock some active variant can be sold now
 * @property {Date | null} publishedAt first time it became active (new products)
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * @typedef {{ id: string, slug: string, name: string, parentId: string | null, path: string[], description: string,
 *   seo: { title: string, description: string }, image: MediaRecord | null, sort: number }} CategoryRecord
 *   `path`: ancestor ids from the root, without itself
 */
/** @typedef {{ id: string, slug: string, name: string, description: string, logo: MediaRecord | null }} BrandRecord */
/**
 * @typedef {{ id: string, name: string, type: 'text' | 'number' | 'boolean' | 'choice', choices: string[], unit: string,
 *   filterable: boolean, comparable: boolean, sort: number }} AttributeRecord
 */
/** @typedef {{ id: string, name: string, pickup: boolean, sort: number }} LocationRecord */
/**
 * One unit with a serial number (IMEI …). `in_stock` units are sellable; packing an order marks them `sold` with the
 * order; a return puts them back `in_stock` (or `faulty`).
 * @typedef {{ id: string, productId: string, variantId: string, serial: string, status: 'in_stock' | 'sold' | 'faulty',
 *   orderId: string | null, lineId: string | null, locationId: string | null }} SerialRecord
 */

// -------------------------------------------------------------------------------------------------------- orders

/**
 * What an order-status key does. Merchants name statuses and choose the moves between them (the `order_flow` list,
 * PLAN 0.8.8); the role of a status decides what entering it does, so the stock, offer-use and points rules hold
 * whatever the flow:
 * - `awaiting_payment`: start of online, bank-transfer and COD-with-advance orders; stock is held until it is paid or
 *   the payment window ends (then `cancelled`);
 * - `awaiting_confirmation`: start of plain COD orders; held until staff confirm or the confirmation window ends;
 * - `open`: confirmed and being prepared (custom statuses are `open` too);
 * - `packed`: serial numbers are captured for serialized lines;
 * - `shipped`: with the courier (tracking number);
 * - `delivered`: points are earned, reviews open, return windows start;
 * - `cancelled`: before shipping only; stock, offer use and points are given back; paid money is refunded;
 * - `returned_to_origin`: the parcel came back (RTO); stock comes back and the customer's RTO count rises;
 * - `refunded`: money returned after `delivered` or `returned_to_origin`.
 */
export const STATUS_ROLES = Object.freeze([
	'awaiting_payment',
	'awaiting_confirmation',
	'open',
	'packed',
	'shipped',
	'delivered',
	'cancelled',
	'returned_to_origin',
	'refunded',
]);

/** @typedef {(typeof STATUS_ROLES)[number]} StatusRole */
/** @typedef {{ key: string, label: string, role: StatusRole }} OrderStatusDefinition */
/** @typedef {{ statuses: OrderStatusDefinition[], moves: Array<{ from: string, to: string }> }} OrderFlow */

/** @typedef {'cod' | 'online' | 'bank_transfer' | 'pickup'} PaymentMethod */
/** @typedef {'unpaid' | 'pending' | 'paid' | 'partially_refunded' | 'refunded'} PaymentState */

/**
 * One order line: a snapshot of what was bought, at the price paid.
 * @typedef {object} OrderLineRecord
 * @property {string} id `oln_…`
 * @property {string} productId
 * @property {string} variantId
 * @property {ProductKind} kind
 * @property {string} name product name at placement
 * @property {string} variantName `Red / 128 GB` ('' without options)
 * @property {string} sku
 * @property {string | null} grade grade key
 * @property {string} gradeLabel
 * @property {string | null} image storage key of the main image
 * @property {number} unitPrice minor units, before discounts
 * @property {number} quantity
 * @property {number} discount deals, bundles, coupon and points spread over the line, minor units
 * @property {number} tax minor units (included in `total` when prices exclude tax)
 * @property {number} total unitPrice × quantity − discount (+ tax when prices exclude tax), minor units
 * @property {number | null} cost unit cost at placement (margin reports)
 * @property {string[]} categoryIds
 * @property {string | null} brandId
 * @property {string | null} locationId where its stock was taken (multi_location)
 * @property {string[]} serials serial numbers captured when packed
 * @property {{ start: Date, end: Date } | null} booking the booked slot
 * @property {string[]} licences licence ids given after payment (digital)
 * @property {number} returnedQuantity units returned through approved return claims
 */

/**
 * The single order record (PLAN 0.8.8). Placed in one transaction with its stock, offer uses and points.
 * @typedef {object} OrderRecord
 * @property {string} id `ord_…`
 * @property {string} number human number, unique per website (`<prefix><year>-<sequence>`)
 * @property {{ userId: string, name: string, email: string, phone: string }} customer from the Accounts sign-in
 * @property {{ name: string, phone: string, line1: string, line2: string, city: string, area: string, postalCode: string,
 *   country: string, notes: string } | null} address null for pickup, digital and booking-only orders
 * @property {{ method: 'delivery' | 'pickup' | 'none', zone: string, fee: number, locationId: string | null }} delivery
 * @property {OrderLineRecord[]} lines
 * @property {{ subtotal: number, discount: number, delivery: number, tax: number, total: number, currency: string,
 *   taxIncluded: boolean }} totals `discount` = deals + bundles + coupon + points
 * @property {{ couponId: string | null, couponCode: string, dealIds: string[], bundleIds: string[], pointsRedeemed: number,
 *   pointsValue: number, pointsEarned: number, released: boolean }} promotions `released`: offer uses and points were given
 *   back (cancel), exactly once
 * @property {{ method: PaymentMethod, state: PaymentState, paymentId: string | null, advance: number, paid: number,
 *   refunded: number, checkedAt: Date | null }} payment `paymentId`: the Payments payment; `advance`: the COD advance
 * @property {string} status a status key of the website's order flow
 * @property {StatusRole} role the role of `status`
 * @property {Array<{ at: Date, from: string | null, to: string, by: string, note: string }>} history
 * @property {{ courier: string, trackingNumber: string, trackingUrl: string, booked: boolean, status: string,
 *   checkedAt: Date | null } | null} shipment
 * @property {boolean} stockHeld stock (and booked slots) are held by this order; false after cancel or RTO
 * @property {Date | null} holdUntil an unconfirmed order is cancelled after this time (on use)
 * @property {string} idempotencyKey the checkout's Idempotency-Key, unique per customer
 * @property {string} note the shopper's note
 * @property {string} staffNote
 * @property {Date} placedAt
 * @property {Date | null} deliveredAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * Shop records about one Accounts user (PLAN 0.8.8: only shop records, linked to the Accounts user id).
 * @typedef {{ userId: string, name: string, email: string, phone: string, blocked: boolean, blockedReason: string,
 *   rtoCount: number, orderCount: number, note: string }} CustomerRecord
 */

// ---------------------------------------------------------------------------------------------------- promotions

/**
 * Which items an offer applies to (empty lists = everything).
 * @typedef {{ productIds: string[], categoryIds: string[], brandIds: string[] }} OfferScope
 */

/**
 * @typedef {object} CouponRecord
 * @property {string} id `cpn_…`
 * @property {string} code upper case, unique per website
 * @property {'percent' | 'fixed' | 'free_delivery'} type
 * @property {number} value percent (0–100) or minor units
 * @property {number | null} maxDiscount cap for percent coupons, minor units
 * @property {number} minSubtotal minor units
 * @property {OfferScope} scope
 * @property {Date | null} startsAt
 * @property {Date | null} endsAt
 * @property {number | null} limit total uses (null = no limit)
 * @property {number} used uses counted at placement, given back on cancel
 * @property {number | null} perCustomer uses per customer (null = no limit)
 * @property {boolean} firstOrderOnly
 * @property {boolean} active
 */

/**
 * An automatic offer: a percent or a fixed amount off the price of the items in scope.
 * @typedef {{ id: string, name: string, description: string, type: 'percent' | 'fixed', value: number, scope: OfferScope,
 *   startsAt: Date | null, endsAt: Date | null, limit: number | null, used: number, priority: number, active: boolean }} DealRecord
 */

/**
 * A bundle (these items together for a price or percent off) or buy X get Y (buy `buy` of the scope, get `get` of
 * `getScope` at `value` percent off; 100 = free).
 * @typedef {{ id: string, name: string, type: 'bundle' | 'buy_x_get_y', items: Array<{ productId: string, quantity: number }>,
 *   price: number | null, buy: number, get: number, scope: OfferScope, getScope: OfferScope, value: number,
 *   startsAt: Date | null, endsAt: Date | null, limit: number | null, used: number, active: boolean }} BundleRecord
 */

/**
 * Loyalty account of one Accounts user. Points are earned in lots that expire; spending takes the oldest lots first.
 * Expired lots are written off when the account is read or changed (no scheduled job).
 * @typedef {{ userId: string, balance: number, lots: Array<{ id: string, points: number, left: number, earnedAt: Date,
 *   expiresAt: Date | null, orderId: string | null }>, history: Array<{ at: Date, kind: 'earn' | 'redeem' | 'refund' |
 *   'expire' | 'adjust' | 'reverse', points: number, orderId: string | null, note: string }>, version: number }} LoyaltyRecord
 */

// ------------------------------------------------------------------------------------------- bookings and digital

/**
 * A booked slot: the unique index on (productId, start) is what makes double booking impossible.
 * @typedef {{ id: string, productId: string, start: Date, end: Date, orderId: string, lineId: string }} SlotRecord
 */
/**
 * A licence key of a digital product: `available` until an order is paid, then `assigned` to it.
 * @typedef {{ id: string, productId: string, key: string, status: 'available' | 'assigned', orderId: string | null,
 *   lineId: string | null }} LicenceRecord
 */

// ------------------------------------------------------------------------------------------------- shopper extras

/**
 * A return or warranty claim. Approving with a refund refunds through Payments (paid online) or records it; restocking
 * happens exactly once per claim (`restockedAt`).
 * @typedef {object} ReturnRecord
 * @property {string} id `ret_…`
 * @property {string} orderId
 * @property {string} orderNumber
 * @property {string} userId
 * @property {'return' | 'warranty'} kind
 * @property {Array<{ lineId: string, quantity: number, serials: string[] }>} lines
 * @property {string} reason
 * @property {MediaRecord[]} photos
 * @property {'requested' | 'approved' | 'rejected' | 'received' | 'refunded' | 'closed'} status
 * @property {number} refundAmount minor units (0 = none)
 * @property {string | null} refundId the Payments refund id, or null when recorded only
 * @property {Date | null} restockedAt
 * @property {Array<{ at: Date, status: string, by: string, note: string }>} history
 */
/**
 * @typedef {{ id: string, productId: string, userId: string, orderId: string, name: string, rating: number, title: string,
 *   body: string, status: 'pending' | 'approved' | 'rejected', reply: string }} ReviewRecord
 */
/** @typedef {{ userId: string, productIds: string[] }} WishlistRecord */
/**
 * @typedef {{ id: string, kind: 'back_in_stock' | 'price_drop', productId: string, variantId: string | null, userId: string,
 *   email: string, phone: string, price: number | null, status: 'waiting' | 'sent' | 'failed' }} AlertRecord
 */
/** A member of the merchant's staff seen in a ticket (PLAN 0.4.5). @typedef {{ id: string, name: string, email: string, lastSeenAt: Date }} StaffRecord */
