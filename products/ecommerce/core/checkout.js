/**
 * Pricing a cart (PLAN 0.8.8; the cart lives in the shopper's browser and is priced by the server on every quote and
 * again when the order is placed). The pipeline, all in integer minor units of the shop's currency:
 *
 * 1. lines — the product and variant from the catalog (only active ones), quantity limits, stock shortfalls reported
 *    per line (never the exact stock), booked slots and licence keys;
 * 2. promotions — deals, bundles and the coupon take their part off each line (`core/promotions.js`);
 * 3. delivery — the fee of the delivery zone (or store pickup) after promotions, waived by a free-delivery coupon;
 * 4. loyalty points — their value spread over the lines in proportion (`allocate`);
 * 5. taxes — per line, included in the price or added on top;
 * 6. totals.
 *
 * Also the checks of the visitor's input and which payment methods a cart may use. Pure functions, no I/O.
 * @module
 */
import { codDecision } from './cod.js';
import { allocate } from './money.js';
import { taxOf, taxPercent } from './taxes.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').PaymentMethod} PaymentMethod */
/** @typedef {import('./promotions.js').PromotionsResult} PromotionsResult */
/** @typedef {import('./taxes.js').TaxRule} TaxRule */
/** @typedef {import('./cod.js').CodSettings} CodSettings */

/** At most this many lines in a cart, and this many of one line (the cart widget keeps the same limits). */
export const MAX_LINES = 50;
export const MAX_QUANTITY = 99;
/** Payment methods, in the order they are offered. @type {ReadonlyArray<PaymentMethod>} */
export const PAYMENT_METHODS = Object.freeze(/** @type {PaymentMethod[]} */ (['cod', 'online', 'bank_transfer', 'pickup']));
/** Address fields a merchant may make required (name, phone, line 1 and city always are). */
export const OPTIONAL_ADDRESS_FIELDS = Object.freeze(['line2', 'area', 'postalCode', 'country']);

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,22}$/;

/** @typedef {{ productId: string, variantId: string | null, quantity: number, slot: number | null }} CartLineInput */
/**
 * @typedef {{ method: 'delivery' | 'pickup' | null, city: string, area: string, country: string, locationId: string | null }} DeliveryInput
 */
/** @typedef {{ lines: CartLineInput[], coupon: string, points: number, delivery: DeliveryInput, payment: PaymentMethod | null }} CartInput */
/**
 * @typedef {{ name: string, phone: string, line1: string, line2: string, city: string, area: string, postalCode: string,
 *   country: string, notes: string }} Address
 */
/** @typedef {{ ok: false, field: string, message: string }} InputError */

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A trimmed text of at most `max` characters ('' when missing), or null when it is not a text or too long.
 * @param {unknown} value @param {number} max
 */
const text = (value, max) => {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	const clean = value.trim();
	return clean.length > max ? null : clean;
};

/**
 * Check a cart sent by the visitor (`POST /v1/shop/cart/quote`, and the cart part of placing an order). Lines of the
 * same product, variant and slot are merged.
 * @param {unknown} body
 * @returns {{ ok: true, value: CartInput } | InputError}
 */
export const checkCart = (body) => {
	const input = isObject(body) ? /** @type {Record<string, unknown>} */ (body) : {};
	const lines = input.lines;
	if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES)
		return { ok: false, field: 'lines', message: `lines lists 1–${MAX_LINES} items.` };
	/** @type {Map<string, CartLineInput>} */
	const merged = new Map();
	for (const [index, raw] of lines.entries()) {
		const line = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
		if (typeof line.productId !== 'string' || !ID.test(line.productId))
			return { ok: false, field: `lines/${index}/productId`, message: 'Every line names a product.' };
		const variantId = line.variantId ?? null;
		if (variantId !== null && (typeof variantId !== 'string' || !ID.test(variantId)))
			return { ok: false, field: `lines/${index}/variantId`, message: 'variantId is a variant id.' };
		const quantity = line.quantity ?? 1;
		if (!Number.isSafeInteger(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_QUANTITY)
			return { ok: false, field: `lines/${index}/quantity`, message: `quantity is a whole number from 1 to ${MAX_QUANTITY}.` };
		/** @type {number | null} */
		let slot = null;
		if (line.slot !== undefined && line.slot !== null) {
			slot = typeof line.slot === 'string' && line.slot.length <= 40 ? Date.parse(line.slot) : Number.NaN;
			if (!Number.isFinite(slot))
				return { ok: false, field: `lines/${index}/slot`, message: 'slot is the start of a slot (ISO 8601).' };
		}
		const key = `${line.productId}|${variantId ?? ''}|${slot ?? ''}`;
		const found = merged.get(key);
		const total = (found?.quantity ?? 0) + Number(quantity);
		if (total > MAX_QUANTITY)
			return { ok: false, field: `lines/${index}/quantity`, message: `At most ${MAX_QUANTITY} of one item.` };
		merged.set(key, { productId: line.productId, variantId: /** @type {string | null} */ (variantId), quantity: total, slot });
	}
	const coupon = text(input.coupon, 40);
	if (coupon === null) return { ok: false, field: 'coupon', message: 'coupon is a code of at most 40 characters.' };
	const points = input.points ?? 0;
	if (!Number.isSafeInteger(points) || Number(points) < 0)
		return { ok: false, field: 'points', message: 'points is a whole number of loyalty points.' };
	const delivery = isObject(input.delivery) ? /** @type {Record<string, unknown>} */ (input.delivery) : {};
	const method = delivery.method ?? null;
	if (method !== null && method !== 'delivery' && method !== 'pickup')
		return { ok: false, field: 'delivery/method', message: 'delivery.method is delivery or pickup.' };
	const city = text(delivery.city, 80);
	const area = text(delivery.area, 80);
	const country = text(delivery.country, 60);
	if (city === null || area === null || country === null)
		return { ok: false, field: 'delivery', message: 'delivery names a city, area and country of at most 80 characters.' };
	const locationId = delivery.locationId ?? null;
	if (locationId !== null && (typeof locationId !== 'string' || !ID.test(locationId)))
		return { ok: false, field: 'delivery/locationId', message: 'delivery.locationId is a pickup location id.' };
	const payment = input.payment ?? null;
	if (payment !== null && !PAYMENT_METHODS.includes(/** @type {PaymentMethod} */ (payment)))
		return { ok: false, field: 'payment', message: `payment is one of ${PAYMENT_METHODS.join(', ')}.` };
	return {
		ok: true,
		value: {
			lines: [...merged.values()],
			coupon: coupon.toUpperCase(),
			points: Number(points),
			delivery: { method, city, area, country, locationId: /** @type {string | null} */ (locationId) },
			payment: /** @type {PaymentMethod | null} */ (payment),
		},
	};
};

/**
 * Check a delivery address.
 * @param {unknown} body
 * @param {ReadonlyArray<string>} required optional fields the merchant requires (`OPTIONAL_ADDRESS_FIELDS`)
 * @returns {{ ok: true, value: Address } | InputError}
 */
export const checkAddress = (body, required) => {
	if (!isObject(body)) return { ok: false, field: 'address', message: 'A delivery address is required.' };
	const input = /** @type {Record<string, unknown>} */ (body);
	/** @type {Array<[keyof Address, number, boolean]>} */
	const fields = [
		['name', 120, true],
		['phone', 30, true],
		['line1', 200, true],
		['line2', 200, required.includes('line2')],
		['city', 80, true],
		['area', 80, required.includes('area')],
		['postalCode', 20, required.includes('postalCode')],
		['country', 60, required.includes('country')],
		['notes', 500, false],
	];
	/** @type {Record<string, string>} */
	const out = {};
	for (const [field, max, needed] of fields) {
		const value = text(input[field], max);
		if (value === null)
			return { ok: false, field: `address/${field}`, message: `address.${field} is at most ${max} characters.` };
		if (needed && value === '') return { ok: false, field: `address/${field}`, message: `address.${field} is required.` };
		out[field] = value;
	}
	if (!PHONE.test(String(out.phone)))
		return { ok: false, field: 'address/phone', message: 'address.phone is a phone number (digits, spaces, + ( ) -).' };
	return { ok: true, value: /** @type {Address} */ (/** @type {unknown} */ (out)) };
};

/**
 * Check what placing an order adds to the cart: the payment method, the shopper's note and the return address (its
 * origin is checked against the website by the caller). The address is checked when the order needs one.
 * @param {unknown} body
 * @returns {{ ok: true, value: { payment: PaymentMethod, note: string, returnUrl: string | null, address: unknown } } | InputError}
 */
export const checkOrderExtras = (body) => {
	const input = isObject(body) ? /** @type {Record<string, unknown>} */ (body) : {};
	if (!PAYMENT_METHODS.includes(/** @type {PaymentMethod} */ (input.payment)))
		return { ok: false, field: 'payment', message: `payment is one of ${PAYMENT_METHODS.join(', ')}.` };
	const note = text(input.note, 1000);
	if (note === null) return { ok: false, field: 'note', message: 'note is at most 1000 characters.' };
	const returnUrl = input.returnUrl ?? null;
	if (returnUrl !== null && (typeof returnUrl !== 'string' || returnUrl.length > 2000))
		return { ok: false, field: 'returnUrl', message: 'returnUrl is an address of at most 2000 characters.' };
	return {
		ok: true,
		value: {
			payment: /** @type {PaymentMethod} */ (input.payment),
			note,
			returnUrl: /** @type {string | null} */ (returnUrl),
			address: input.address,
		},
	};
};

// ---------------------------------------------------------------------------------------------------------- lines

/** @typedef {{ code: string, message: string }} LineProblem */

/**
 * A cart line read against the catalog.
 * @typedef {object} ResolvedLine
 * @property {string} key `<productId>|<variantId>` (+ `|<slot start ISO>`)
 * @property {string} productId
 * @property {string} variantId '' when no variant could be chosen
 * @property {import('./model.js').ProductKind} kind
 * @property {string} name
 * @property {string} variantName
 * @property {string} sku
 * @property {string | null} grade
 * @property {string} gradeLabel
 * @property {string | null} image storage key of the main image
 * @property {number} unitPrice
 * @property {number} quantity
 * @property {number | null} cost
 * @property {string[]} categoryIds the product's own
 * @property {string[]} allCategoryIds with their ancestors (promotions and taxes match these)
 * @property {string | null} brandId
 * @property {{ start: number, end: number } | null} booking
 * @property {boolean} trackStock
 * @property {boolean} priced the product and variant were found and are sold (stock problems still price)
 * @property {LineProblem[]} problems
 */

/** Problems that only stock (or slots, or licence keys) cause: placing then answers 409. */
export const STOCK_PROBLEMS = Object.freeze(['out_of_stock', 'not_enough_stock', 'slot_taken']);

/** @type {Record<string, string>} */
const PROBLEM_TEXT = {
	unavailable: 'This item is not available.',
	choose_variant: 'Choose an option for this item.',
	out_of_stock: 'This item is out of stock.',
	not_enough_stock: 'Not enough in stock for this quantity.',
	slot_required: 'Choose a time for this booking.',
	slot_unavailable: 'This time cannot be booked.',
	slot_taken: 'This time is already booked.',
	one_per_slot: 'A time can be booked once per order.',
};

/** @param {string} code @returns {LineProblem} */
const problemOf = (code) => ({ code, message: PROBLEM_TEXT[code] ?? code });

/**
 * Read cart lines against the catalog.
 * @param {CartLineInput[]} inputs
 * @param {object} context
 * @param {Map<string, ProductRecord>} context.products by id
 * @param {(categoryIds: string[]) => string[]} context.ancestors the ids with their ancestors
 * @param {(grade: string) => string} context.gradeLabel
 * @param {{ digital: boolean, bookings: boolean }} context.features
 * @param {Map<string, number>} context.licences available licence keys by product id
 * @param {(product: ProductRecord, start: number) => { start: number, end: number } | null} context.slotOf the slot
 *   starting then (inside the hours, the lead time and the days ahead), or null
 * @param {Set<string>} context.booked `<productId>|<start ms>` of booked slots
 * @returns {ResolvedLine[]}
 */
export const resolveLines = (inputs, { products, ancestors, gradeLabel, features, licences, slotOf, booked }) => {
	/** @type {ResolvedLine[]} */
	const out = [];
	for (const input of inputs) {
		const product = products.get(input.productId);
		/** @type {ResolvedLine} */
		const line = {
			key: `${input.productId}|${input.variantId ?? ''}`,
			productId: input.productId,
			variantId: input.variantId ?? '',
			kind: product?.kind ?? 'physical',
			name: product?.name ?? '',
			variantName: '',
			sku: '',
			grade: null,
			gradeLabel: '',
			image: product?.media?.[0]?.key ?? null,
			unitPrice: 0,
			quantity: input.quantity,
			cost: null,
			categoryIds: product?.categoryIds ?? [],
			allCategoryIds: ancestors(product?.categoryIds ?? []),
			brandId: product?.brandId ?? null,
			booking: null,
			trackStock: product?.trackStock ?? false,
			priced: false,
			problems: [],
		};
		const sold =
			product &&
			product.status === 'active' &&
			(product.kind !== 'digital' || features.digital) &&
			(product.kind !== 'booking' || (features.bookings && (product.booking?.durationMinutes ?? 0) > 0));
		if (!product || !sold) {
			out.push({ ...line, problems: [problemOf('unavailable')] });
			continue;
		}
		const active = product.variants.filter((variant) => variant.active);
		/** @type {VariantRecord | undefined} */
		const variant =
			input.variantId === null
				? active.length === 1
					? active[0]
					: undefined
				: active.find((candidate) => candidate.id === input.variantId);
		if (!variant) {
			out.push({
				...line,
				problems: [problemOf(input.variantId === null && active.length > 1 ? 'choose_variant' : 'unavailable')],
			});
			continue;
		}
		/** @type {ResolvedLine} */
		const resolved = {
			...line,
			key: `${product.id}|${variant.id}`,
			variantId: variant.id,
			variantName: Object.values(variant.options ?? {}).join(' / '),
			sku: variant.sku ?? '',
			grade: variant.grade ?? null,
			gradeLabel: variant.grade ? gradeLabel(variant.grade) : '',
			unitPrice: variant.price,
			cost: variant.cost ?? null,
			priced: true,
		};
		if (product.kind === 'booking') {
			if (input.slot === null) resolved.problems.push(problemOf('slot_required'));
			else {
				const slot = slotOf(product, input.slot);
				resolved.key = `${resolved.key}|${new Date(input.slot).toISOString()}`;
				if (!slot) resolved.problems.push(problemOf('slot_unavailable'));
				else {
					resolved.booking = slot;
					if (booked.has(`${product.id}|${slot.start}`)) resolved.problems.push(problemOf('slot_taken'));
				}
			}
		}
		const same = out.find((other) => other.key === resolved.key);
		if (same) {
			same.quantity += resolved.quantity;
			continue;
		}
		out.push(resolved);
	}
	// shortfalls are checked on the whole cart (two lines of one variant share its stock)
	for (const line of out) {
		if (!line.priced) continue;
		const product = /** @type {ProductRecord} */ (products.get(line.productId));
		if (line.kind === 'booking') {
			if (line.quantity > 1) line.problems.push(problemOf('one_per_slot'));
			continue;
		}
		/** @type {number | null} */
		let available = null;
		let wanted = 0;
		if (line.kind === 'physical' && product.trackStock) {
			available = product.variants.find((variant) => variant.id === line.variantId)?.stock ?? 0;
			wanted = out.filter((other) => other.priced && other.variantId === line.variantId).reduce((n, o) => n + o.quantity, 0);
		} else if (line.kind === 'digital' && product.digital?.licenceKeys) {
			available = licences.get(product.id) ?? 0;
			wanted = out.filter((other) => other.priced && other.productId === line.productId).reduce((n, o) => n + o.quantity, 0);
		}
		if (available === null) continue;
		if (available <= 0) line.problems.push(problemOf('out_of_stock'));
		else if (wanted > available) line.problems.push(problemOf('not_enough_stock'));
	}
	return out;
};

// -------------------------------------------------------------------------------------------------------- pricing

/**
 * @typedef {object} PricedLine
 * @property {string} key
 * @property {number} gross unitPrice × quantity
 * @property {number} promotions deals, bundles and coupon
 * @property {number} points the points' value spread on this line
 * @property {number} discount promotions + points
 * @property {number} tax
 * @property {number} total gross − discount (+ tax when prices exclude tax)
 */

/**
 * @typedef {{ subtotal: number, discount: number, delivery: number, tax: number, total: number, taxIncluded: boolean }} PriceTotals
 */

/**
 * What promotions take off each line, clamped to the line.
 * @param {ResolvedLine[]} lines priced lines
 * @param {PromotionsResult | null} promotions
 * @returns {number[]}
 */
export const promotionDiscounts = (lines, promotions) =>
	lines.map((line) => {
		const found = promotions?.lines.find((entry) => entry.key === line.key);
		const off = found ? found.dealDiscount + found.bundleDiscount + found.couponDiscount : 0;
		return Math.min(line.unitPrice * line.quantity, Math.max(0, Math.floor(off)));
	});

/**
 * Price the priced lines: promotions, the points' value (spread in proportion, at most what is left of the items),
 * taxes and the totals with delivery.
 * @param {object} input
 * @param {ResolvedLine[]} input.lines priced lines
 * @param {PromotionsResult | null} input.promotions
 * @param {number} input.delivery the delivery fee
 * @param {number} input.pointsValue what the redeemed points take off, minor units
 * @param {TaxRule[]} input.taxRules [] without the `taxes` feature
 * @param {{ country: string, city: string } | null} input.region
 * @param {boolean} input.taxIncluded
 * @returns {{ lines: PricedLine[], totals: PriceTotals }}
 */
export const priceLines = ({ lines, promotions, delivery, pointsValue, taxRules, region, taxIncluded }) => {
	const promo = promotionDiscounts(lines, promotions);
	const after = lines.map((line, index) => line.unitPrice * line.quantity - (promo[index] ?? 0));
	const merchandise = after.reduce((a, b) => a + b, 0);
	const points = allocate(Math.min(Math.max(0, pointsValue), merchandise), after);
	/** @type {PricedLine[]} */
	const priced = lines.map((line, index) => {
		const gross = line.unitPrice * line.quantity;
		const lineDiscount = (promo[index] ?? 0) + (points[index] ?? 0);
		const net = gross - lineDiscount;
		const tax = taxOf(net, taxPercent(taxRules, { categoryIds: line.allCategoryIds, region }), taxIncluded);
		return {
			key: line.key,
			gross,
			promotions: promo[index] ?? 0,
			points: points[index] ?? 0,
			discount: lineDiscount,
			tax,
			total: net + (taxIncluded ? 0 : tax),
		};
	});
	const sum = (/** @type {(line: PricedLine) => number} */ pick) => priced.reduce((n, line) => n + pick(line), 0);
	return {
		lines: priced,
		totals: {
			subtotal: sum((line) => line.gross),
			discount: sum((line) => line.discount),
			delivery,
			tax: sum((line) => line.tax),
			total: sum((line) => line.total) + delivery,
			taxIncluded,
		},
	};
};

/** What the items cost after promotions (delivery's free-over and points are measured on it). @param {ResolvedLine[]} lines @param {PromotionsResult | null} promotions */
export const merchandiseOf = (lines, promotions) => {
	const promo = promotionDiscounts(lines, promotions);
	return lines.reduce((n, line, index) => n + line.unitPrice * line.quantity - (promo[index] ?? 0), 0);
};

// -------------------------------------------------------------------------------------------------- payment methods

/**
 * @typedef {{ method: PaymentMethod, available: boolean, reason: string | null, advance: number }} PaymentOption
 *   `reason` when not available: `needs_delivery`, `needs_pickup`, `digital_items`, `over_max`, `advance_unavailable`,
 *   `blocked`
 */

/**
 * The payment methods a cart may use: COD while `cod` is on, delivered and without digital items (its largest value,
 * advance and RTO rules); online and bank transfer when the merchant offers them and Payments is connected; pay at
 * pickup when offered and the order is picked up. Digital items are paid before they are given, so they need online
 * payment or a bank transfer.
 * @param {object} input
 * @param {ReadonlyArray<string>} input.offered the `checkout` setting `paymentMethods`
 * @param {boolean} input.paymentsConnected
 * @param {{ on: boolean, settings: CodSettings }} input.cod
 * @param {boolean} input.pickupPossible store pickup is offered (pickup locations)
 * @param {'delivery' | 'pickup' | 'none'} input.deliveryMethod
 * @param {boolean} input.digital the cart has digital items
 * @param {number} input.total
 * @param {number} input.rtoCount the shopper's returned parcels (0 for guests)
 * @returns {PaymentOption[]}
 */
export const paymentOptions = ({ offered, paymentsConnected, cod, pickupPossible, deliveryMethod, digital, total, rtoCount }) => {
	/** @type {PaymentOption[]} */
	const out = [];
	if (cod.on) {
		if (deliveryMethod !== 'delivery') out.push({ method: 'cod', available: false, reason: 'needs_delivery', advance: 0 });
		else if (digital) out.push({ method: 'cod', available: false, reason: 'digital_items', advance: 0 });
		else {
			const decision = codDecision({ total, rtoCount, canCollectAdvance: paymentsConnected }, cod.settings);
			out.push(
				decision.ok
					? { method: 'cod', available: true, reason: null, advance: decision.advance }
					: { method: 'cod', available: false, reason: decision.reason, advance: 0 },
			);
		}
	}
	for (const method of /** @type {PaymentMethod[]} */ (['online', 'bank_transfer']))
		if (paymentsConnected && offered.includes(method)) out.push({ method, available: true, reason: null, advance: 0 });
	if (pickupPossible && offered.includes('pickup')) {
		const reason = deliveryMethod !== 'pickup' ? 'needs_pickup' : digital ? 'digital_items' : null;
		out.push({ method: 'pickup', available: reason === null, reason, advance: 0 });
	}
	return out;
};
