/**
 * The cart and checkout (PLAN 0.8.8): pricing a cart (`checkout-quote.js`), placing and paying orders and the
 * shopper's own orders (`checkout-orders.js`), digital goods (`checkout-digital.js`) and bookable slots. Features
 * `checkout`, `cod`, `delivery_zones`, `taxes`, `digital_goods` and `bookings`. Waiting orders are rechecked and
 * ended on use (`service.whenUsed`), never on a timer.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { createOrdersStore } from '../adapters/orders-store.js';
import { OPTIONAL_ADDRESS_FIELDS } from '../core/checkout.js';
import { zoneCities } from '../core/delivery.js';
import { createDigital } from './checkout-digital.js';
import { createOrdering } from './checkout-orders.js';
import { createQuoting } from './checkout-quote.js';
import { SERVER_LIMITS, VISITOR_LIMITS, VISITOR_WRITE_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */

const DAY_MS = 86_400_000;
/** The shared rate limits as the route definitions take them. */
const SERVER = [...SERVER_LIMITS];
const VISITOR = [...VISITOR_LIMITS];
const VISITOR_WRITE = [...VISITOR_WRITE_LIMITS];

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createCheckout = (product, service) => {
	const quoting = createQuoting(product, service);
	const digital = createDigital(product, service);
	const ordering = createOrdering(product, service, { quoting, digital });

	service.whenUsed(ordering.sweep);
	service.on('order.paid', (s, { order }) => (s.has('digital_goods') ? digital.giveLicences(s, order) : undefined));

	/** The free slots of a booking product (`productId`, optional `from` and `to`, ISO 8601). @param {any} ctx */
	const slots = async (ctx) => {
		const s = await service.site(ctx);
		const productId = typeof ctx.query.productId === 'string' ? ctx.query.productId : '';
		if (!productId || productId.length > 64) throw service.invalid('productId', 'productId names a booking product.');
		const now = service.now();
		const from = ctx.query.from ? Date.parse(String(ctx.query.from)) : now;
		const to = ctx.query.to ? Date.parse(String(ctx.query.to)) : from + 7 * DAY_MS;
		if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
			throw service.invalid('from', 'from and to are instants (ISO 8601), from before to.');
		const item = await createOrdersStore(await s.data()).product(productId);
		if (!item || item.status !== 'active' || item.kind !== 'booking' || !item.booking)
			throw problem('not_found', 'There is no such booking product.');
		return quoting.freeSlots(s, item, { from, to });
	};

	/**
	 * What the cart, checkout and my-orders widgets need (never secrets).
	 * @param {Site} s
	 */
	const widgetSettings = async (s) => {
		if (!s.has('checkout')) return {};
		const checkout = await s.values('checkout');
		/** @type {string[]} */
		const offered = checkout.paymentMethods;
		const paymentsConnected = (await product.connections.value(s.websiteId, 'payments')) !== null;
		const zonesOn = s.has('delivery_zones');
		const pickupLocations = zonesOn
			? (await createOrdersStore(await s.data()).locations())
					.filter((location) => location.pickup)
					.map((location) => ({ id: location.id, name: location.name }))
			: [];
		const cod = s.has('cod') ? await s.values('cod') : null;
		/** @type {string[]} */
		const required = checkout.addressRequired;
		return {
			checkout: {
				paymentMethods: [
					...(cod ? ['cod'] : []),
					...['online', 'bank_transfer'].filter((method) => paymentsConnected && offered.includes(method)),
					...(offered.includes('pickup') && pickupLocations.length > 0 ? ['pickup'] : []),
				],
				cod: cod
					? {
							maxOrderValue: cod.maxOrderValue,
							advanceAmount: paymentsConnected ? cod.advanceAmount : 0,
							advancePercent: paymentsConnected ? cod.advancePercent : 0,
						}
					: null,
				pickupLocations,
				delivery: {
					zones: zonesOn,
					cities: zonesOn ? zoneCities(await s.list('delivery_zones')) : [],
				},
				pricesIncludeTax: s.has('taxes') ? (await s.values('taxes')).pricesIncludeTax === true : true,
				policies: {
					shipping: checkout.policyShipping,
					returns: checkout.policyReturns,
					privacy: checkout.policyPrivacy,
					terms: checkout.policyTerms,
				},
				bookings: s.has('bookings'),
				digital: s.has('digital_goods'),
				coupons: s.has('coupons'),
				loyalty: s.has('loyalty'),
				address: {
					required: ['name', 'phone', 'line1', 'city', ...OPTIONAL_ADDRESS_FIELDS.filter((f) => required.includes(f))],
					optional: [...OPTIONAL_ADDRESS_FIELDS.filter((f) => !required.includes(f)), 'notes'],
				},
				paymentWindowMinutes: checkout.paymentWindowMinutes,
			},
		};
	};

	return {
		routes: [
			defineRoute({
				method: 'POST',
				path: '/v1/shop/cart/quote',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR,
				handler: ordering.quoteCart,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders',
				auth: 'browser',
				feature: 'checkout',
				idempotent: true,
				rateLimit: VISITOR_WRITE,
				handler: ordering.place,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR,
				handler: ordering.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders/:id',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR,
				handler: ordering.read,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders/:id/cancel',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_WRITE,
				handler: ordering.cancelByShopper,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders/:id/pay',
				auth: 'browser',
				feature: 'checkout',
				idempotent: true,
				rateLimit: VISITOR_WRITE,
				handler: ordering.pay,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders/:id/downloads/:lineId/:file',
				auth: 'browser',
				feature: 'digital_goods',
				rateLimit: VISITOR,
				handler: ordering.downloadFile,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/slots',
				auth: 'browser',
				feature: 'bookings',
				rateLimit: VISITOR,
				handler: slots,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/products/:id/licences',
				auth: 'server',
				feature: 'digital_goods',
				rateLimit: SERVER,
				handler: digital.addLicences,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/products/:id/licences',
				auth: 'ticket',
				feature: 'digital_goods',
				permission: 'catalog.edit',
				rateLimit: SERVER,
				handler: digital.addLicences,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/products/:id/files',
				auth: 'server',
				feature: 'digital_goods',
				rateLimit: SERVER,
				handler: digital.addFile,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/products/:id/files',
				auth: 'ticket',
				feature: 'digital_goods',
				permission: 'catalog.edit',
				rateLimit: SERVER,
				handler: digital.addFile,
			}),
		],
		widgetSettings,
	};
};
