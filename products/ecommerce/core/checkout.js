/**
 * Pricing a cart (PLAN 0.8.8; the cart lives in the shopper's browser and is priced by the server on every quote and
 * again when the order is placed). The pipeline, all in integer minor units of the shop's currency:
 *
 * 1. lines — the product and variant from the catalog (only active ones), quantity limits (pieces, or the steps and
 *    limits of items sold in a unit of their own: their quantities are thousandths of the unit, `core/measure.js`),
 *    stock shortfalls reported per line (never the exact stock), booked slots and license keys;
 * 2. promotions — deals, bundles and the coupon take their part off each line (`core/promotions.js`);
 * 3. delivery — the fee of the delivery rate the shopper picked (or pickup) after promotions, waived by a free-delivery offer;
 * 4. loyalty points — their value spread over the lines in proportion (`allocate`);
 * 5. taxes — per line, included in the price or added on top;
 * 6. totals.
 *
 * What a line comes to is `lineGross` (`core/measure.js`). Also the checks of the visitor's input and which payment
 * methods a cart may use. Pure functions, no I/O.
 * @module
 */
import { normalizePhone } from '@ss/contracts/phone';
import { addressProblem, countryCodeOf, countryName, tidyPostcode } from '@ss/contracts/address';
import { ADDRESS_LIMITS, placeKey, regionsFor } from './address.js';
import { CART_MAX_QUANTITY } from './limits.js';
import { MAX_LINES, MAX_MEASURED, MAX_QUANTITY, grossFits, limitsOf, lineGross, piecesOf, quantityProblem } from './measure.js';
import { allocateUnits, roundHalfUp } from './money.js';
import { isAmount } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { isMethodKey, methodFee } from './payment-methods.js';
import { taxOf, taxPercent } from './taxes.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').PaymentMethod} PaymentMethod */
/** @typedef {import('./promotions.js').PromotionsResult} PromotionsResult */
/** @typedef {import('./taxes.js').TaxRule} TaxRule */
/** @typedef {import('./guests.js').PhoneRules} PhoneRules */

/** At most this many lines in a cart (`CART_MAX_LINES`), and this many pieces of one line (`core/measure.js`; E4). A
 * line's quantity keeps to its item type's step, least and most: a measured line's in thousandths of its unit (a
 * measured line is one piece), else its quantity rule's in pieces (no most: `CART_MAX_QUANTITY`). */
export { MAX_LINES, MAX_QUANTITY };
/** A deal lock's longest text (`adapters/crypto.js`). */
const MAX_LOCK = 600;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A delivery rate key (`core/delivery.js`). */
const RATE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** A phone as typed: digits, spaces, + ( ) - (kept when the website's phone rules cannot read it as E.164). */
const PHONE = /^\+?[0-9][0-9 ()-]{5,22}$/;

/**
 * @typedef {{ productId: string, variantId: string | null, quantity: number, slot: number | null, dealId?: string | null,
 *   lock?: string | null }} CartLineInput `dealId`: the deal the shopper picked (E18 `shopperChoice`); `lock`: the deal
 *   lock the last quote gave (E18 `lockMinutes`)
 */
/**
 * @typedef {{ method: 'delivery' | 'pickup' | null, rate: string | null, city: string, area: string, region: string,
 *   postalCode: string, country: string, locationId: string | null }} DeliveryInput `rate`: the key of the zone's rate
 *   the shopper picked (E5; null = the first of `method`, else the zone's first)
 */
/** @typedef {{ lines: CartLineInput[], coupon: string, points: number, delivery: DeliveryInput, payment: PaymentMethod | null }} CartInput */
/**
 * @typedef {{ name: string, phone: string, line1: string, line2: string, city: string, area: string, region: string,
 *   postalCode: string, country: string, notes: string }} Address
 */
/** @typedef {{ ok: false, field: string, message: string }} InputError */

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
 * same product, variant and slot are merged. A quantity is a whole number: pieces, or thousandths of the unit of an
 * item sold in a unit of its own; the most of one item is checked when the lines are read against the catalog
 * ({@link resolveLines}, which knows which items are measured).
 * @param {unknown} body
 * @returns {{ ok: true, value: CartInput } | InputError}
 */
export const checkCart = (body) => {
	const lineCap = MAX_LINES;
	const input = isObject(body) ? /** @type {Record<string, unknown>} */ (body) : {};
	const lines = input.lines;
	if (!Array.isArray(lines) || lines.length === 0 || lines.length > lineCap)
		return { ok: false, field: 'lines', message: `lines lists 1–${lineCap} items.` };
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
		if (!Number.isSafeInteger(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_MEASURED)
			return {
				ok: false,
				field: `lines/${index}/quantity`,
				message: 'quantity is a whole number from 1: pieces, or thousandths of the unit of a measured item.',
			};
		const dealId = line.dealId ?? null;
		if (dealId !== null && (typeof dealId !== 'string' || !ID.test(dealId)))
			return { ok: false, field: `lines/${index}/dealId`, message: 'dealId is a deal id.' };
		const lock = line.lock ?? null;
		if (lock !== null && (typeof lock !== 'string' || lock.length > MAX_LOCK))
			return { ok: false, field: `lines/${index}/lock`, message: 'lock is the lock a quote gave.' };
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
		if (total > MAX_MEASURED)
			return { ok: false, field: `lines/${index}/quantity`, message: `At most ${MAX_MEASURED} of one item.` };
		merged.set(key, {
			productId: line.productId,
			variantId: /** @type {string | null} */ (variantId),
			quantity: total,
			slot,
			dealId: found?.dealId ?? /** @type {string | null} */ (dealId),
			lock: found?.lock ?? /** @type {string | null} */ (lock),
		});
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
	/** @type {Record<'city' | 'area' | 'region' | 'postalCode' | 'country', string>} */
	const place = { city: '', area: '', region: '', postalCode: '', country: '' };
	for (const field of /** @type {Array<keyof typeof place>} */ (['city', 'area', 'region', 'postalCode', 'country'])) {
		const value = text(delivery[field], ADDRESS_LIMITS[field]);
		if (value === null)
			return {
				ok: false,
				field: `delivery/${field}`,
				message: `delivery.${field} is at most ${ADDRESS_LIMITS[field]} characters.`,
			};
		place[field] = value;
	}
	const rate = delivery.rate ?? null;
	if (rate !== null && (typeof rate !== 'string' || !RATE_KEY.test(rate)))
		return { ok: false, field: 'delivery/rate', message: 'delivery.rate is the key of a delivery rate.' };
	const locationId = delivery.locationId ?? null;
	if (locationId !== null && (typeof locationId !== 'string' || !ID.test(locationId)))
		return { ok: false, field: 'delivery/locationId', message: 'delivery.locationId is a pickup location id.' };
	const payment = input.payment ?? null;
	if (payment !== null && !isMethodKey(payment))
		return { ok: false, field: 'payment', message: 'payment is a payment method key.' };
	return {
		ok: true,
		value: {
			lines: [...merged.values()],
			coupon: coupon.toUpperCase(),
			points: Number(points),
			delivery: {
				method,
				rate: /** @type {string | null} */ (rate),
				...place,
				locationId: /** @type {string | null} */ (locationId),
			},
			payment: /** @type {PaymentMethod | null} */ (payment),
		},
	};
};

/**
 * What a delivery address must hold on a website: the fields the merchant requires besides the name
 * (`checkout.addressRequired`), whether the phone is needed (`checkout.phoneRequired`), how phones are read (K12),
 * the region names offered per country (`address_regions`) and the business country (an address without a country
 * is there).
 * @typedef {{ required: ReadonlyArray<string>, phoneRequired: boolean,
 *   phoneRules: Pick<PhoneRules, 'defaultCallingCode' | 'trunkPrefix'>,
 *   regions: ReadonlyArray<import('./address.js').AddressRegions>, homeCountry: string }} AddressRules
 */

/**
 * Check a delivery address (every field at most its {@link ADDRESS_LIMITS} length) by its country's format
 * (`@ss/contracts/address`): the country is kept as its ISO code (given as a code or an English name), the place parts
 * the website requires (`checkout.addressRequired`) and the region and postal code the country requires are filled
 * (never a postal code where the country has none), and the postal code is in the country's shape (kept upper case).
 * Its phone (the one the courier calls) is kept as E.164 when the website's phone rules can read it (K12), else as
 * typed, so a website with no calling code still takes national numbers. In a country `address_regions` lists, the
 * region is one of its names, kept as the list spells it.
 * @param {unknown} body
 * @param {AddressRules} rules
 * @returns {{ ok: true, value: Address } | InputError}
 */
export const checkAddress = (body, rules) => {
	if (!isObject(body)) return { ok: false, field: 'address', message: 'A delivery address is required.' };
	const input = /** @type {Record<string, unknown>} */ (body);
	/** @type {Record<string, string>} */
	const out = {};
	for (const [field, max] of Object.entries(ADDRESS_LIMITS)) {
		const value = text(input[field], max);
		if (value === null)
			return { ok: false, field: `address/${field}`, message: `address.${field} is at most ${max} characters.` };
		const needed =
			field === 'name' || (field === 'phone' ? rules.phoneRequired : field === 'country' && rules.required.includes(field));
		if (needed && value === '') return { ok: false, field: `address/${field}`, message: `address.${field} is required.` };
		out[field] = value;
	}
	if (out.country) {
		const code = countryCodeOf(out.country);
		if (!code)
			return {
				ok: false,
				field: 'address/country',
				message: 'address.country is a country: its ISO 3166-1 alpha-2 code or English name.',
			};
		out.country = code;
	}
	out.postalCode = tidyPostcode(out.postalCode);
	const where = out.country || rules.homeCountry;
	const names = regionsFor(rules.regions, where);
	const refused = addressProblem(out, { country: rules.homeCountry, required: rules.required, ask: names ? ['region'] : [] });
	if (refused)
		return {
			ok: false,
			field: `address/${refused.part}`,
			message:
				refused.problem === 'required'
					? `address.${refused.part} is required.`
					: `address.postalCode is not a postal code of ${countryName(where).replace(/^United /, 'the United ')}.`,
		};
	if (names && out.region !== '') {
		const named = names.find((name) => placeKey(name) === placeKey(out.region));
		if (!named)
			return { ok: false, field: 'address/region', message: 'address.region is one of the regions listed for its country.' };
		out.region = named;
	}
	if (out.phone === '') return { ok: true, value: /** @type {Address} */ (/** @type {unknown} */ (out)) };
	const phone = normalizePhone(out.phone, rules.phoneRules) ?? (PHONE.test(String(out.phone)) ? String(out.phone) : null);
	if (!phone)
		return { ok: false, field: 'address/phone', message: 'address.phone is a phone number (digits, spaces, + ( ) -).' };
	return { ok: true, value: /** @type {Address} */ (/** @type {unknown} */ ({ ...out, phone })) };
};

/**
 * Check what placing an order adds to the cart: the payment method, the shopper's note, the return address (its
 * origin is checked against the website by the caller) and the total the shopper was shown (`expectedTotal`, minor
 * units: placement refuses another total, CK-14). The address is checked when the order needs one.
 * @param {unknown} body
 * @returns {{ ok: true, value: { payment: PaymentMethod, note: string, returnUrl: string | null, address: unknown,
 *   expectedTotal?: number } } | InputError}
 */
export const checkOrderExtras = (body) => {
	const input = isObject(body) ? /** @type {Record<string, unknown>} */ (body) : {};
	if (!isMethodKey(input.payment)) return { ok: false, field: 'payment', message: 'payment is a payment method key.' };
	const note = text(input.note, 1000);
	if (note === null) return { ok: false, field: 'note', message: 'note is at most 1000 characters.' };
	const returnUrl = input.returnUrl ?? null;
	if (returnUrl !== null && (typeof returnUrl !== 'string' || returnUrl.length > 2000))
		return { ok: false, field: 'returnUrl', message: 'returnUrl is an address of at most 2000 characters.' };
	const expectedTotal = input.expectedTotal ?? null;
	if (expectedTotal !== null && !isAmount(expectedTotal))
		return { ok: false, field: 'expectedTotal', message: 'expectedTotal is the total shown, in minor units.' };
	return {
		ok: true,
		value: {
			payment: /** @type {PaymentMethod} */ (input.payment),
			note,
			returnUrl: /** @type {string | null} */ (returnUrl),
			address: input.address,
			...(expectedTotal === null ? {} : { expectedTotal }),
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
 * @property {import('./durations.js').Duration | null} [warrantyTime] the variant's warranty, else the product's (E12; the grade's and the setting
 *   are added at placement)
 * @property {string | null} image storage key of the main image
 * @property {number} unitPrice per piece, or per unit of a measured item
 * @property {number} quantity pieces, or thousandths of the unit of a measured item
 * @property {import('./measure.js').Measure | null} measure how the item is measured (its item type's `measure`,
 *   `core/measure.js`); null: counted in pieces
 * @property {import('./measure.js').QuantityLimits} [limits] the quantities a shopper may buy of it (its type's step,
 *   least and most, the most at most the shop's most of one item, E4)
 * @property {number | null} cost
 * @property {string[]} categoryIds the product's own
 * @property {string[]} allCategoryIds with their ancestors (promotions and taxes match these)
 * @property {string | null} brandId
 * @property {{ start: number, end: number } | null} booking
 * @property {boolean} trackStock
 * @property {boolean} priced the product and variant were found and are sold (stock problems still price)
 * @property {LineProblem[]} problems
 */

/** Problems that only stock (or slots, or license keys) cause: placing then answers 409. */
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
	too_many: 'That is more of one item than an order can take.',
	too_large: 'This line comes to more than an order can take.',
	quantity_step: 'This quantity is not one of the steps this item is sold in.',
	quantity_min: 'This quantity is less than the least this item is sold in.',
	quantity_max: 'This quantity is more than the most this item is sold in.',
};

/** The problems a cart line can have (each has its widget text `cart.problem.<code>`). */
// `too_many` (more pieces of one item than an order takes, Sell in any unit) carries its own message
export const LINE_PROBLEMS = Object.freeze([...Object.keys(PROBLEM_TEXT), 'too_many']);

/** @param {string} code @returns {LineProblem} */
const problemOf = (code) => ({ code, message: PROBLEM_TEXT[code] ?? code });

/**
 * Read cart lines against the catalog.
 * @param {CartLineInput[]} inputs
 * @param {object} context
 * @param {Map<string, ProductRecord>} context.products by id
 * @param {(categoryIds: string[]) => string[]} context.ancestors the ids with their ancestors
 * @param {(grade: string, categoryIds: string[]) => string} context.gradeLabel a grade's label for a product of these
 *   categories (its category's entry first, E45)
 * @param {{ digital: boolean, bookings: boolean, measured?: boolean }} context.features `measured`: Sell in any unit is on
 * @param {(product: ProductRecord) => boolean} context.slots whether a service is booked in time slots (its item type's
 *   `slots`, dynamic model §1): one per slot, a slot needed
 * @param {Map<string, number>} context.licenses available license keys by product id
 * @param {(product: ProductRecord, start: number) => { start: number, end: number } | null} context.slotOf the slot
 *   starting then (inside the hours, the lead time and the days ahead), or null
 * @param {Set<string>} context.booked `<productId>|<start ms>` of booked slots
 * @param {(product: ProductRecord) => import('./measure.js').Measure | null} [context.measureOf] how an item is measured
 *   (its item type's `measure`, whatever the feature: its stock is counted in it); none: in pieces
 * @param {(product: ProductRecord) => import('./measure.js').QuantityRule | null} [context.quantityOf] the quantity
 *   rule of an item counted in pieces (its item type's `quantity`, E4); none: from 1 in steps of 1
 * @param {number} [context.maxQuantity] the most pieces of one item without a quantity rule of its own (default
 *   `CART_MAX_QUANTITY`, E4)
 * @param {number} [context.unit] whole units (E25): what a measured line comes to rounds to them
 * @returns {ResolvedLine[]}
 */
export const resolveLines = (
	inputs,
	{
		products,
		ancestors,
		gradeLabel,
		features,
		slots,
		licenses,
		slotOf,
		booked,
		measureOf = () => null,
		quantityOf = () => null,
		maxQuantity = CART_MAX_QUANTITY,
		unit = 1,
	},
) => {
	const pieceCap = Math.min(MAX_QUANTITY, Math.max(1, maxQuantity));
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
			measure: null,
			cost: null,
			categoryIds: product?.categoryIds ?? [],
			allCategoryIds: ancestors(product?.categoryIds ?? []),
			brandId: product?.brandId ?? null,
			booking: null,
			trackStock: product?.trackStock ?? false,
			priced: false,
			problems: [],
		};
		const slotted = product?.kind === 'service' && slots(product);
		const measure = product ? measureOf(product) : null;
		// an item measured by its type is sold only while Sell in any unit is on
		const sold =
			product &&
			product.status === 'active' &&
			(product.kind !== 'digital' || features.digital) &&
			(measure === null || features.measured === true) &&
			(product.kind !== 'service' || (features.bookings && (!slotted || (product.booking?.durationMinutes ?? 0) > 0)));
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
			gradeLabel: variant.grade ? gradeLabel(variant.grade, product.categoryIds) : '',
			warrantyTime: variant.warrantyTime ?? product.warrantyTime ?? null,
			unitPrice: variant.price,
			measure,
			limits: limitsOf(measure, measure ? null : quantityOf(product), pieceCap),
			cost: variant.cost ?? null,
			priced: true,
		};
		if (slotted) {
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
	// the most of one item (pieces; a measured line is one piece), a line's steps and limits (a booked slot is one), and
	// a line too large to price
	for (const line of out) {
		if (!line.priced) continue;
		// an item whose type names a most of its own is held to that (quantity_max); the others to the usual most
		const ownMost = line.limits !== undefined && line.limits.max !== pieceCap;
		const tooMany = !ownMost && piecesOf(line) > pieceCap;
		if (tooMany) line.problems.push({ code: 'too_many', message: `At most ${pieceCap} of one item.` });
		const problem = line.limits && !line.booking ? quantityProblem(line.quantity, line.limits) : null;
		if (problem && !(tooMany && problem === 'quantity_max')) line.problems.push(problemOf(problem));
		if (!grossFits(line.unitPrice, line.quantity, line.measure !== null, unit)) {
			line.problems.push(problemOf('too_large'));
			line.priced = false;
		}
	}
	// shortfalls are checked on the whole cart (two lines of one variant share its stock)
	for (const line of out) {
		if (!line.priced) continue;
		const product = /** @type {ProductRecord} */ (products.get(line.productId));
		if (line.kind === 'service') {
			if (slots(product) && line.quantity > 1) line.problems.push(problemOf('one_per_slot'));
			continue;
		}
		/** @type {number | null} */
		let available = null;
		let wanted = 0;
		// a variant marked sold out is not sold, whatever its stock (E9)
		if (product.variants.find((variant) => variant.id === line.variantId)?.soldOut === true) {
			line.problems.push(problemOf('out_of_stock'));
			continue;
		}
		if (line.kind === 'physical' && product.trackStock) {
			available = product.variants.find((variant) => variant.id === line.variantId)?.stock ?? 0;
			wanted = out.filter((other) => other.priced && other.variantId === line.variantId).reduce((n, o) => n + o.quantity, 0);
		} else if (line.kind === 'digital' && product.digital?.licenseKeys) {
			available = licenses.get(product.id) ?? 0;
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
 * What a cart line comes to before discounts (`lineGross`: whole units with Format's `wholeUnits` for a measured line).
 * @param {Pick<ResolvedLine, 'unitPrice' | 'quantity' | 'measure'>} line @param {number} [unit]
 */
export const grossOf = (line, unit = 1) => lineGross(line.unitPrice, line.quantity, Boolean(line.measure), unit);

/**
 * @typedef {object} PricedLine
 * @property {string} key
 * @property {number} gross what the line comes to before discounts ({@link grossOf})
 * @property {number} promotions deals, bundles and coupon
 * @property {number} role the role discount spread on this line (E19)
 * @property {number} points the points' value spread on this line
 * @property {number} discount promotions + role + points
 * @property {number} tax
 * @property {number} total gross − discount (+ tax when prices exclude tax)
 */

/**
 * @typedef {{ subtotal: number, discount: number, delivery: number, tax: number, total: number, taxIncluded: boolean,
 *   roleDiscount: number, fee: number }} PriceTotals `discount` holds the role discount; `fee` the payment method's fee
 *   (its fee, a percent), included in `total`
 */

/**
 * What promotions take off each line, clamped to the line.
 * @param {ResolvedLine[]} lines priced lines
 * @param {PromotionsResult | null} promotions
 * @param {number} [unit]
 * @returns {number[]}
 */
export const promotionDiscounts = (lines, promotions, unit = 1) =>
	lines.map((line) => {
		const found = promotions?.lines.find((entry) => entry.key === line.key);
		const off = found ? found.dealDiscount + found.bundleDiscount + found.couponDiscount : 0;
		return Math.min(grossOf(line, unit), Math.max(0, Math.floor(off)));
	});

/**
 * An offer discount an edited order keeps (`checkout.editPricing: keep_placed`) spread over its lines in proportion to
 * what they come to, at most that.
 * @param {ResolvedLine[]} lines @param {number} amount @param {number} [unit]
 */
const fixedDiscounts = (lines, amount, unit = 1) => {
	const gross = lines.map((line) => grossOf(line, unit));
	const total = gross.reduce((sum, value) => sum + value, 0);
	return allocateUnits(Math.max(0, Math.min(amount, total)), gross, unit);
};

/**
 * The role discount (E19): `percent` of the goods after offers, rounded half up to whole units.
 * @param {number} merchandise the goods after offers
 * @param {number} percent 0–90
 * @param {number} [unit]
 */
export const roleDiscountOf = (merchandise, percent, unit = 1) =>
	percent > 0 && merchandise > 0 ? Math.min(merchandise, roundHalfUp((merchandise * percent) / 100, unit)) : 0;

/**
 * The role discount of each line (E19, E31): a percent of the goods after offers spread in proportion, or each line's
 * price list price (its variant's, else its product's) below its own price, at most what the line comes to after
 * offers; a listed price never raises one.
 * @param {ReadonlyArray<Pick<ResolvedLine, 'productId' | 'variantId' | 'unitPrice' | 'quantity' | 'measure'>>} lines
 * @param {number[]} after what each line comes to after offers
 * @param {import('./role-pricing.js').RoleTerms | null} terms
 * @param {number} [unit]
 * @returns {{ lines: number[], total: number }}
 */
export const roleDiscounts = (lines, after, terms, unit = 1) => {
	if (!terms) return { lines: after.map(() => 0), total: 0 };
	if (!terms.prices) {
		const total = roleDiscountOf(
			after.reduce((a, b) => a + b, 0),
			terms.percent,
			unit,
		);
		return { lines: allocateUnits(total, after, unit), total };
	}
	const prices = terms.prices;
	const each = lines.map((line, index) => {
		const listed = prices.get(line.variantId) ?? prices.get(line.productId);
		if (listed === undefined || listed >= line.unitPrice) return 0;
		const off = grossOf(line, unit) - grossOf({ ...line, unitPrice: listed }, unit);
		return Math.max(0, Math.min(after[index] ?? 0, off));
	});
	return { lines: each, total: each.reduce((a, b) => a + b, 0) };
};

/**
 * Price the priced lines: promotions, the role discount (after offers, before delivery, E19), the points' value
 * (spread in proportion, at most what is left of the items), taxes, the totals with delivery, and the payment
 * method's fee on the whole, or on the goods after offers and the role discount (E23, `feeBase`). Percentages and tax
 * round half up to whole units (E25).
 * @param {object} input
 * @param {ResolvedLine[]} input.lines priced lines
 * @param {PromotionsResult | null} input.promotions
 * @param {number} input.delivery the delivery fee
 * @param {number} input.pointsValue what the redeemed points take off, minor units
 * @param {TaxRule[]} input.taxRules [] without the `taxes` feature
 * @param {import('./address.js').Place | null} input.region where the order goes (a pickup order: the business
 *   country; null: no place, then only tax rules without regions apply)
 * @param {boolean} input.taxIncluded
 * @param {import('./role-pricing.js').RoleTerms | null} [input.role] the shopper's role prices (E19, E31)
 * @param {number} [input.feePercent] the payment method's fee (E23)
 * @param {import('./payment-methods.js').PaymentMethodRecord['feeBase']} [input.feeBase] what the fee is a percent of (the method's `feeBase`, D4)
 * @param {number} [input.unit] whole units (E25)
 * @param {{ promotions?: number, fee?: number } | null} [input.fixed] amounts an edited order keeps from placement
 *   (`checkout.editPricing: keep_placed`): its offer discount (spread over the lines in proportion, at most what they
 *   come to) and its payment method's fee
 * @returns {{ lines: PricedLine[], totals: PriceTotals }}
 */
export const priceLines = ({
	lines,
	promotions,
	delivery,
	pointsValue,
	taxRules,
	region,
	taxIncluded,
	role: roleTerms = null,
	feePercent = 0,
	feeBase = 'order_total',
	unit = 1,
	fixed = null,
}) => {
	const promo =
		fixed && typeof fixed.promotions === 'number'
			? fixedDiscounts(lines, fixed.promotions, unit)
			: promotionDiscounts(lines, promotions, unit);
	const after = lines.map((line, index) => grossOf(line, unit) - (promo[index] ?? 0));
	const merchandise = after.reduce((a, b) => a + b, 0);
	const { lines: role, total: roleTotal } = roleDiscounts(lines, after, roleTerms, unit);
	const left = after.map((amount, index) => amount - (role[index] ?? 0));
	const points = allocateUnits(Math.min(Math.max(0, pointsValue), merchandise - roleTotal), left, unit);
	/** @type {PricedLine[]} */
	const priced = lines.map((line, index) => {
		const gross = grossOf(line, unit);
		const lineDiscount = (promo[index] ?? 0) + (role[index] ?? 0) + (points[index] ?? 0);
		const net = gross - lineDiscount;
		const tax = roundHalfUp(taxOf(net, taxPercent(taxRules, { categoryIds: line.allCategoryIds, region }), taxIncluded), unit);
		return {
			key: line.key,
			gross,
			promotions: promo[index] ?? 0,
			role: role[index] ?? 0,
			points: points[index] ?? 0,
			discount: lineDiscount,
			tax,
			total: net + (taxIncluded ? 0 : tax),
		};
	});
	const sum = (/** @type {(line: PricedLine) => number} */ pick) => priced.reduce((n, line) => n + pick(line), 0);
	const beforeFee = sum((line) => line.total) + delivery;
	const fee =
		fixed && typeof fixed.fee === 'number'
			? fixed.fee
			: feePercent > 0
				? methodFee(feeBase === 'goods_after_discounts' ? merchandise - roleTotal : beforeFee, { feePercent }, unit)
				: 0;
	return {
		lines: priced,
		totals: {
			subtotal: sum((line) => line.gross),
			discount: sum((line) => line.discount),
			roleDiscount: roleTotal,
			delivery,
			tax: sum((line) => line.tax),
			fee,
			total: beforeFee + fee,
			taxIncluded,
		},
	};
};

/**
 * What a payment method's fee is a percent of (its `feeBase`, D4): the order total before the fee (`order_total`), or
 * the goods after offers and the role discount, before points, delivery and tax (`goods_after_discounts`).
 * @param {{ lines: PricedLine[], totals: PriceTotals }} priced a pricing without the fee
 * @param {import('./payment-methods.js').PaymentMethodRecord['feeBase']} [feeBase]
 */
export const feeBaseOf = ({ lines, totals }, feeBase = 'order_total') =>
	feeBase === 'goods_after_discounts'
		? lines.reduce((sum, line) => sum + line.gross - line.promotions - line.role, 0)
		: totals.total - totals.fee;

/**
 * What each line comes to after promotions (the role prices are taken off it, E31).
 * @param {ResolvedLine[]} lines @param {PromotionsResult | null} promotions
 * @param {number | null} [kept] the offer discount an edited order keeps (`checkout.editPricing: keep_placed`)
 * @param {number} [unit]
 */
export const afterOffers = (lines, promotions, kept = null, unit = 1) => {
	const promo = kept === null ? promotionDiscounts(lines, promotions, unit) : fixedDiscounts(lines, kept, unit);
	return lines.map((line, index) => grossOf(line, unit) - (promo[index] ?? 0));
};
