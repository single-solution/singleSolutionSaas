/**
 * Pricing a cart against the website's catalog and settings (`core/checkout.js` does the arithmetic): the products
 * and variants, category ancestors, grade names, license keys and booked slots it needs, the offers (`loadOffers` and
 * `applyPromotions`, while `deals`, `bundles` and `coupons` are on: conditions, hours in the business time zone, the
 * payment method, the shopper's picked deal and signed deal locks, E18; how they round, D4), the role price of a
 * signed-in shopper (`role_pricing`, E19), loyalty points (while `loyalty` is on and the shopper takes part, E20),
 * delivery zones, pickup locations or the one pickup point (`delivery_zones`, E22), tax rules (`taxes`), the payment
 * methods in the merchant's order with their fees (COD cash handling on its `feeBase`, E23, D4) and bank details
 * (Payments P1, cached 5 minutes, E24). Every amount rounds to whole units with Format's `wholeUnits` (E25). Used by
 * the quote route and again, on the server, when an order is placed. Also the bookable slots of a product
 * (`bookings`).
 * @module
 */
import { attributesOf, productTypes } from '../adapters/catalog-store.js';
import { readLock, signLock } from '../adapters/crypto.js';
import { loyaltyAccount } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { loadOffers } from '../adapters/promotions-store.js';
import { MAX_SLOT_DAYS, slotAt, slotsBetween } from '../core/bookings.js';
import { feeBaseOf, merchandiseOf, paymentOptions, priceLines, resolveLines, roleDiscountOf } from '../core/checkout.js';
import { matchZone, zoneFee } from '../core/delivery.js';
import { dealRulesOf } from '../core/deals.js';
import { checkoutFields } from '../core/fields.js';
import { lineageOf } from '../core/catalog-taxonomy.js';
import { gradesFor } from '../core/grades.js';
import { elementsOf } from '../core/item-types.js';
import {
	earnsAsMember,
	isLoyaltyMember,
	loyaltyRules,
	maxRedeemable,
	pointsToEarn,
	pointsToRedeem,
	pointsValue,
	takesPart,
} from '../core/loyalty.js';
import { roundDown } from '../core/money.js';
import { applyPromotions, attributeValues } from '../core/promotions.js';
import { COLLECTIONS } from '../core/model.js';
import { createMedia } from './catalog-media.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Shopper} Shopper */
/** @typedef {import('../core/checkout.js').CartInput} CartInput */
/** @typedef {import('../core/checkout.js').Address} Address */
/** @typedef {import('../core/checkout.js').ResolvedLine} ResolvedLine */
/** @typedef {import('../core/checkout.js').PricedLine} PricedLine */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').LocationRecord} LocationRecord */
/** @typedef {import('../core/model.js').DealRecord} DealRecord */
/** @typedef {import('../core/model.js').PaymentMethod} PaymentMethod */

const DAY_MS = 86_400_000;
/** Bank details are read from Payments at most this often per website (E24). */
const BANK_DETAILS_MS = 5 * 60_000;

/**
 * @typedef {object} DeliveryChoice
 * @property {'delivery' | 'pickup' | 'none'} method
 * @property {string} zone zone key ('' = no zone matched or zones off)
 * @property {string} name zone or pickup location name
 * @property {number} fee
 * @property {string | null} locationId pickup location
 * @property {number | null} minDays
 * @property {number | null} maxDays
 * @property {number} [freeOver] delivery is free from this amount of goods after promotions (0 = never; E37)
 * @property {string} [address] the pickup point's address (E22)
 * @property {string} [hours] the pickup point's hours (E22)
 */

/**
 * The bank details a bank transfer shows, exactly as Payments answers them (P1, `GET /v1/bank-transfer`): each '' when
 * not set, so a page shows only the ones given.
 * @typedef {{ ready: boolean, accountHolder: string, bankName: string, accountNumber: string, routingNumber: string,
 *   sortCode: string, branchCode: string, iban: string, bic: string, instructions: string }} BankDetails
 */

/** The texts of the bank details, in Payments' order. */
const BANK_FIELDS = Object.freeze(
	/** @type {const} */ ([
		'accountHolder',
		'bankName',
		'accountNumber',
		'routingNumber',
		'sortCode',
		'branchCode',
		'iban',
		'bic',
		'instructions',
	]),
);

/**
 * A priced cart.
 * @typedef {object} Quote
 * @property {ResolvedLine[]} lines every line, in cart order
 * @property {ResolvedLine[]} priced the lines that were priced
 * @property {PricedLine[]} prices the prices of `priced`, same order
 * @property {import('../core/checkout.js').PriceTotals} totals
 * @property {import('../core/promotions.js').PromotionsResult | null} promotions
 * @property {import('../core/model.js').CouponRecord | null} coupon the coupon of the code entered
 * @property {DeliveryChoice} delivery the chosen delivery
 * @property {DeliveryChoice[]} deliveryOptions
 * @property {string | null} deliveryProblem `choose_pickup_location` when pickup names no location
 * @property {import('../core/checkout.js').PaymentOption[]} payments in the merchant's order (E22)
 * @property {PaymentMethod | null} paymentMethod the method priced: the one asked, else the first available (E22)
 * @property {{ balance: number, max: number, used: number, value: number } | null} points
 * @property {number} pointsToEarn what the order would earn (E20; 0 without loyalty)
 * @property {{ key: string, percent: number, label: string } | null} role the role price applied (E19)
 * @property {boolean} digital the cart has digital items
 * @property {import('../core/model.js').CustomerRecord | null} customer
 * @property {LocationRecord[]} locations stock locations in their order (multi_location)
 * @property {boolean} ready nothing stops placing it
 * @property {Map<string, string>} [urls] each priced line's page by its key (E13)
 * @property {Map<string, DealRecord>} deals the deals of the lines and of free delivery, by id (their display fields)
 * @property {Map<string, string>} locks each line's signed deal lock by its key (E18 `lockMinutes`)
 * @property {BankDetails | null} bankDetails while bank transfer is offered (E24)
 * @property {Record<string, string>} notes the texts per payment method and for delivery and pickup (E22)
 * @property {ReturnType<typeof checkoutFields>} fields the order fields the checkout asks the shopper (dynamic model §2)
 */

/**
 * Re-pricing an order staff edit (E29): the order keeps the offers it was placed with (its deals and its coupon, even
 * ended, switched off or used up, by the website's deal rules; OR-9), its role price and the points it spent; staff
 * may set unit prices. `keep` (`checkout.editPricing: keep_placed`): it keeps the amounts it was placed with instead of
 * pricing them again — its offer discount, its delivery fee while its delivery method stays, and its payment method's
 * fee while its payment method stays.
 * @typedef {{ prices: Map<string, number>, deals: DealRecord[], coupon: import('../core/model.js').CouponRecord | null,
 *   role: { role: string, percent: number, label: string } | null, points: { used: number, value: number },
 *   keep?: { promotions: number, delivery: number, deliveryMethod: string, fee: number, method: string } }} QuoteEdit
 */

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createQuoting = (product, service) => {
	const media = createMedia(product);
	/** Bank details per website, read at most every {@link BANK_DETAILS_MS}. @type {Map<string, { at: number, value: BankDetails | null }>} */
	const bankCache = new Map();

	/**
	 * What booking checks need: the weekly hours, the business time zone, the lead time and the days ahead.
	 * @param {Site} s
	 */
	const bookingRules = async (s) => {
		const settings = await s.values('bookings');
		return {
			hours: /** @type {import('../core/bookings.js').OpeningHours[]} */ (await s.list('booking_hours')),
			timeZone: String((await s.business()).timeZone || 'UTC'),
			leadMs: Number(settings.leadMinutes) * 60_000,
			aheadMs: Number(settings.daysAhead) * DAY_MS,
		};
	};

	/**
	 * The website's bank details from Payments (P1), cached; null when Payments does not answer.
	 * @param {Site} s
	 * @returns {Promise<BankDetails | null>}
	 */
	const bankDetails = async (s) => {
		const now = service.now();
		const cached = bankCache.get(s.websiteId);
		if (cached && now - cached.at < BANK_DETAILS_MS) return cached.value;
		const answer = await product
			.callProduct(s.websiteId, 'payments', '/v1/bank-transfer', { method: 'GET' })
			.catch(() => /** @type {const} */ ({ ok: false }));
		/** @param {unknown} value */
		const text = (value) => (typeof value === 'string' ? value : '');
		/** @type {BankDetails | null} */
		let value = null;
		if (answer.ok && answer.status === 200 && typeof answer.body === 'object' && answer.body !== null) {
			const body = /** @type {Record<string, unknown>} */ (answer.body);
			value = /** @type {BankDetails} */ ({
				ready: body.ready === true,
				...Object.fromEntries(BANK_FIELDS.map((field) => [field, text(body[field])])),
			});
		} else if (answer.ok)
			value = /** @type {BankDetails} */ ({ ready: false, ...Object.fromEntries(BANK_FIELDS.map((field) => [field, ''])) });
		bankCache.set(s.websiteId, { at: now, value });
		return value;
	};

	/**
	 * The texts a cart and an order show per payment method and for delivery and pickup (E22).
	 * @param {Record<string, any>} checkout
	 * @param {Record<string, any> | null} zones the `delivery_zones` settings
	 */
	const notesOf = (checkout, zones) => ({
		cod: String(checkout.noteCod ?? ''),
		online: String(checkout.noteOnline ?? ''),
		bank_transfer: String(checkout.noteBankTransfer ?? ''),
		pickup: String(checkout.notePickup ?? ''),
		delivery: String(zones?.deliveryNote ?? ''),
		prep: String(zones?.prepNote ?? ''),
		pickupReady: String(zones?.pickupReadyNote ?? ''),
	});

	/**
	 * Price a cart for a shopper (or a guest). `address` (placing an order) replaces the quote's city, area and country.
	 * @param {Site} s
	 * @param {CartInput} cart
	 * @param {Shopper | null} shopper
	 * @param {Address | null} [address]
	 * @param {{ customer?: import('../core/model.js').CustomerRecord | null, edit?: QuoteEdit }} [options] the guest's
	 *   customer record (placing a guest order: RTO count); `edit`: re-pricing an order staff edit (E29)
	 * @returns {Promise<Quote>}
	 */
	const quote = async (s, cart, shopper, address = null, options = {}) => {
		const edit = options.edit ?? null;
		const data = await s.data();
		const store = createOrdersStore(data);
		const now = service.now();
		const clock = await service.pricing(s);
		const { unit } = clock;
		const products = await store.products(cart.lines.map((line) => line.productId));
		const paths = await store.categoryPaths([...products.values()].flatMap((item) => item.categoryIds));
		/** @param {string[]} ids */
		const ancestors = (ids) => [...new Set(ids.flatMap((id) => [...(paths.get(id) ?? []), id]))];
		const grades = /** @type {import('../core/grades.js').Grade[]} */ (s.has('grades_serials') ? await s.list('grades') : []);
		const tree = new Map([...paths].map(([id, path]) => [id, { path }]));
		/**
		 * A grade's label for a product of these categories: the entry of its category or the nearest one above it first
		 * (E45). @param {string} key @param {string[]} categoryIds
		 */
		const gradeLabel = (key, categoryIds) => gradesFor(grades, lineageOf(categoryIds, tree)).get(key)?.label ?? key;
		const licences = await store.availableLicences(
			[...products.values()].filter((item) => item.kind === 'digital' && item.digital?.licenceKeys).map((item) => item.id),
		);
		// services booked in time slots: their item type's `slots` (dynamic model §1)
		const typed = await productTypes(data, [...products.values()], await s.list('item_types'));
		/** @param {import('../core/model.js').ProductRecord} item */
		const slots = (item) => {
			const type = typed.get(item.id);
			return type !== undefined && elementsOf(type, s.has).slots;
		};
		const bookingLines = cart.lines.filter((line) => {
			const item = products.get(line.productId);
			return item?.kind === 'service' && slots(item) && line.slot !== null;
		});
		const rules = s.has('bookings') && bookingLines.length > 0 ? await bookingRules(s) : null;
		const starts = bookingLines.map((line) => /** @type {number} */ (line.slot));
		const booked = rules
			? await store.booked(
					bookingLines.map((line) => line.productId),
					Math.min(...starts),
					Math.max(...starts) + 1,
				)
			: new Set();
		const lines = resolveLines(cart.lines, {
			products,
			ancestors,
			gradeLabel,
			features: { digital: s.has('digital_goods'), bookings: s.has('bookings') },
			slots,
			licences,
			booked,
			// called only for booking lines with a slot, so the rules were read
			slotOf: (item, start) => {
				const { hours, timeZone, leadMs, aheadMs } = /** @type {NonNullable<typeof rules>} */ (rules);
				if (start < now + leadMs || start > now + aheadMs) return null;
				const durationMinutes = /** @type {{ durationMinutes: number }} */ (item.booking).durationMinutes;
				return slotAt({ hours, durationMinutes, start, timeZone });
			},
		});
		// staff may set a line's unit price when editing an order (E29)
		const priced = lines
			.filter((line) => line.priced)
			.map((line) =>
				edit?.prices.has(line.variantId)
					? { ...line, unitPrice: /** @type {number} */ (edit.prices.get(line.variantId)) }
					: line,
			);
		const customer = options.customer ?? (shopper ? await store.customer(shopper.id) : null);
		const [checkout, codSettings] = await Promise.all([s.values('checkout'), s.values('cod')]);
		// staff switch cash on delivery off for new orders themselves (`cod.enabled`, AO-2); an order staff edit keeps it
		const codOn = s.has('cod') && (codSettings.enabled !== false || edit !== null);
		const zonesOn = s.has('delivery_zones');
		const zoneSettings = zonesOn ? await s.values('delivery_zones') : null;

		// offers, with the deals kept by valid locks (E18)
		const couponCode = s.has('coupons') ? cart.coupon : '';
		const offers = await loadOffers(data, { now, couponCode, deals: s.has('deals'), bundles: s.has('bundles') });
		const dealSettings = s.has('deals') ? await s.values('deals') : { lockMinutes: 0, shopperChoice: false };
		const lockMinutes = Number(dealSettings.lockMinutes ?? 0);
		const dealRules = dealRulesOf(dealSettings);
		const secret = s.has('deals') && lockMinutes > 0 ? await product.secrets.get(s.websiteId) : null;
		/** @type {Map<string, { dealId: string, perUnit: number, text: string }>} */
		const locked = new Map();
		if (secret)
			for (const line of priced) {
				const sent = cart.lines.find(
					// a line sent without its variant is the product's only (default) variant
					(input) => input.productId === line.productId && (input.variantId ?? line.variantId) === line.variantId,
				);
				const lock = readLock(sent?.lock, { secret, websiteId: s.websiteId, now });
				if (!lock || lock.variantId !== line.variantId) continue;
				// the price the lock kept: what the variant cost then less what the deal took off
				locked.set(line.key, {
					dealId: lock.dealId,
					perUnit: Math.max(0, line.unitPrice - (lock.price - lock.perUnit)),
					text: String(sent?.lock),
				});
			}
		const keptIds = [...new Set([...locked.values()].map((lock) => lock.dealId))].filter(
			(id) => !offers.deals.some((deal) => deal.id === id),
		);
		/** @type {DealRecord[]} */
		const kept =
			keptIds.length === 0
				? []
				: /** @type {DealRecord[]} */ (
						await data
							.collection(COLLECTIONS.deals)
							.find(
								{
									websiteId: data.websiteId,
									id: { $in: keptIds },
									$or: [{ limit: null }, { $expr: { $lt: ['$used', '$limit'] } }],
								},
								{ projection: { _id: 0, websiteId: 0, merchantId: 0 } },
							)
							.toArray()
					);
		const couponUses = shopper && offers.coupon ? await store.couponUses(offers.coupon.id, shopper.id) : 0;
		/** @param {PaymentMethod | null} method */
		const promote = (method) =>
			priced.length > 0
				? applyPromotions({
						lines: priced.map((line) => {
							const item = products.get(line.productId);
							const variant = item?.variants.find((v) => v.id === line.variantId);
							const input = cart.lines.find(
								(entry) => entry.productId === line.productId && (entry.variantId ?? '') === line.variantId,
							);
							return {
								key: line.key,
								productId: line.productId,
								variantId: line.variantId,
								categoryIds: line.allCategoryIds,
								brandId: line.brandId,
								unitPrice: line.unitPrice,
								quantity: line.quantity,
								grade: line.grade,
								attributes: item && variant ? attributeValues(item, variant) : {},
								dealId: input?.dealId ?? null,
								lock: locked.has(line.key)
									? { dealId: locked.get(line.key)?.dealId ?? '', perUnit: locked.get(line.key)?.perUnit ?? 0 }
									: null,
							};
						}),
						deals: edit ? edit.deals : [...offers.deals, ...kept],
						bundles: edit ? [] : offers.bundles,
						coupon: edit ? edit.coupon : offers.coupon,
						couponCode: edit ? (edit.coupon?.code ?? '') : couponCode,
						customer: edit ? { orderCount: 0, couponUses: 0 } : { orderCount: customer?.orderCount ?? 0, couponUses },
						now,
						cart: { paymentMethod: method, weekday: clock.weekday, minutes: clock.minutes },
						unit,
						shopperChoice: dealSettings.shopperChoice === true,
						rules: dealRules,
						asPlaced: edit !== null,
					})
				: null;

		// role pricing (E19)
		/** @type {Array<{ role: string, percent: number, label: string }>} */
		const rolePrices = s.has('role_pricing') && shopper?.role ? await s.list('role_prices') : [];
		const role = edit ? edit.role : (rolePrices.find((entry) => entry.role === shopper?.role) ?? null);
		const rolePercent = role?.percent ?? 0;

		const physical = priced.some((line) => line.kind === 'physical');
		const digital = priced.some((line) => line.kind === 'digital');
		const locations = physical && (zonesOn || s.has('multi_location')) ? await store.locations() : [];
		const pickups = zonesOn && physical && s.has('multi_location') ? locations.filter((location) => location.pickup) : [];
		// one pickup point of the settings while stock has no locations (E22)
		const pickupPoint =
			zonesOn && physical && !s.has('multi_location') && zoneSettings?.pickupEnabled === true
				? {
						name: String(zoneSettings.pickupName ?? ''),
						address: String(zoneSettings.pickupAddress ?? ''),
						hours: String(zoneSettings.pickupHours ?? ''),
					}
				: null;
		const pickupPossible = pickups.length > 0 || pickupPoint !== null;
		const where = {
			city: address?.city ?? cart.delivery.city,
			area: address?.area ?? cart.delivery.area,
			country: address?.country ?? cart.delivery.country,
		};
		const zones = zonesOn ? /** @type {import('../core/delivery.js').Zone[]} */ (await s.list('delivery_zones')) : [];
		const wantedMethod = cart.delivery.method ?? (zoneSettings?.defaultMethod === 'pickup' && pickupPossible ? 'pickup' : null);
		const taxesOn = s.has('taxes');
		const taxRules = taxesOn ? /** @type {import('../core/taxes.js').TaxRule[]} */ (await s.list('tax_rules')) : [];
		const taxIncluded = taxesOn ? (await s.values('taxes')).pricesIncludeTax === true : true;
		const loyaltySettings = s.has('loyalty') ? await s.values('loyalty') : null;
		// points are redeemed by a signed-in shopper who takes part and is a loyalty member (E20, E47)
		const loyaltyOn =
			loyaltySettings !== null &&
			shopper !== null &&
			takesPart(loyaltySettings, shopper.role) &&
			isLoyaltyMember(loyaltySettings, customer);
		const account = loyaltyOn
			? await loyaltyAccount(data, /** @type {Shopper} */ (shopper).id, {
					now,
					rules: { settings: /** @type {Record<string, any>} */ (loyaltySettings), timeZone: clock.timeZone },
				})
			: null;
		const paymentsConnected = (await product.connections.value(s.websiteId, 'payments')) !== null;
		/** @type {string[]} */
		const offered = checkout.paymentMethods;
		const bankManual = checkout.bankTransferVia === 'manual';
		const bank = offered.includes('bank_transfer') && paymentsConnected ? await bankDetails(s) : null;

		/**
		 * One pricing pass for a payment method.
		 * @param {PaymentMethod | null} method
		 */
		const pass = (method) => {
			const promotions = promote(method);
			const keep = edit?.keep ?? null;
			const merchandise = merchandiseOf(priced, promotions, keep ? keep.promotions : null, unit);
			const goods = merchandise - roleDiscountOf(merchandise, rolePercent, unit);

			// delivery
			const free = promotions?.freeDelivery === true;
			/** @type {DeliveryChoice[]} */
			const deliveryOptions = [];
			if (physical) {
				const zone = zonesOn ? matchZone(zones, where) : null;
				const rule = zone ?? {
					fee: Number(zoneSettings?.defaultFee ?? 0),
					freeOver: Number(zoneSettings?.defaultFreeOver ?? 0),
				};
				const fee = zonesOn ? zoneFee(rule, goods) : 0;
				deliveryOptions.push({
					method: 'delivery',
					zone: zone?.key ?? '',
					name: zone?.name ?? '',
					fee: free ? 0 : fee,
					locationId: null,
					minDays: zone?.minDays ?? null,
					maxDays: zone?.maxDays ?? null,
					freeOver: zonesOn ? rule.freeOver : 0,
				});
				for (const location of pickups)
					deliveryOptions.push({
						method: 'pickup',
						zone: '',
						name: location.name,
						fee: 0,
						locationId: location.id,
						minDays: null,
						maxDays: null,
					});
				if (pickupPoint)
					deliveryOptions.push({
						method: 'pickup',
						zone: '',
						name: pickupPoint.name,
						fee: 0,
						locationId: null,
						minDays: null,
						maxDays: null,
						address: pickupPoint.address,
						hours: pickupPoint.hours,
					});
			}
			const wantsPickup = physical && wantedMethod === 'pickup' && pickupPossible;
			const pickupOptions = deliveryOptions.filter((option) => option.method === 'pickup');
			const pickup = wantsPickup
				? (pickupOptions.find((option) => option.locationId !== null && option.locationId === cart.delivery.locationId) ??
					(pickupOptions.length === 1 && (cart.delivery.locationId === null || pickupPoint) ? pickupOptions[0] : undefined))
				: undefined;
			/** @type {DeliveryChoice} */
			const chosen = !physical
				? { method: 'none', zone: '', name: '', fee: 0, locationId: null, minDays: null, maxDays: null }
				: wantsPickup
					? (pickup ?? { method: 'pickup', zone: '', name: '', fee: 0, locationId: null, minDays: null, maxDays: null })
					: /** @type {DeliveryChoice} */ (deliveryOptions[0]);
			// an edited order that keeps its placed amounts keeps its delivery fee while its delivery method stays
			const delivery = keep && chosen.method === keep.deliveryMethod ? { ...chosen, fee: keep.delivery } : chosen;
			const deliveryProblem =
				physical && wantedMethod === 'pickup' && !pickup
					? !pickupPossible
						? 'pickup_unavailable'
						: 'choose_pickup_location'
					: null;

			// loyalty points (E20): none while a deal that allows no points applies
			/** @type {Quote['points']} */
			let points = null;
			if (edit && edit.points.used > 0) {
				// an edited order keeps the points it spent, worth at most the goods (E29)
				points = { balance: 0, max: edit.points.used, used: edit.points.used, value: Math.min(goods, edit.points.value) };
			} else if (account && loyaltySettings) {
				const settings = loyaltySettings;
				const subtotal = priced.reduce((n, line) => n + line.unitPrice * line.quantity, 0);
				const payable = loyaltyRules(settings).capBase === 'goods' ? subtotal : goods;
				const max = promotions?.pointsBlocked ? 0 : maxRedeemable({ balance: account.balance, payable }, settings);
				const used = pointsToRedeem(cart.points, max, settings, unit);
				points = {
					balance: account.balance,
					max,
					used,
					value: Math.min(goods, roundDown(pointsValue(used, settings), unit)),
				};
			}

			const region =
				delivery.method === 'delivery' && (where.country || where.city) ? { country: where.country, city: where.city } : null;
			const base = {
				lines: priced,
				promotions,
				delivery: delivery.fee,
				pointsValue: points?.value ?? 0,
				taxRules,
				region,
				taxIncluded,
				rolePercent,
				unit,
			};
			const fixedPromotions = keep ? { promotions: keep.promotions } : null;
			const unpriced = priceLines({ ...base, fixed: fixedPromotions });
			const feeBase = codSettings.feeBase === 'goods_after_discounts' ? 'goods_after_discounts' : 'order_total';
			const payments = paymentOptions({
				offered,
				order: Array.isArray(checkout.paymentOrder) ? checkout.paymentOrder : undefined,
				paymentsConnected,
				bankManual,
				cod: { on: codOn, settings: /** @type {import('../core/cod.js').CodSettings} */ (codSettings) },
				pickupPossible,
				deliveryMethod: delivery.method,
				digital,
				total: unpriced.totals.total,
				feeBase: feeBaseOf(unpriced, feeBase),
				rtoCount: customer?.rtoCount ?? 0,
				unit,
			}).map((option) =>
				// bank transfer waits for Payments' bank details (or its `requireDetails` off), also when staff record the
				// transfers (CK-33); a Payments that does not answer leaves it offered
				option.method === 'bank_transfer' && bank !== null && !bank.ready
					? { ...option, available: false, reason: 'not_ready' }
					: option,
			);
			const effective = method ?? payments.find((option) => option.available)?.method ?? null;
			const feePercent = effective === 'cod' && codOn ? Number(codSettings.feePercent ?? 0) : 0;
			// an edited order that keeps its placed amounts keeps its payment method's fee while the method stays
			const keptFee = keep && effective === keep.method ? keep.fee : null;
			const { lines: prices, totals } =
				keptFee !== null
					? priceLines({ ...base, fixed: { promotions: keep?.promotions ?? 0, fee: keptFee } })
					: feePercent > 0
						? priceLines({ ...base, feePercent, feeBase, fixed: fixedPromotions })
						: unpriced;
			return { promotions, delivery, deliveryOptions, deliveryProblem, points, prices, totals, payments, effective };
		};

		let result = pass(cart.payment);
		// no method asked: price again for the first available one (its deals and fee, E18 and E22)
		if (cart.payment === null && result.effective !== null) result = pass(result.effective);
		const { promotions, delivery, deliveryOptions, deliveryProblem, points, prices, totals, payments } = result;

		// each line links to its variant's page, by the URL templates (E13)
		/** @type {Map<string, string>} */
		const urls = new Map();
		const fields = await attributesOf(data);
		const attributes = new Map(fields.map((field) => [field.id, field]));
		for (const line of priced) {
			const item = products.get(line.productId);
			const variant = item?.variants.find((v) => v.id === line.variantId);
			if (item && variant) urls.set(line.key, await media.variantUrl(s, item, variant, attributes));
		}

		// the deals of the lines (display fields) and each line's signed lock (E18)
		/** @type {Map<string, DealRecord>} */
		const deals = new Map([...offers.deals, ...kept].map((deal) => [deal.id, deal]));
		/** @type {Map<string, string>} */
		const locks = new Map();
		if (secret && promotions)
			for (const entry of promotions.lines) {
				const line = priced.find((candidate) => candidate.key === entry.key);
				if (!line || !entry.dealId || !entry.perUnit) continue;
				// a line its lock kept keeps that lock (and its end); others get a new one
				const kept = entry.locked ? locked.get(entry.key)?.text : undefined;
				locks.set(
					entry.key,
					kept ??
						signLock(
							{
								dealId: entry.dealId,
								variantId: line.variantId,
								price: line.unitPrice,
								perUnit: entry.perUnit,
								exp: now + lockMinutes * 60_000,
							},
							{ secret, websiteId: s.websiteId },
						),
				);
			}

		const earnTotals = { total: totals.total, delivery: totals.delivery, tax: totals.tax, fee: totals.fee };
		const earns =
			loyaltySettings !== null &&
			(shopper ? takesPart(loyaltySettings, shopper.role) : loyaltyRules(loyaltySettings).guests === 'earn') &&
			earnsAsMember(loyaltySettings, customer);
		return {
			lines,
			priced,
			prices,
			totals,
			promotions,
			urls,
			deals,
			locks,
			coupon: promotions?.couponId ? offers.coupon : null,
			delivery,
			deliveryOptions,
			deliveryProblem,
			payments,
			paymentMethod: result.effective,
			points,
			pointsToEarn: earns
				? Math.max(0, Math.floor(pointsToEarn(earnTotals, /** @type {Record<string, any>} */ (loyaltySettings))))
				: 0,
			role: role && totals.roleDiscount > 0 ? { key: role.role, percent: role.percent, label: role.label } : null,
			digital,
			customer,
			locations,
			bankDetails: offered.includes('bank_transfer') ? bank : null,
			notes: notesOf(checkout, zoneSettings),
			// the order fields the checkout asks the shopper (dynamic model §2)
			fields: checkoutFields(fields),
			ready: lines.length > 0 && lines.every((line) => line.priced && line.problems.length === 0) && deliveryProblem === null,
		};
	};

	/**
	 * A deal as a cart line shows it (E18 display fields).
	 * @param {DealRecord | undefined} deal
	 */
	const dealBadge = (deal) =>
		deal
			? {
					id: deal.id,
					name: deal.name,
					slug: deal.slug,
					badgeLabel: deal.badgeLabel,
					discountLabel: deal.discountLabel,
					color: deal.color,
					minQuantity: deal.conditions?.minQuantity ?? 0,
				}
			: null;

	/**
	 * A priced cart as the visitor sees it.
	 * @param {Site} s
	 * @param {Quote} q
	 */
	const view = async (s, q) => ({
		currency: s.currency,
		lines: await Promise.all(
			q.lines.map(async (line) => {
				const price = line.priced ? q.prices[q.priced.indexOf(line)] : undefined;
				const promo = q.promotions?.lines.find((entry) => entry.key === line.key);
				return {
					key: line.key,
					productId: line.productId,
					variantId: line.variantId || null,
					kind: line.kind,
					name: line.name,
					variantName: line.variantName,
					gradeLabel: line.gradeLabel,
					url: q.urls?.get(line.key) ?? null,
					image: await media.mediaUrl(s, line.image),
					slot: line.booking
						? { start: new Date(line.booking.start).toISOString(), end: new Date(line.booking.end).toISOString() }
						: null,
					unitPrice: line.unitPrice,
					quantity: line.quantity,
					discount: price?.discount ?? 0,
					dealDiscount: promo?.dealDiscount ?? 0,
					tax: price?.tax ?? 0,
					total: price?.total ?? 0,
					deal: dealBadge(promo?.dealId ? q.deals.get(promo.dealId) : undefined),
					eligibleDeals: (promo?.eligibleDealIds ?? []).flatMap((id) => {
						const badge = dealBadge(q.deals.get(id));
						return badge ? [badge] : [];
					}),
					lock: q.locks.get(line.key) ?? null,
					problems: line.problems,
				};
			}),
		),
		promotions: {
			applied: q.promotions?.applied ?? [],
			couponCode: q.promotions?.couponCode ?? '',
			couponProblem: q.promotions?.couponProblem ?? null,
			freeDelivery: q.promotions?.freeDelivery === true,
			pointsBlocked: q.promotions?.pointsBlocked === true,
		},
		role: q.role,
		delivery: q.delivery,
		deliveryOptions: q.deliveryOptions,
		deliveryProblem: q.deliveryProblem,
		paymentMethods: q.payments,
		paymentMethod: q.paymentMethod,
		bankDetails: q.bankDetails,
		notes: q.notes,
		fields: q.fields,
		points: q.points,
		pointsToEarn: q.pointsToEarn,
		totals: q.totals,
		ready: q.ready,
	});

	/**
	 * The free slots of a booking product between two instants (at most {@link MAX_SLOT_DAYS} days, inside the lead time
	 * and the days ahead), without booked ones.
	 * @param {Site} s
	 * @param {ProductRecord} item
	 * @param {{ from: number, to: number }} range epoch ms
	 */
	const freeSlots = async (s, item, range) => {
		const rules = await bookingRules(s);
		const now = service.now();
		const from = Math.max(range.from, now + rules.leadMs);
		const to = Math.min(range.to, range.from + MAX_SLOT_DAYS * DAY_MS, now + rules.aheadMs);
		const durationMinutes = item.booking?.durationMinutes ?? 0;
		const slots = slotsBetween({ hours: rules.hours, durationMinutes, from, to, timeZone: rules.timeZone });
		const booked = slots.length > 0 ? await createOrdersStore(await s.data()).booked([item.id], from, to) : new Set();
		return {
			productId: item.id,
			durationMinutes,
			timeZone: rules.timeZone,
			slots: slots
				.filter((slot) => !booked.has(`${item.id}|${slot.start}`))
				.map((slot) => ({ start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() })),
		};
	};

	return Object.freeze({ quote, view, freeSlots, bankDetailsOf: bankDetails });
};

/** @typedef {ReturnType<typeof createQuoting>} Quoting */
