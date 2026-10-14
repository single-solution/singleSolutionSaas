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
	sizeCharts: 'size_charts',
	landings: 'landings',
	outbox: 'outbox',
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
	sizeChart: 'szc',
	landing: 'lnd',
	customer: 'cus',
	orderPayment: 'opy',
	orderRefund: 'orf',
	outbox: 'out',
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
 * @property {Partial<Record<'thumb' | 'card' | 'detail', string>>} [sizes] storage keys of smaller copies the uploader
 *   made (there is no server image processing)
 * @property {number} [width] pixels
 * @property {number} [height] pixels
 * @property {string} [blur] a tiny placeholder image as a data URI (at most 2 kB)
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
 * @property {Record<string, string | number | boolean | Array<string | number>>} attributes variant attribute id →
 *   value or values (E7); `options` are derived from them
 * @property {MediaRecord[]} media this variant's photos (E6)
 * @property {boolean} soldOut shown as sold out without changing stock (E9)
 * @property {number | null} warrantyDays null = the product's, then the grade's, then the setting (E12)
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
 * @property {Record<string, string | number | boolean | Array<string | number>>} specs attribute id → value (or values,
 *   E7)
 * @property {Array<{ name: string, values: string[] }>} options variant axes (variants)
 * @property {VariantRecord[]} variants at least one
 * @property {boolean} trackStock false = never runs out (services, made to order)
 * @property {boolean | null} serialized each unit has a serial number captured when packed (grades_serials); null =
 *   as its categories say (E11)
 * @property {{ files: MediaRecord[], licenceKeys: boolean, downloadLimit: number } | null} digital digital goods
 * @property {{ durationMinutes: number } | null} booking bookings
 * @property {import('./catalog-content.js').SeoRecord} seo '' = derived from name and summary (E16)
 * @property {boolean} featured (E2)
 * @property {'none' | 'out' | 'partial' | 'full'} stockState derived on save (E2)
 * @property {string[]} grades grade keys of the active variants, derived on save (E2 counts)
 * @property {number} priceMax highest active variant price, derived on save (E8)
 * @property {string} descriptionHtml cleaned rich description; `description` is derived from it (E3)
 * @property {import('./catalog-content.js').Video | null} video (E4)
 * @property {string | null} sizeChartId (E5)
 * @property {boolean} hideSizeGuide (E5)
 * @property {Array<{ attributeId: string, values: Array<string | number>, customValues: string[],
 *   defaultValue: string | number | null }>} attributeSetup (E7)
 * @property {import('./catalog-content.js').Faq[]} faqs (E16)
 * @property {string[]} previousSlugs (E13)
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
 * @typedef {object} CategoryRecord
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {string | null} parentId
 * @property {string[]} path ancestor ids from the root, without itself
 * @property {string} description
 * @property {import('./catalog-content.js').SeoRecord} seo
 * @property {MediaRecord | null} image
 * @property {number} sort
 * @property {'active' | 'coming_soon' | 'hidden'} [status] coming_soon: listed, its products hidden; hidden: neither (E1)
 * @property {string} [icon] a name the website maps to its icon (E1)
 * @property {import('./catalog-content.js').Content} [content] (E1)
 * @property {import('./catalog-content.js').Faq[]} [faqs] (E1)
 * @property {string | null} [sizeChartId] (E5)
 * @property {boolean | null} [requiresSerial] null = as its parent (E11)
 * @property {string[]} [previousSlugs] (E13)
 */
/**
 * @typedef {object} BrandRecord
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {string} description
 * @property {MediaRecord | null} logo
 * @property {'active' | 'hidden'} [status] hidden: its products are hidden (E1)
 * @property {string[]} [categoryIds] the categories it belongs to ([] = all) (E1)
 * @property {import('./catalog-content.js').SeoRecord} seo (E1, E16)
 * @property {string | null} [sizeChartId] (E5)
 */
/** @typedef {{ value: string, label: string }} AttributeChoice */
/**
 * When an attribute is shown (E7): always, for some brands or grades, or when another attribute has a value.
 * @typedef {{ when: 'always' | 'brands' | 'grades' | 'attribute', ids: string[], attributeId: string | null,
 *   value: string | null }} AttributeVisibility
 */
/**
 * @typedef {object} AttributeRecord
 * @property {string} id
 * @property {string} name
 * @property {'text' | 'number' | 'boolean' | 'choice'} type
 * @property {AttributeChoice[]} choices (E7)
 * @property {string} unit
 * @property {boolean} filterable
 * @property {boolean} comparable
 * @property {number} sort
 * @property {string} [slug] the filter name `attr.<slug>` (E7)
 * @property {string | null} [categoryId] the category this attribute is the definition for (E45: the same slug may exist
 *   once per category, with its own name, choices, unit, glossary and SEO); null or missing = every category
 * @property {string[]} [categoryIds] [] = every category (E7)
 * @property {'product' | 'variant'} [on] where its values live (E7)
 * @property {boolean} [multiple] several values at once (E7)
 * @property {AttributeVisibility} [visibility] (E7)
 * @property {'none' | 'image' | 'chips'} [card] how product cards show it (E7)
 * @property {boolean} [active] (E7)
 * @property {{ title: string, description: string, body: string, faqs: import('./catalog-content.js').Faq[] }} [seo]
 *   its glossary page (E7, E15)
 */
/**
 * A size chart (E5): shown from the product, else its brand, else its category.
 * @typedef {{ id: string, name: string, unit: 'in' | 'cm', columns: Array<{ key: string, label: string }>,
 *   rows: Array<{ size: string, label: string, values: Record<string, string> }>, fitAdvice: string, notes: string,
 *   active: boolean }} SizeChartRecord
 */
/**
 * A landing page (E15): a category, brand and grade combination with its own copy.
 * @typedef {{ id: string, categoryId: string | null, brandId: string | null, grade: string | null, h1: string,
 *   title: string, description: string, intro: string, faqs: import('./catalog-content.js').Faq[],
 *   indexable: 'auto' | 'yes' | 'no' }} LandingRecord
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
 * - `refunded`: money returned (after `delivered`, `returned_to_origin` or `returned`; before dispatch only when
 *   something was paid and refunds cover it, E27);
 * - `returned`: a customer return after delivery (E27): earned points are taken back, redeemed ones given back, and
 *   stock comes back as the `returnRestock` setting says.
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
	'returned',
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
 * @property {number} [downloads] downloads made so far (digital)
 * @property {number} returnedQuantity units returned through approved return claims
 * @property {number | null} [warrantyDays] the warranty at placement: the variant's, else the product's, the grade's or
 *   the setting (E12)
 * @property {string | null} [dealId] the line's own deal at placement, else the checkout-level deal (E18)
 */

/**
 * The single order record (PLAN 0.8.8). Placed in one transaction with its stock, offer uses and points.
 * @typedef {object} OrderRecord
 * @property {string} id `ord_…`
 * @property {string} number human number, unique per website (`<prefix><year>-<sequence>`)
 * @property {{ userId: string, name: string, email: string, phone: string, customerId?: string }} customer from the
 *   Accounts sign-in, or the guest's details (`userId` '' for guests, E21); `customerId` the shop's customer record
 * @property {{ name: string, phone: string, line1: string, line2: string, city: string, area: string, postalCode: string,
 *   country: string, notes: string } | null} address null for pickup, digital and booking-only orders
 * @property {{ method: 'delivery' | 'pickup' | 'none', zone: string, fee: number, locationId: string | null }} delivery
 * @property {OrderLineRecord[]} lines
 * @property {{ subtotal: number, discount: number, delivery: number, tax: number, total: number, currency: string,
 *   taxIncluded: boolean, fee?: number, roleDiscount?: number }} totals `discount` = deals + bundles + coupon + points
 *   (+ the role discount, E19); `fee` the payment method's fee (COD cash handling, E23), included in `total`
 * @property {{ couponId: string | null, couponCode: string, dealIds: string[], bundleIds: string[], pointsRedeemed: number,
 *   pointsValue: number, pointsEarned: number, released: boolean, role?: { key: string, percent: number, label: string } | null,
 *   pointsFixed?: boolean, pointsCredited?: boolean, pointsBlocked?: boolean, pointsReversed?: number }} promotions `released`: offer uses and points were given back
 *   (cancel), exactly once; `role`: the role price applied (E19); `pointsCredited`: points fixed at placement were
 *   credited (E20 `earnAt`); `pointsFixed`: `pointsEarned` was fixed at placement (`earnAt: placement`, or 0 for a
 *   signed-in shopper whose role the loyalty settings leave out); `pointsBlocked`: a deal without points applied (E18 `allowPoints`);
 *   `pointsReversed`: earned points already taken back (a claim's refund, a return or a refund, OR-10)
 * @property {{ method: PaymentMethod, state: PaymentState, paymentId: string | null, advance: number, paid: number,
 *   refunded: number, checkedAt: Date | null, checkoutUrl?: string, via?: 'payments' | 'manual',
 *   proof?: { key: string, reference: string, at: Date } | null, voidedAt?: Date | null,
 *   voidPendingAt?: Date | null }} payment `paymentId`: the Payments payment; `advance`: the COD advance;
 *   `checkoutUrl`: Payments' page for paying it; `via`: a bank transfer or advance taken through Payments or recorded by
 *   staff (E23, E24); `proof`: the shopper's transfer proof (E24); `voidedAt`: its Payments payment was cancelled with
 *   the order; `voidPendingAt`: the order was cancelled while Payments could not take that cancel (tried again on use,
 *   K-13); `checkedAt`: when Payments was last asked. `paid` and `refunded` add up `payments` and `refunds` (E26)
 * @property {OrderPaymentEntry[]} [payments] money received (E26)
 * @property {OrderRefundEntry[]} [refunds] money given back (E26)
 * @property {string} status a status key of the website's order flow
 * @property {StatusRole} role the role of `status`
 * @property {Array<{ at: Date, from: string | null, to: string, by: string, note: string, reason?: string,
 *   kind?: 'edited' | 'payment' | 'refund', byKind?: string, code?: import('./orders.js').HistoryNote,
 *   values?: import('./orders.js').NoteValues }>} history `reason` of a move (E27: `rto` | `customer_return`, or a
 *   cancel's `staff` | `shopper` | `expired`); `byKind`: the kind of the actor `by` names (`staff`, `user` or `server`;
 *   missing for `system`, `shopper` and `guest`, and on imported entries); `code` and `values`: a note the server
 *   wrote itself (`core/orders.js` `HISTORY_NOTES`; imported entries have only the note)
 * @property {{ courier: string, trackingNumber: string, trackingUrl: string, booked: boolean, status: string,
 *   checkedAt: Date | null, trackingNote?: string, estimatedDeliveryAt?: Date | null } | null} shipment the courier by
 *   name or key, its link built on read from the `couriers` list (E28)
 * @property {Array<{ kind: 'dispatch_video', key?: string | null, url?: string | null, at?: Date, by?: string }>} [media]
 *   the dispatch video: an upload key, or a YouTube or https address (E28)
 * @property {string[]} [seenBy] staff ids who opened it (E31, at most 50)
 * @property {string} [phoneDigits] the last 10 digits of the customer's phone (E31)
 * @property {string | null} [accessKeyHash] the hash of a guest order's key (E21)
 * @property {boolean} stockHeld stock (and booked slots) are held by this order; false after cancel or RTO
 * @property {boolean} [returnRestocked] its return (RTO or a customer's return) put its units back in stock: a claim
 *   restocked later puts none back (OR-10)
 * @property {Date} [claimRestockedAt] when a return claim of it last put units back in stock (OR-10)
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
 * One payment staff record or Payments confirms (E26).
 * @typedef {{ id: string, method: 'bank_transfer' | 'cash' | 'other' | 'online', amount: number, reference: string,
 *   proofKey: string | null, note: string, by: { kind: string, id: string, name: string, role?: string }, at: Date }}
 *   OrderPaymentEntry
 */
/**
 * One refund (E26): through Payments (`online`) or recorded. `refundId`: Payments' refund; `manual`: Payments only
 * recorded it and the shop returns the money by hand, `method` saying how (OR-8).
 * @typedef {{ id: string, method: 'online' | 'bank_transfer' | 'cash' | 'other', amount: number, reference: string,
 *   claimId: string | null, note: string, by: { kind: string, id: string, name: string, role?: string }, at: Date,
 *   refundId?: string | null, manual?: boolean }} OrderRefundEntry
 */

/**
 * Shop records about one shopper (PLAN 0.8.8: only shop records, linked to the Accounts user id; E21: guests too,
 * unique by normalised phone).
 * @typedef {{ id?: string, userId: string, guest?: boolean, name: string, email: string, phone: string,
 *   phoneDigits?: string, city?: string, blocked: boolean, blockedReason: string, rtoCount: number, orderCount: number,
 *   note: string, seenBy?: string[], lastOrderAt?: Date | null }} CustomerRecord
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
 * A deal's conditions (E18): lists `in` or `not_in` the line's product, categories, brand, attributes and grade, the
 * variant's price range, a minimum quantity per line, a cart total and payment methods; `match` joins them (`all` |
 * `any`), one level of groups.
 * @typedef {object} DealConditions
 * @property {'all' | 'any'} match
 * @property {Array<{ field: 'products' | 'categories' | 'brands' | 'grades' | 'attribute', op: 'in' | 'not_in',
 *   values: string[], attributeId?: string }>} rules
 * @property {Array<{ match: 'all' | 'any', rules: DealConditions['rules'] }>} groups
 * @property {{ min: number | null, max: number | null } | null} priceRange
 * @property {number} minQuantity per line (0 = none)
 * @property {number} cartTotal the least the cart's goods come to (0 = none)
 * @property {string[]} paymentMethods [] = any
 */

/**
 * An automatic offer: a percent or a fixed amount off the price of the items in scope, or free delivery (E18).
 * @typedef {{ id: string, name: string, description: string, type: 'percent' | 'fixed' | 'free_delivery', value: number,
 *   scope: OfferScope, startsAt: Date | null, endsAt: Date | null, limit: number | null, used: number, priority: number,
 *   active: boolean, slug: string, badgeLabel: string, discountLabel: string, color: string,
 *   banner: MediaRecord | null, content: string, seo: { title: string, description: string }, sort: number,
 *   conditions: DealConditions | null, target: 'items' | 'cart', days: number[], timeFrom: string, timeTo: string,
 *   allowPoints: boolean }} DealRecord
 */

/**
 * A bundle (these items together for a price or percent off) or buy X get Y (buy `buy` of the scope, get `get` of
 * `getScope` at `value` percent off; 100 = free).
 * @typedef {{ id: string, name: string, type: 'bundle' | 'buy_x_get_y', items: Array<{ productId: string, quantity: number }>,
 *   price: number | null, buy: number, get: number, scope: OfferScope, getScope: OfferScope, value: number,
 *   startsAt: Date | null, endsAt: Date | null, limit: number | null, used: number, active: boolean }} BundleRecord
 */

/**
 * Loyalty account of one shopper (E20: keyed by `customerId`, with `userId`; guests earn on their phone). Points are
 * earned in lots that expire; spending takes the oldest lots first. Expired lots are written off when the account is
 * read or changed (no scheduled job).
 * @typedef {{ userId: string, customerId?: string, lifetimeEarned?: number, balance: number, lots: Array<{ id: string, points: number, left: number, earnedAt: Date,
 *   expiresAt: Date | null, orderId: string | null, kind?: string }>, history: Array<{ at: Date, kind: 'earn' | 'redeem' | 'refund' |
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
 * A return, warranty or exchange claim. Approving with a refund refunds through Payments (paid online) or records it;
 * restocking happens exactly once per line (the line's `restockedAt`; `restockedAt` once every line is done).
 * @typedef {object} ReturnRecord
 * @property {string} id `ret_…`
 * @property {string} orderId
 * @property {string} orderNumber
 * @property {string} userId
 * @property {'return' | 'warranty' | 'exchange'} kind `exchange` (E33)
 * @property {Array<{ lineId: string, quantity: number, serials: string[], restock?: boolean,
 *   restockedAt?: Date | null }>} lines `restock`: staff's choice when received (E33)
 * @property {string} reason
 * @property {MediaRecord[]} photos
 * @property {'requested' | 'approved' | 'rejected' | 'received' | 'refunded' | 'replaced' | 'repaired' | 'closed'} status
 * @property {number} refundAmount minor units (0 = none)
 * @property {string | null} refundId the Payments refund id, or null when recorded only
 * @property {Date | null} restockedAt
 * @property {Array<{ at: Date, status: string, by: string, note: string, byKind?: string,
 *   code?: import('./returns.js').ClaimNote }>} history `byKind` and `code` as on an order's history (`code`:
 *   `core/returns.js` `CLAIM_NOTES`)
 * @property {string} [reference] the claim's reference (`R-…`, E33)
 * @property {Array<{ at: Date, by: string, text: string }>} [notes] staff notes (E33)
 * @property {string} [refundMethod] how the refund was given (E33)
 * @property {string} [refundReference]
 */
/**
 * @typedef {{ id: string, productId: string, userId: string, orderId: string, name: string, rating: number, title: string,
 *   body: string, status: 'pending' | 'approved' | 'rejected', reply: string, lineId?: string | null,
 *   variantName?: string }} ReviewRecord
 */
/** @typedef {{ userId: string, productIds: string[] }} WishlistRecord */
/**
 * @typedef {{ id: string, kind: 'back_in_stock' | 'price_drop', productId: string, variantId: string | null, userId: string,
 *   email: string, phone: string, price: number | null, status: 'waiting' | 'sent' | 'failed', customerId?: string | null,
 *   targetPrice?: number | null, tokenHash?: string, tries?: number }} AlertRecord `tries`: sends that reached no one
 */
/** A member of the merchant's staff seen in a ticket (PLAN 0.4.5). @typedef {{ id: string, name: string, email: string, lastSeenAt: Date }} StaffRecord */
