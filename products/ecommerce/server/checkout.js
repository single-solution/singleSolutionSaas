/**
 * The cart and checkout (PLAN 0.8.8): pricing a cart (`checkout-quote.js`), placing and paying orders and the
 * shopper's own orders (`checkout-orders.js`), digital goods (`checkout-digital.js`) and bookable slots. Features
 * `checkout`, `cod`, `delivery_zones`, `taxes`, `digital_goods` and `bookings`. Waiting orders are rechecked and
 * ended on use (`service.whenUsed`), never on a timer.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { productTypes } from '../adapters/catalog-store.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { elementsOf } from '../core/item-types.js';
import { OPTIONAL_ADDRESS_FIELDS } from '../core/address.js';
import { zoneCities } from '../core/delivery.js';
import { guestRules } from '../core/guests.js';
import { createDigital } from './checkout-digital.js';
import { createOrdering } from './checkout-orders.js';
import { createQuoting } from './checkout-quote.js';
import { policiesOf } from './policies.js';
import { SERVER_LIMITS, VISITOR_LIMITS, VISITOR_WRITE_LIMITS } from './service.js';
import { DAY_MS } from '../core/durations.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area & { ordering: import('./checkout-orders.js').Ordering }}
 */
export const createCheckout = (product, service) => {
	const quoting = createQuoting(product, service);
	const digital = createDigital(product, service);
	const ordering = createOrdering(product, service, { quoting, digital });

	service.whenUsed(ordering.sweep);
	service.on('order.paid', (s, { order }) => (s.has('digital_goods') ? digital.giveLicenses(s, order) : undefined));

	/**
	 * The free slots of a service booked in time slots (its item type's `slots`; `productId`, optional `from` and `to`,
	 * ISO 8601). @param {any} ctx
	 */
	const slots = async (ctx) => {
		const s = await service.site(ctx);
		const productId = typeof ctx.query.productId === 'string' ? ctx.query.productId : '';
		if (!productId || productId.length > 64) throw service.invalid('productId', 'productId names a booking product.');
		const now = service.now();
		const from = ctx.query.from ? Date.parse(String(ctx.query.from)) : now;
		const to = ctx.query.to ? Date.parse(String(ctx.query.to)) : from + 7 * DAY_MS;
		if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
			throw service.invalid('from', 'from and to are instants (ISO 8601), from before to.');
		const data = await s.data();
		const item = await createOrdersStore(data).product(productId);
		const type = item ? (await productTypes(data, [item], await s.list('item_types'))).get(item.id) : undefined;
		if (
			!item ||
			!type ||
			item.status !== 'active' ||
			item.kind !== 'service' ||
			!item.booking ||
			!elementsOf(type, s.has).slots
		)
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
		const paymentsConnected = (await product.connections.value(s.websiteId, 'payments')) !== null;
		const zonesOn = s.has('delivery_zones');
		const zones = zonesOn ? /** @type {import('../core/delivery.js').Zone[]} */ (await s.list('delivery_zones')) : [];
		// pickup is a kind of rate (E5): offered at the stock locations that take pickups (Multi-location stock), else at
		// the one pickup point of the settings (E22)
		const pickupRates = zones.some((zone) => zone.rates.some((rate) => rate.kind === 'pickup'));
		const pickupLocations =
			pickupRates && s.has('multi_location')
				? (await createOrdersStore(await s.data()).locations())
						.filter((location) => location.pickup)
						.map((location) => ({ id: location.id, name: location.name }))
				: [];
		const zonesPickup = pickupRates && !s.has('multi_location') && (await s.values('delivery_zones')).pickupEnabled === true;
		// the methods a cart may offer: active ones, through Payments while it is connected, at pickup with a pickup point
		const methods = (await service.methods.methodsOf(s)).filter(
			(method) =>
				method.active &&
				(method.kind === 'gateway' || (method.kind === 'pay_first' && method.via === 'payments')
					? paymentsConnected
					: true) &&
				(method.kind === 'at_pickup' ? pickupLocations.length > 0 || zonesPickup : true),
		);
		/** @type {string[]} */
		const required = checkout.addressRequired;
		const phoneNeeded = checkout.phoneRequired !== false;
		return {
			checkout: {
				// the most lines of a cart; each line's own limits come with its quote
				maxLines: checkout.maxLines,
				paymentMethods: methods.map((method) => ({ key: method.key, name: method.name, kind: method.kind })),
				pickupLocations,
				delivery: { cities: zoneCities(zones) },
				...(await (async () => {
					const filled = await policiesOf(s);
					return { policies: filled.policies, policyFormat: filled.format };
				})()),
				// how a shopper orders without signing in (E21): the contact guests check out by and whether a phone is
				// needed (phase 5); null while guests sign in
				guests: checkout.guests === 'off' ? null : guestRules(checkout),
				address: {
					// the fields the website requires; the form shows the parts each country's format uses besides
					required: [
						'name',
						...(phoneNeeded ? ['phone'] : []),
						...OPTIONAL_ADDRESS_FIELDS.filter((f) => required.includes(f)),
					],
					// the region names offered per country (`address_regions`), and the country of an address without one
					regions: await s.list('address_regions'),
					country: (await s.business()).country ?? '',
				},
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
				rateLimit: VISITOR_LIMITS,
				handler: ordering.quoteCart,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders',
				auth: 'browser',
				feature: 'checkout',
				idempotent: true,
				rateLimit: VISITOR_WRITE_LIMITS,
				handler: ordering.place,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_LIMITS,
				handler: ordering.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders/:id',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_LIMITS,
				handler: ordering.read,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders/by-number/:number',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_LIMITS,
				handler: ordering.readByNumber,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders/:id/proof/upload',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_WRITE_LIMITS,
				handler: ordering.proofUpload,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders/:id/proof',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_WRITE_LIMITS,
				handler: ordering.sendProof,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders/:id/cancel',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_WRITE_LIMITS,
				handler: ordering.cancelByShopper,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/shop/orders/:id/pay',
				auth: 'browser',
				feature: 'checkout',
				idempotent: true,
				rateLimit: VISITOR_WRITE_LIMITS,
				handler: ordering.pay,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders/:id/downloads/:lineId/:file',
				auth: 'browser',
				feature: 'digital_goods',
				rateLimit: VISITOR_LIMITS,
				handler: ordering.downloadFile,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/slots',
				auth: 'browser',
				feature: 'bookings',
				rateLimit: VISITOR_LIMITS,
				handler: slots,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/products/:id/licenses',
				auth: 'server',
			permission: 'catalog.edit',
				feature: 'digital_goods',
				rateLimit: SERVER_LIMITS,
				handler: digital.addLicenses,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/products/:id/licenses',
				auth: 'ticket',
				feature: 'digital_goods',
				permission: 'catalog.edit',
				rateLimit: SERVER_LIMITS,
				handler: digital.addLicenses,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/products/:id/licenses/remove',
				auth: 'server',
			permission: 'catalog.edit',
				feature: 'digital_goods',
				rateLimit: SERVER_LIMITS,
				handler: digital.removeLicenses,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/products/:id/licenses/remove',
				auth: 'ticket',
				feature: 'digital_goods',
				permission: 'catalog.edit',
				rateLimit: SERVER_LIMITS,
				handler: digital.removeLicenses,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/products/:id/files/:name',
				auth: 'server',
			permission: 'catalog.edit',
				feature: 'digital_goods',
				rateLimit: SERVER_LIMITS,
				handler: digital.removeFile,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/admin/products/:id/files/:name',
				auth: 'ticket',
				feature: 'digital_goods',
				permission: 'catalog.edit',
				rateLimit: SERVER_LIMITS,
				handler: digital.removeFile,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/products/:id/files',
				auth: 'server',
			permission: 'catalog.edit',
				feature: 'digital_goods',
				rateLimit: SERVER_LIMITS,
				handler: digital.addFile,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/products/:id/files',
				auth: 'ticket',
				feature: 'digital_goods',
				permission: 'catalog.edit',
				rateLimit: SERVER_LIMITS,
				handler: digital.addFile,
			}),
		],
		widgetSettings,
		ordering,
	};
};
