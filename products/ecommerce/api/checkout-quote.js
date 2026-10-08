/**
 * Pricing a cart against the website's catalog and settings (`core/checkout.js` does the arithmetic): the products
 * and variants, category ancestors, grade names, licence keys and booked slots it needs, the offers (`loadOffers` and
 * `applyPromotions`, while `deals`, `bundles` and `coupons` are on), loyalty points (while `loyalty` is on and the
 * shopper is signed in), delivery zones and pickup locations (`delivery_zones`), tax rules (`taxes`) and the payment
 * methods the cart may use. Used by the quote route and again, on the server, when an order is placed. Also the
 * bookable slots of a product (`bookings`).
 * @module
 */
import { loyaltyAccount } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { loadOffers } from '../adapters/promotions-store.js';
import { MAX_SLOT_DAYS, slotAt, slotsBetween } from '../core/bookings.js';
import { merchandiseOf, paymentOptions, priceLines, resolveLines } from '../core/checkout.js';
import { matchZone, zoneFee } from '../core/delivery.js';
import { maxRedeemable, pointsValue } from '../core/loyalty.js';
import { applyPromotions } from '../core/promotions.js';
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

const DAY_MS = 86_400_000;

/**
 * @typedef {object} DeliveryChoice
 * @property {'delivery' | 'pickup' | 'none'} method
 * @property {string} zone zone key ('' = no zone matched or zones off)
 * @property {string} name zone or pickup location name
 * @property {number} fee
 * @property {string | null} locationId pickup location
 * @property {number | null} minDays
 * @property {number | null} maxDays
 */

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
 * @property {import('../core/checkout.js').PaymentOption[]} payments
 * @property {{ balance: number, max: number, used: number, value: number } | null} points
 * @property {boolean} digital the cart has digital items
 * @property {import('../core/model.js').CustomerRecord | null} customer
 * @property {LocationRecord[]} locations stock locations in their order (multi_location)
 * @property {boolean} ready nothing stops placing it
 */

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createQuoting = (product, service) => {
	const media = createMedia(product);

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
	 * Price a cart for a shopper (or a guest). `address` (placing an order) replaces the quote's city, area and country.
	 * @param {Site} s
	 * @param {CartInput} cart
	 * @param {Shopper | null} shopper
	 * @param {Address | null} [address]
	 * @returns {Promise<Quote>}
	 */
	const quote = async (s, cart, shopper, address = null) => {
		const data = await s.data();
		const store = createOrdersStore(data);
		const now = service.now();
		const products = await store.products(cart.lines.map((line) => line.productId));
		const paths = await store.categoryPaths([...products.values()].flatMap((item) => item.categoryIds));
		/** @param {string[]} ids */
		const ancestors = (ids) => [...new Set(ids.flatMap((id) => [...(paths.get(id) ?? []), id]))];
		const grades = /** @type {import('../core/grades.js').Grade[]} */ (s.has('grades_serials') ? await s.list('grades') : []);
		/** @param {string} key */
		const gradeLabel = (key) => grades.find((grade) => grade.key === key)?.label ?? key;
		const licences = await store.availableLicences(
			[...products.values()].filter((item) => item.kind === 'digital' && item.digital?.licenceKeys).map((item) => item.id),
		);
		const bookingLines = cart.lines.filter((line) => products.get(line.productId)?.kind === 'booking' && line.slot !== null);
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
		const priced = lines.filter((line) => line.priced);
		const customer = shopper ? await store.customer(shopper.id) : null;

		// promotions
		const couponCode = s.has('coupons') ? cart.coupon : '';
		const offers = await loadOffers(data, { now, couponCode, deals: s.has('deals'), bundles: s.has('bundles') });
		const couponUses = shopper && offers.coupon ? await store.couponUses(offers.coupon.id, shopper.id) : 0;
		const promotions =
			priced.length > 0
				? applyPromotions({
						lines: priced.map((line) => ({
							key: line.key,
							productId: line.productId,
							variantId: line.variantId,
							categoryIds: line.allCategoryIds,
							brandId: line.brandId,
							unitPrice: line.unitPrice,
							quantity: line.quantity,
						})),
						deals: offers.deals,
						bundles: offers.bundles,
						coupon: offers.coupon,
						couponCode,
						customer: { orderCount: customer?.orderCount ?? 0, couponUses },
						now,
					})
				: null;
		const merchandise = merchandiseOf(priced, promotions);

		// delivery
		const physical = priced.some((line) => line.kind === 'physical');
		const digital = priced.some((line) => line.kind === 'digital');
		const zonesOn = s.has('delivery_zones');
		const locations = physical && (zonesOn || s.has('multi_location')) ? await store.locations() : [];
		const pickups = zonesOn && physical ? locations.filter((location) => location.pickup) : [];
		const where = {
			city: address?.city ?? cart.delivery.city,
			area: address?.area ?? cart.delivery.area,
			country: address?.country ?? cart.delivery.country,
		};
		const free = promotions?.freeDelivery === true;
		/** @type {DeliveryChoice[]} */
		const deliveryOptions = [];
		if (physical) {
			const zones = zonesOn ? /** @type {import('../core/delivery.js').Zone[]} */ (await s.list('delivery_zones')) : [];
			const zone = zonesOn ? matchZone(zones, where) : null;
			const defaults = zonesOn ? await s.values('delivery_zones') : null;
			const fee = zone
				? zoneFee(zone, merchandise)
				: defaults
					? zoneFee({ fee: Number(defaults.defaultFee ?? 0), freeOver: Number(defaults.defaultFreeOver ?? 0) }, merchandise)
					: 0;
			deliveryOptions.push({
				method: 'delivery',
				zone: zone?.key ?? '',
				name: zone?.name ?? '',
				fee: free ? 0 : fee,
				locationId: null,
				minDays: zone?.minDays ?? null,
				maxDays: zone?.maxDays ?? null,
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
		}
		const wantsPickup = physical && cart.delivery.method === 'pickup' && pickups.length > 0;
		const pickup = wantsPickup
			? (deliveryOptions.find((option) => option.method === 'pickup' && option.locationId === cart.delivery.locationId) ??
				(cart.delivery.locationId === null && pickups.length === 1 ? deliveryOptions[1] : undefined))
			: undefined;
		/** @type {DeliveryChoice} */
		const delivery = !physical
			? { method: 'none', zone: '', name: '', fee: 0, locationId: null, minDays: null, maxDays: null }
			: wantsPickup
				? (pickup ?? { method: 'pickup', zone: '', name: '', fee: 0, locationId: null, minDays: null, maxDays: null })
				: /** @type {DeliveryChoice} */ (deliveryOptions[0]);
		const deliveryProblem =
			physical && cart.delivery.method === 'pickup' && !pickup
				? pickups.length === 0
					? 'pickup_unavailable'
					: 'choose_pickup_location'
				: null;

		// loyalty points
		/** @type {Quote['points']} */
		let points = null;
		if (s.has('loyalty') && shopper) {
			const settings = await s.values('loyalty');
			const account = await loyaltyAccount(data, shopper.id, { now });
			const max = maxRedeemable({ balance: account.balance, payable: merchandise }, settings);
			const asked = Math.min(cart.points, max);
			// fewer than the least redeemable at once: none
			const used = maxRedeemable({ balance: asked, payable: merchandise }, settings) === asked ? asked : 0;
			points = { balance: account.balance, max, used, value: Math.min(merchandise, pointsValue(used, settings)) };
		}

		// taxes
		const taxesOn = s.has('taxes');
		const taxRules = taxesOn ? /** @type {import('../core/taxes.js').TaxRule[]} */ (await s.list('tax_rules')) : [];
		const taxIncluded = taxesOn ? (await s.values('taxes')).pricesIncludeTax === true : true;
		const region =
			delivery.method === 'delivery' && (where.country || where.city) ? { country: where.country, city: where.city } : null;
		const { lines: prices, totals } = priceLines({
			lines: priced,
			promotions,
			delivery: delivery.fee,
			pointsValue: points?.value ?? 0,
			taxRules,
			region,
			taxIncluded,
		});

		// payment methods
		const checkout = await s.values('checkout');
		const cod = await s.values('cod');
		const payments = paymentOptions({
			offered: checkout.paymentMethods,
			paymentsConnected: (await product.connections.value(s.websiteId, 'payments')) !== null,
			cod: {
				on: s.has('cod'),
				settings: /** @type {import('../core/cod.js').CodSettings} */ (cod),
			},
			pickupPossible: pickups.length > 0,
			deliveryMethod: delivery.method,
			digital,
			total: totals.total,
			rtoCount: customer?.rtoCount ?? 0,
		});

		return {
			lines,
			priced,
			prices,
			totals,
			promotions,
			coupon: promotions?.couponId ? offers.coupon : null,
			delivery,
			deliveryOptions,
			deliveryProblem,
			payments,
			points,
			digital,
			customer,
			locations,
			ready: lines.length > 0 && lines.every((line) => line.priced && line.problems.length === 0) && deliveryProblem === null,
		};
	};

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
				return {
					key: line.key,
					productId: line.productId,
					variantId: line.variantId || null,
					kind: line.kind,
					name: line.name,
					variantName: line.variantName,
					gradeLabel: line.gradeLabel,
					image: await media.mediaUrl(s, line.image),
					slot: line.booking
						? { start: new Date(line.booking.start).toISOString(), end: new Date(line.booking.end).toISOString() }
						: null,
					unitPrice: line.unitPrice,
					quantity: line.quantity,
					discount: price?.discount ?? 0,
					tax: price?.tax ?? 0,
					total: price?.total ?? 0,
					problems: line.problems,
				};
			}),
		),
		promotions: {
			applied: q.promotions?.applied ?? [],
			couponCode: q.promotions?.couponCode ?? '',
			couponProblem: q.promotions?.couponProblem ?? null,
			freeDelivery: q.promotions?.freeDelivery === true,
		},
		delivery: q.delivery,
		deliveryOptions: q.deliveryOptions,
		deliveryProblem: q.deliveryProblem,
		paymentMethods: q.payments,
		points: q.points,
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

	return Object.freeze({ quote, view, freeSlots });
};

/** @typedef {ReturnType<typeof createQuoting>} Quoting */
