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
	landingIndex: 'landing_index',
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

/** @typedef {'physical' | 'digital' | 'service'} ProductKind */
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
 * A variant's package: its weight in grams and its length, width and height in millimeters (whole numbers from 1; a
 * size is given whole or not at all).
 * @typedef {{ weightG: number | null, lengthMm: number | null, widthMm: number | null, heightMm: number | null }} Parcel
 */

/**
 * A sellable variant. Without the `variants` feature a product has exactly one variant (`options` empty).
 * @typedef {object} VariantRecord
 * @property {string} id `var_…`
 * @property {string} sku unique per website among active products ('' = none)
 * @property {string} [gtin] its GTIN (barcode number: 8, 12, 13 or 14 digits with the GS1 check digit); none = not known
 * @property {string} [mpn] its manufacturer part number (at most 70 characters); none = not known
 * @property {Record<string, string>} options option name → value (`{ Color: 'Red' }`)
 * @property {number} price minor units
 * @property {number | null} compareAtPrice the "was" price, minor units
 * @property {number | null} cost what the merchant paid (margin reports), minor units
 * @property {number} stock units available to sell now (all locations together); reservations take from it. An item
 *   sold in a unit of its own counts thousandths of its unit (`core/measure.js`)
 * @property {Record<string, number>} locations location id → units (multi_location); its values add up to `stock`
 * @property {string | null} grade a grade key of the `grades` list (grades_serials)
 * @property {boolean} active
 * @property {Record<string, string | number | boolean | Array<string | number>>} attributes variant attribute id →
 *   value or values (E7); `options` are derived from them
 * @property {MediaRecord[]} media this variant's photos (E6)
 * @property {boolean} soldOut shown as sold out without changing stock (E9)
 * @property {number | null} warrantyDays null = the product's, then the grade's, then the setting (E12)
 * @property {Parcel | null} [parcel] its package (an item type with the `parcel` element): courier bookings and the
 *   feeds' shipping weight read it; none = not known
 * @property {string} [feedId] the item id the shop's earlier product feed listed it under, kept by an import so shopping
 *   catalogs keep the item (E17); none = its own id
 */

/**
 * @typedef {object} ProductRecord
 * @property {string} id `prd_…`
 * @property {string} slug unique per website
 * @property {string} name
 * @property {ProductKind} kind
 * @property {string | null} typeKey its item type (`core/item-types.js`): a key of the `item_types` list or a built-in
 *   type (its kind); null = its first category's, else the built-in type of its kind
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
 * @property {{ files: MediaRecord[], retired: Array<MediaRecord & { removedAt: Date }>, licenceKeys: boolean,
 *   downloadLimit: number } | null} digital digital goods: `retired` are files removed while orders had the product,
 *   still downloadable for the orders placed before `removedAt`
 * @property {{ durationMinutes: number } | null} booking bookings
 * @property {import('./catalog-content.js').SeoRecord} seo '' = derived from name and summary (E16)
 * @property {boolean} featured (E2)
 * @property {'none' | 'out' | 'partial' | 'full'} stockState derived on save (E2)
 * @property {string[]} grades grade keys of the active variants, derived on save (E2 counts)
 * @property {number} priceMax highest active variant price, derived on save (E8)
 * @property {string} descriptionHtml cleaned rich description; `description` is derived from it (E3)
 * @property {import('./catalog-content.js').Video | null} video (E4)
 * @property {string | null} sizeChartId (E5)
 * @property {string} [feedGroupId] the item group id the shop's earlier product feed sent on its items, kept by an
 *   import (E17, SG-24); none = the product id on products with several variants
 * @property {boolean} hideSizeGuide (E5)
 * @property {Array<{ attributeId: string, values: Array<string | number>, customValues: string[],
 *   defaultValue: string | number | null }>} attributeSetup (E7)
 * @property {import('./catalog-content.js').Faq[]} faqs (E16)
 * @property {string[]} previousSlugs (E13)
 * @property {string | null} replacedBy the product that replaces it (SEO audit G9): once archived, its address answers
 *   `moved` to the replacement (followed to the first active one shoppers may see); null = none
 * @property {number | null} returnDays this item's return window in days after delivery (null = the grade's, else the
 *   `returns` setting)
 * @property {number | null} warrantyDays this item's warranty in days after delivery (null = the grade's, else the setting)
 * @property {number} sold units sold (delivered orders), for top products
 * @property {number} ordered units of orders placed and not given back before delivery (open and delivered orders), for
 *   top products by the `catalog` setting `topBasis: ordered` (parity P3-10)
 * @property {{ average: number, count: number }} rating approved reviews
 * @property {number} price lowest active variant price (listings, sorting)
 * @property {boolean} inStock some active variant can be sold now
 * @property {Date | null} publishedAt first time it became active (new products)
 * @property {Date} contentUpdatedAt the last change of what its page shows (content, prices, photos, whether it can be
 *   bought; never a stock change that leaves it on sale), the sitemap's `lastmod` (SEO audit G8.4)
 * @property {Date} createdAt
 * @property {Date} updatedAt any write, stock included
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
 * @property {'active' | 'coming_soon' | 'hidden'} status coming_soon: listed, its products hidden; hidden: neither (E1)
 * @property {string} icon a name the website maps to its icon ('' = none; E1)
 * @property {import('./catalog-content.js').Content} content (E1)
 * @property {import('./catalog-content.js').Faq[]} faqs (E1)
 * @property {string | null} sizeChartId (E5)
 * @property {string | null} typeKey the item type its products have unless they name their own (`core/item-types.js`);
 *   null = its parent's
 * @property {string} googleCategory the Google product category of its products' feed items (an id or a path; SEO audit
 *   G11.3); '' = the nearest category above it that names one, else the `feeds` setting `googleCategory`
 * @property {string[]} previousSlugs (E13)
 */
/**
 * @typedef {object} BrandRecord
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {string} description
 * @property {MediaRecord | null} logo
 * @property {'active' | 'hidden'} status hidden: its products are hidden (E1)
 * @property {string[]} categoryIds the categories it belongs to ([] = all) (E1)
 * @property {string[]} hiddenIn the categories whose listings leave its products out, with those below them ([] = none;
 *   parity P3-12): the products stay on their pages, in search and in other listings
 * @property {import('./catalog-content.js').SeoRecord} seo (E1, E16)
 * @property {string | null} sizeChartId (E5)
 */
/** @typedef {{ value: string, label: string }} AttributeChoice */
/**
 * When an attribute is shown (E7): always, for some brands or grades, or when another attribute has a value.
 * @typedef {{ when: 'always' | 'brands' | 'grades' | 'attribute', ids: string[], attributeId: string | null,
 *   value: string | null }} AttributeVisibility
 */
/**
 * A merchant field (an attribute, PLAN 0.8.10 dynamic model §2; screens say "Fields"): values on products (`specs`),
 * variants (`attributes`, from which option axes are made), units (a numbered item's values), orders (`fields`) or
 * customers (`fields`).
 * @typedef {object} AttributeRecord
 * @property {string} id
 * @property {string} name
 * @property {'product' | 'variant' | 'unit' | 'order' | 'customer'} on where its values live (E7)
 * @property {'text' | 'number' | 'choice' | 'yes_no' | 'date'} type dates are `YYYY-MM-DD`
 * @property {AttributeChoice[]} choices (E7)
 * @property {string} unit a number's unit ('' = none), shown after its values
 * @property {number | null} min a number's least value (null = none)
 * @property {number | null} max a number's most value (null = none)
 * @property {number} decimals a number's most decimals (0–3)
 * @property {'any' | 'past' | 'future'} dates the days a date field takes: any, today or before, today or after
 * @property {boolean} multiple several values at once (E7)
 * @property {number} maxValues the most values (1 unless several; a unit field at most 2)
 * @property {import('./fields.js').Format | null} format what a text field's values look like (null = any text)
 * @property {boolean} required products and variants: needed while on sale; units: on every unit; orders: by
 *   `requiredAt`
 * @property {'checkout' | 'packed' | 'shipped' | 'delivered' | null} requiredAt a required order field: at checkout (the
 *   shopper gives it) or before staff move the order into that stage
 * @property {import('./fields.js').FieldShow} show where its values show
 * @property {number} sort
 * @property {string} slug the filter name `attr.<slug>` (E7)
 * @property {string | null} categoryId the category this attribute is the definition for (E45: the same slug may exist
 *   once per category, with its own name, choices, unit, glossary and SEO); null = every category
 * @property {string[]} categoryIds [] = every category (E7); product, variant and unit fields
 * @property {AttributeVisibility} visibility (E7)
 * @property {boolean} active (E7)
 * @property {{ title: string, description: string, body: string, faqs: import('./catalog-content.js').Faq[] }} seo
 *   its glossary page (E7, E15)
 */
/**
 * A measurement table (E5, dynamic model §6; a size chart): shown from the product, else its brand, else its category.
 * `unit` and a column's `unit` are a unit of `core/units.js`, an own label or '' (a column's '': the table's);
 * `convertTo` is '' or a unit shoppers may switch the columns of its dimension to.
 * @typedef {{ id: string, name: string, unit: string, convertTo: string,
 *   columns: Array<{ key: string, label: string, unit: string }>,
 *   rows: Array<{ size: string, label: string, values: Record<string, string> }>, advice: string, notes: string,
 *   active: boolean }} SizeChartRecord
 */
/**
 * A landing page's facet (dynamic model §6): one value of a field shoppers filter by — `grade` (a grade key) or a
 * product or variant field by its slug — as a listing takes it (`grade=` or `attr.<slug>=`).
 * @typedef {{ field: string, value: string }} LandingFacet
 */
/**
 * A landing page (E15): a category, brand and facet combination (at least one of them) with its own copy.
 * @typedef {{ id: string, categoryId: string | null, brandId: string | null, facet: LandingFacet | null, h1: string,
 *   title: string, description: string, intro: string, faqs: import('./catalog-content.js').Faq[],
 *   indexable: 'auto' | 'yes' | 'no' }} LandingRecord
 */
/** @typedef {{ id: string, name: string, pickup: boolean, sort: number }} LocationRecord */
/**
 * One unit (a numbered item, PLAN 0.8.10 dynamic model §2). `in_stock` units are sellable; packing an order marks them
 * `sold` with the order; a return puts them back `in_stock` (or `faulty`). `serial` names the unit (its plain serial
 * number, else the first value of its first unit field), `values` holds its unit fields' values (one, or two with a
 * field that takes two), and `keys` (`num:<number>` for its serial and each value) are unique across the shop's units.
 * @typedef {{ id: string, productId: string, variantId: string, serial: string, values: Record<string, string[]>,
 *   keys: string[], status: 'in_stock' | 'sold' | 'faulty', orderId: string | null, lineId: string | null,
 *   locationId: string | null, typed?: boolean }} SerialRecord `typed`: typed at packing or later, never in stock
 */

// -------------------------------------------------------------------------------------------------------- orders

/**
 * What an order-status key does. Merchants name statuses and choose the moves between them (the `order_flow` list,
 * PLAN 0.8.8; the options of each move, PLAN 0.8.10 dynamic model phase 2, `core/flow.js`); the role of a status decides
 * what entering it does, so the stock, offer-use and points rules hold whatever the flow:
 * - `awaiting_payment`: start of online, bank-transfer and COD-with-advance orders; stock is held until it is paid or
 *   the payment window ends (then `cancelled`);
 * - `awaiting_confirmation`: start of plain COD and pickup orders by default (a flow may have none, then they start
 *   `open`); held until staff confirm or the confirmation window ends;
 * - `open`: confirmed and being prepared (custom statuses are `open` too);
 * - `packed`: units of lines whose item type numbers them are captured (also with a later move, as the type says);
 * - `shipped`: with the courier (tracking number);
 * - `delivered`: points are earned, reviews open, return windows start;
 * - `cancelled`: stock, offer use and points are given back; paid money is refunded as the move says; after delivery
 *   (E40, a listed move) the items go back in stock only as the move says;
 * - `returned_to_origin`: the package came back (RTO); stock comes back as the move says and the customer's RTO count
 *   rises;
 * - `refunded`: money returned (after `delivered`, `returned_to_origin` or `returned`; before delivery only when
 *   something was paid, E27, and it acts as a cancel);
 * - `returned`: a customer return after delivery (E27): earned points are taken back unless the move keeps them (E39),
 *   redeemed ones given back, and stock comes back as the move says.
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
/**
 * What the shopper reads under a status, per payment method ('' = nothing; PLAN 0.8.10 dynamic model phase 2).
 * @typedef {{ cod: string, online: string, bank_transfer: string, pickup: string }} ShopperTexts
 */
/**
 * A status of the order flow: its key, the name staff see (`label`), its kind of step (`role`), the name shoppers see
 * (`shopperLabel`, '' = `label`), a line per payment method shoppers read under it and whether entering it sends the
 * shopper a message (`notify`) and alerts the staff (`staffAlert`, E36). Missing fields read with the defaults
 * (`core/flow.js` `checkOrderFlow`).
 * @typedef {{ key: string, label: string, role: StatusRole, shopperLabel?: string, shopperText?: ShopperTexts,
 *   notify?: boolean, staffAlert?: boolean }} OrderStatusDefinition
 */
/**
 * The choices a move makes where its stage contract leaves one (dynamic model §3.4; `core/flow.js` `moveOptionSpecs`
 * says which a move takes and their defaults).
 * @typedef {{ paidOnConfirm?: PaymentMethod[], window?: 'restart' | 'none', video?: 'off' | 'optional' | 'required',
 *   tracking?: 'required' | 'optional', refund?: 'auto' | 'staff', shopperPaid?: 'refuse' | 'flag' | 'refund',
 *   unpaid?: 'refuse' | 'cancel', restock?: 'yes' | 'no' | 'ask', points?: 'take_back' | 'keep' }} MoveOptions
 */
/**
 * An allowed move: who may make it (`staff`, `shopper` — a cancel before dispatch —, or only the shop itself:
 * `system`), the permission a staff ticket needs, what staff must give with it (`needs`) and its options.
 * @typedef {{ from: string, to: string, who?: Array<'staff' | 'shopper' | 'system'>,
 *   permission?: 'orders.manage' | 'orders.refund', needs?: Array<'note' | 'reason'>,
 *   options?: MoveOptions }} OrderMove
 */
/**
 * Moves the shop makes by itself, by the status they go to ('' = none): `paid` (Payments confirmed the payment of the
 * order waiting for it), `windowEnd` (a waiting order's time ran out) and `refundsCover` (refunds reached what was
 * paid). `starts`: where orders that need no payment first start — cash on delivery, pay at pickup and free orders.
 * @typedef {{ paid: string, windowEnd: string, refundsCover: string }} FlowTriggers
 * @typedef {{ cod: string, pickup: string, free: string }} FlowStarts
 */
/**
 * The merchant's order flow (the `order_flow` list). `triggers` and `starts` are filled from the statuses and moves
 * when missing (older saved flows, flows built in code).
 * @typedef {{ statuses: OrderStatusDefinition[], moves: OrderMove[], triggers?: FlowTriggers,
 *   starts?: FlowStarts }} OrderFlow
 */

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
 * @property {string} variantName `Blue / Large` ('' without options)
 * @property {string} sku
 * @property {string | null} grade grade key
 * @property {string} gradeLabel
 * @property {string | null} image storage key of the main image
 * @property {number} unitPrice minor units, before discounts: per piece, or per unit of a measured item
 * @property {number} quantity pieces, or thousandths of the unit of a measured item (`measure`)
 * @property {import('./measure.js').LineMeasure} [measure] how its item was sold in a unit of its own at
 *   placement (its unit and step, `core/measure.js`); none: counted in pieces
 * @property {number} discount deals, bundles, coupon and points spread over the line, minor units
 * @property {number} tax minor units (included in `total` when prices exclude tax)
 * @property {number} total what the line comes to (`lineGross`: unitPrice × quantity, a measured line's rounded half
 *   up) − discount (+ tax when prices exclude tax), minor units
 * @property {number | null} cost unit cost at placement (margin reports)
 * @property {string[]} categoryIds
 * @property {string | null} brandId
 * @property {string | null} locationId where its stock was taken (multi_location)
 * @property {string[]} serials serial numbers captured when packed
 * @property {{ start: Date, end: Date } | null} booking the booked slot
 * @property {string[]} licences license ids given after payment (digital)
 * @property {number} [downloads] downloads made so far (digital)
 * @property {number} returnedQuantity units returned through approved return claims (thousandths of the unit of a
 *   measured line)
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
 * @property {import('./checkout.js').Address | null} address null for pickup, digital and booking-only orders
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
 *   staff (E23, E24); `proof`: the shopper's transfer proof (E24); `voidedAt`: its Payments payment was canceled with
 *   the order; `voidPendingAt`: the order was canceled while Payments could not take that cancel (tried again on use,
 *   K-13); `checkedAt`: when Payments was last asked. `paid` and `refunded` add up `payments` and `refunds` (E26)
 * @property {OrderPaymentEntry[]} [payments] money received (E26)
 * @property {OrderRefundEntry[]} [refunds] money given back (E26)
 * @property {string} status a status key of the website's order flow
 * @property {StatusRole} role the role of `status`
 * @property {Array<{ at: Date, from: string | null, to: string, by: string, note: string, reason?: string,
 *   kind?: 'edited' | 'payment' | 'refund' | 'video', byKind?: string, code?: import('./orders.js').HistoryNote,
 *   values?: import('./orders.js').NoteValues, shopperNote?: string }>} history `shopperNote`: what staff wrote for
 *   the shopper with a move (the shopper's timeline shows it; `note` stays internal); `reason` of a move (E27: `rto` | `customer_return`, or a
 *   cancel's `staff` | `shopper` | `expired`); `byKind`: the kind of the actor `by` names (`staff`, `user` or `server`;
 *   missing for `system`, `shopper` and `guest`, and on imported entries); `code` and `values`: a note the server
 *   wrote itself (`core/orders.js` `HISTORY_NOTES`; imported entries have only the note)
 * @property {{ courier: string, trackingNumber: string, trackingUrl: string, booked: boolean, status: string,
 *   checkedAt: Date | null, trackingNote?: string, estimatedDeliveryAt?: Date | null } | null} shipment the courier by
 *   name or key, its link built on read from the `couriers` list (E28)
 * @property {Array<{ kind: 'dispatch_video', key?: string | null, url?: string | null, at?: Date, by?: string }>} [media]
 *   the dispatch video: an upload key, or a YouTube or https address (E28)
 * @property {string[]} [seenBy] staff ids who opened it (E31, at most 50)
 * @property {string} [phoneDigits] the digits of the customer's phone, its whole number (E31)
 * @property {string | null} [accessKeyHash] the hash of a guest order's key (E21)
 * @property {boolean} stockHeld stock (and booked slots) are held by this order; false after cancel or RTO
 * @property {import('./facts.js').OrderFacts} [facts] what the order holds or gave back (the order engine's facts, PLAN
 *   0.8.10 dynamic model §3.2): written by every transition; an order written before them has them derived from its flags
 * @property {import('./transitions.js').OrderEffect[]} [effects] work outside the database a transition asked for (a
 *   refund through Payments): pending until done, tried again on use
 * @property {boolean} [returnRestocked] its return (RTO or a customer's return) put its units back in stock: a claim
 *   restocked later puts none back (OR-10)
 * @property {Date} [claimRestockedAt] when a return claim of it last put units back in stock (OR-10)
 * @property {Date | null} holdUntil an unconfirmed order is canceled after this time (on use)
 * @property {string} idempotencyKey the checkout's Idempotency-Key, unique per customer
 * @property {string} note the shopper's note
 * @property {Record<string, import('./fields.js').FieldValue>} [fields] the values of the shop's order fields by field
 *   id (dynamic model §2): the shopper's at checkout, staff's by edit; none when it has no values
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
 * unique by their key): a guest has no user id (`userId: null`, `guest: true`) and a `guestKey`, `p:<E.164>` or
 * `e:<email>` (`checkout.guestIdentity`, dynamic model §5).
 * @typedef {{ id: string, userId: string | null, guest: boolean, guestKey?: string, name: string, email: string,
 *   phone: string, phoneDigits: string, city: string, blocked: boolean, blockedReason: string, rtoCount: number, orderCount: number,
 *   note: string, seenBy: string[], lastOrderAt?: Date | null,
 *   fields?: Record<string, import('./fields.js').FieldValue>, addresses?: import('./checkout.js').Address[],
 *   loyaltyMember?: boolean }} CustomerRecord `fields`: the values of the shop's customer fields by field id, kept by
 *   staff (dynamic model §2); none when it has no values; `addresses`: the addresses staff keep and a guest's orders
 *   delivered to, the newest first, at most 6 (E46); `loyaltyMember`: flagged as a loyalty member (E47)
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
 * A license key of a digital product: `available` until an order is paid, then `assigned` to it.
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
