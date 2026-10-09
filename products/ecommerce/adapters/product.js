/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Ecommerce's
 * manifest (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (storage, the
 * Accounts, Payments and Notifications tokens, courier keys and the AI key), the merchant database indexes of every
 * part, the data-rights and widget-config hooks (filled in by `server/routes.js`), and adds the list settings (product
 * database), the courier APIs and the AI provider on the same outbound policy. The Next.js route and the tests pass the
 * rest (config, store, clock, network). Public entry `./product` of this package, so a system test can compose the
 * product with `./routes`.
 * @module
 */
import { createMemoryStore, createMongoStore, createProduct } from '@ss/app-kit';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import { MongoClient } from 'mongodb';
import manifestFile from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import catalogSettings from '../schemas/catalog.settings.json' with { type: 'json' };
import variantsSettings from '../schemas/variants.settings.json' with { type: 'json' };
import multiLocationSettings from '../schemas/multi_location.settings.json' with { type: 'json' };
import gradesSerialsSettings from '../schemas/grades_serials.settings.json' with { type: 'json' };
import digitalGoodsSettings from '../schemas/digital_goods.settings.json' with { type: 'json' };
import bookingsSettings from '../schemas/bookings.settings.json' with { type: 'json' };
import checkoutSettings from '../schemas/checkout.settings.json' with { type: 'json' };
import codSettings from '../schemas/cod.settings.json' with { type: 'json' };
import deliveryZonesSettings from '../schemas/delivery_zones.settings.json' with { type: 'json' };
import courierApisSettings from '../schemas/courier_apis.settings.json' with { type: 'json' };
import taxesSettings from '../schemas/taxes.settings.json' with { type: 'json' };
import couponsSettings from '../schemas/coupons.settings.json' with { type: 'json' };
import dealsSettings from '../schemas/deals.settings.json' with { type: 'json' };
import loyaltySettings from '../schemas/loyalty.settings.json' with { type: 'json' };
import bundlesSettings from '../schemas/bundles.settings.json' with { type: 'json' };
import reviewsSettings from '../schemas/reviews.settings.json' with { type: 'json' };
import wishlistSettings from '../schemas/wishlist.settings.json' with { type: 'json' };
import alertsSettings from '../schemas/alerts.settings.json' with { type: 'json' };
import compareSettings from '../schemas/compare.settings.json' with { type: 'json' };
import returnsSettings from '../schemas/returns.settings.json' with { type: 'json' };
import invoicesSettings from '../schemas/invoices.settings.json' with { type: 'json' };
import csvSettings from '../schemas/csv.settings.json' with { type: 'json' };
import bulkActionsSettings from '../schemas/bulk_actions.settings.json' with { type: 'json' };
import reportsSettings from '../schemas/reports.settings.json' with { type: 'json' };
import seoSettings from '../schemas/seo.settings.json' with { type: 'json' };
import feedsSettings from '../schemas/feeds.settings.json' with { type: 'json' };
import aiCopySettings from '../schemas/ai_copy.settings.json' with { type: 'json' };
import llmsTxtSettings from '../schemas/llms_txt.settings.json' with { type: 'json' };
import { createAi } from './ai.js';
import { INDEXES as CATALOG_INDEXES } from './catalog-store.js';
import { createCouriers } from './couriers.js';
import { INDEXES as EXTRAS_INDEXES } from './extras-store.js';
import { INDEXES as FULFILMENT_INDEXES } from './fulfilment-store.js';
import { LEDGER_INDEXES } from './ledger.js';
import { createLists } from './lists.js';
import { INDEXES as ORDERS_INDEXES } from './orders-store.js';
import { INDEXES as PROMOTIONS_INDEXES } from './promotions-store.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	catalog: catalogSettings,
	variants: variantsSettings,
	multi_location: multiLocationSettings,
	grades_serials: gradesSerialsSettings,
	digital_goods: digitalGoodsSettings,
	bookings: bookingsSettings,
	checkout: checkoutSettings,
	cod: codSettings,
	delivery_zones: deliveryZonesSettings,
	courier_apis: courierApisSettings,
	taxes: taxesSettings,
	coupons: couponsSettings,
	deals: dealsSettings,
	loyalty: loyaltySettings,
	bundles: bundlesSettings,
	reviews: reviewsSettings,
	wishlist: wishlistSettings,
	alerts: alertsSettings,
	compare: compareSettings,
	returns: returnsSettings,
	invoices: invoicesSettings,
	csv: csvSettings,
	bulk_actions: bulkActionsSettings,
	reports: reportsSettings,
	seo: seoSettings,
	feeds: feedsSettings,
	ai_copy: aiCopySettings,
	llms_txt: llmsTxtSettings,
};

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/** Ecommerce's own problem codes. */
const PROBLEM_CODES = Object.freeze({
	sign_in_required: Object.freeze({ status: 403, title: 'Sign in required' }),
	customer_blocked: Object.freeze({ status: 403, title: 'Ordering is not possible for this account' }),
	out_of_stock: Object.freeze({ status: 409, title: 'Out of stock' }),
	offer_unavailable: Object.freeze({ status: 409, title: 'Offer no longer available' }),
	points_changed: Object.freeze({ status: 409, title: 'Loyalty balance changed' }),
	coupon_code_taken: Object.freeze({ status: 409, title: 'Coupon code already in use' }),
	coupon_unknown: Object.freeze({ status: 422, title: 'Unknown coupon code' }),
	coupon_inactive: Object.freeze({ status: 422, title: 'Coupon not active' }),
	coupon_not_started: Object.freeze({ status: 422, title: 'Coupon not valid yet' }),
	coupon_expired: Object.freeze({ status: 422, title: 'Coupon expired' }),
	coupon_used_up: Object.freeze({ status: 422, title: 'Coupon used up' }),
	coupon_first_order: Object.freeze({ status: 422, title: 'Coupon for a first order only' }),
	coupon_per_customer: Object.freeze({ status: 422, title: 'Coupon already used by this customer' }),
	coupon_min_subtotal: Object.freeze({ status: 422, title: 'Cart below the coupon minimum' }),
	coupon_not_applicable: Object.freeze({ status: 422, title: 'Coupon does not apply to this cart' }),
	slot_taken: Object.freeze({ status: 409, title: 'Slot no longer free' }),
	move_not_allowed: Object.freeze({ status: 409, title: 'Status move not allowed' }),
	too_many_open_orders: Object.freeze({ status: 409, title: 'Too many open orders' }),
	nothing_to_pay: Object.freeze({ status: 409, title: 'Nothing to pay' }),
	download_not_allowed: Object.freeze({ status: 403, title: 'Download not available' }),
	cod_not_allowed: Object.freeze({ status: 422, title: 'Cash on delivery not possible' }),
	not_returnable: Object.freeze({ status: 422, title: 'Not returnable' }),
	review_not_allowed: Object.freeze({ status: 403, title: 'Review not allowed' }),
	already_reviewed: Object.freeze({ status: 409, title: 'Already reviewed' }),
	storage_not_connected: Object.freeze({ status: 503, title: 'Storage not connected' }),
	payments_unavailable: Object.freeze({ status: 503, title: 'Payments unavailable' }),
	payments_refused: Object.freeze({ status: 502, title: 'Payments refused' }),
	courier_failed: Object.freeze({ status: 502, title: 'The courier refused' }),
	ai_not_connected: Object.freeze({ status: 503, title: 'AI provider not connected' }),
	ai_failed: Object.freeze({ status: 502, title: 'The AI provider failed' }),
});

/** Every merchant database index of the shop. */
export const INDEXES = [
	...LEDGER_INDEXES,
	...CATALOG_INDEXES,
	...ORDERS_INDEXES,
	...FULFILMENT_INDEXES,
	...PROMOTIONS_INDEXES,
	...EXTRAS_INDEXES,
];

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes'>} InstanceOptions
 */

/** Used only while the deployable is misconfigured (it then answers 503 everywhere). */
const UNCONFIGURED = '';

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus the list settings, the courier
 * APIs and the AI provider.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
	const healthy = (options.problems ?? []).length === 0;
	const uri = options.config?.mongodbUri ?? UNCONFIGURED;
	// Ecommerce keeps its list settings in the product database too, so it owns the store
	const store =
		options.store ??
		(healthy && uri
			? createMongoStore({ db: new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000 }).db(), now })
			: createMemoryStore({ now }));
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	// the same policy the kit uses for addresses merchants enter
	const policy = createOutboundPolicy({ ...outboundRest, allowHosts: production ? [] : allowHosts });
	/** @type {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
	const couriers = createCouriers({ send });
	const ai = createAi({ send });
	const lists = createLists({ store, now });
	/** @type {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>} */
	const hooks = {};

	const product = createProduct({
		...options,
		store,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		connections: {
			storage: {
				label: 'Storage for product images, downloads and return photos (S3-compatible)',
				kind: 'storage',
				neededBy: ['catalog', 'digital_goods'],
			},
			accounts: {
				label: 'Accounts token (shoppers sign in, activity-log copies)',
				kind: 'token',
				productId: 'accounts',
				neededBy: ['checkout', 'reviews', 'wishlist'],
			},
			payments: {
				label: 'Payments token (online payments and bank transfers at checkout, refunds)',
				kind: 'token',
				productId: 'payments',
				neededBy: [],
			},
			notifications: {
				label: 'Notifications token (order messages and alerts)',
				kind: 'token',
				productId: 'notifications',
				neededBy: ['alerts'],
			},
			courier: {
				label: 'Courier API keys',
				kind: 'secret',
				neededBy: ['courier_apis'],
				secretField: 'apiKey',
				test: (value) => couriers.test(value),
			},
			ai: {
				label: 'AI provider key (AI copy)',
				kind: 'secret',
				neededBy: ['ai_copy'],
				secretField: 'apiKey',
				test: (value) => ai.test(value),
			},
		},
		// api/routes.js fills these in (they need every part of the shop)
		hooks: {
			exportUser: (ctx, user) => /** @type {NonNullable<typeof hooks.exportUser>} */ (hooks.exportUser)(ctx, user),
			deleteUser: (ctx, user) => /** @type {NonNullable<typeof hooks.deleteUser>} */ (hooks.deleteUser)(ctx, user),
			widgetConfig: (ctx) => /** @type {NonNullable<typeof hooks.widgetConfig>} */ (hooks.widgetConfig)(ctx),
		},
		data: { indexes: INDEXES },
	});
	return Object.freeze({
		...product,
		lists,
		couriers,
		ai,
		send,
		now,
		/** Attach the data-rights and widget-config hooks (api/routes.js). @param {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>} attached */
		attach: (attached) => Object.assign(hooks, attached),
	});
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
