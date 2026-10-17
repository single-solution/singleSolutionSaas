/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Ecommerce's
 * manifest (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (storage, the
 * Accounts, Payments, Notifications and Growth tokens, courier keys and the AI key), the merchant database indexes of every
 * part, the data-rights and widget-config hooks (filled in by `server/routes.js`), the Owner's Re-seal of the deal-lock
 * secrets (sealed with `ENCRYPTION_KEY`, RT-14), the messages it sends through Notifications with their US-English
 * default words (`schemas/messages.json`, parity P1) and its part of the website Setup sheet (the OpenAPI document, the
 * guide's "What your website builds" per feature, its event types, its lists in its own words and the pages, routes
 * and SEO tags of the merchant's website: `core/setup-sheet.js`), and adds the list settings (product database; also
 * served to the merchant's server by the kit's `GET|PUT /v1/lists/:list`, PLAN 0.8.10 K1), the courier APIs and the AI
 * provider on the same outbound policy. The Next.js route and the tests pass the rest (config, store,
 * clock, network). Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct, createProductBase } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import manifestFile from '../manifest.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import catalogSettings from '../schemas/catalog.settings.json' with { type: 'json' };
import variantsSettings from '../schemas/variants.settings.json' with { type: 'json' };
import sizeChartsSettings from '../schemas/size_charts.settings.json' with { type: 'json' };
import multiLocationSettings from '../schemas/multi_location.settings.json' with { type: 'json' };
import gradesSerialsSettings from '../schemas/grades_serials.settings.json' with { type: 'json' };
import digitalGoodsSettings from '../schemas/digital_goods.settings.json' with { type: 'json' };
import bookingsSettings from '../schemas/bookings.settings.json' with { type: 'json' };
import measuredSalesSettings from '../schemas/measured_sales.settings.json' with { type: 'json' };
import checkoutSettings from '../schemas/checkout.settings.json' with { type: 'json' };
import deliveryZonesSettings from '../schemas/delivery_zones.settings.json' with { type: 'json' };
import courierApisSettings from '../schemas/courier_apis.settings.json' with { type: 'json' };
import taxesSettings from '../schemas/taxes.settings.json' with { type: 'json' };
import couponsSettings from '../schemas/coupons.settings.json' with { type: 'json' };
import dealsSettings from '../schemas/deals.settings.json' with { type: 'json' };
import loyaltySettings from '../schemas/loyalty.settings.json' with { type: 'json' };
import bundlesSettings from '../schemas/bundles.settings.json' with { type: 'json' };
import reviewsSettings from '../schemas/reviews.settings.json' with { type: 'json' };
import storeDetailsSettings from '../schemas/store_details.settings.json' with { type: 'json' };
import wishlistSettings from '../schemas/wishlist.settings.json' with { type: 'json' };
import rolePricingSettings from '../schemas/role_pricing.settings.json' with { type: 'json' };
import eventsSettings from '../schemas/events.settings.json' with { type: 'json' };
import staffAlertsSettings from '../schemas/staff_alerts.settings.json' with { type: 'json' };
import alertsSettings from '../schemas/alerts.settings.json' with { type: 'json' };
import compareSettings from '../schemas/compare.settings.json' with { type: 'json' };
import returnsSettings from '../schemas/returns.settings.json' with { type: 'json' };
import invoicesSettings from '../schemas/invoices.settings.json' with { type: 'json' };
import csvSettings from '../schemas/csv.settings.json' with { type: 'json' };
import bulkActionsSettings from '../schemas/bulk_actions.settings.json' with { type: 'json' };
import reportsSettings from '../schemas/reports.settings.json' with { type: 'json' };
import seoSettings from '../schemas/seo.settings.json' with { type: 'json' };
import landingPagesSettings from '../schemas/landing_pages.settings.json' with { type: 'json' };
import feedsSettings from '../schemas/feeds.settings.json' with { type: 'json' };
import aiCopySettings from '../schemas/ai_copy.settings.json' with { type: 'json' };
import llmsTxtSettings from '../schemas/llms_txt.settings.json' with { type: 'json' };
import importSettings from '../schemas/import.settings.json' with { type: 'json' };
import messages from '../schemas/messages.json' with { type: 'json' };
import { flowChangeProblems } from '../core/flow.js';
import { typeChangeProblems } from '../core/item-types.js';
import { COLLECTIONS } from '../core/model.js';
import { claimStatusProblems } from '../core/returns.js';
import { EVENT_TYPES } from '../core/events.js';
import { LIST_WORDS, setupSummaries } from '../core/setup-sheet.js';
import { createAi } from './ai.js';
import { INDEXES as CATALOG_INDEXES, typeUses } from './catalog-store.js';
import { createCouriers } from './couriers.js';
import { COURIER_CONNECTIONS } from '../core/couriers.js';
import { INDEXES as EXTRAS_INDEXES } from './extras-store.js';
import { INDEXES as FULFILLMENT_INDEXES } from './fulfillment-store.js';
import { createImportOptions } from './imports.js';
import { LEDGER_INDEXES } from './ledger.js';
import { LISTS, createLists } from './lists.js';
import { INDEXES as ORDERS_INDEXES, createOrdersStore } from './orders-store.js';
import { INDEXES as OUTBOX_INDEXES } from './outbox.js';
import { INDEXES as PROMOTIONS_INDEXES } from './promotions-store.js';
import { createSearchState } from './search-state.js';
import { createSealer, createSiteSecrets } from './site-secret.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	store_details: storeDetailsSettings,
	catalog: catalogSettings,
	variants: variantsSettings,
	size_charts: sizeChartsSettings,
	multi_location: multiLocationSettings,
	grades_serials: gradesSerialsSettings,
	digital_goods: digitalGoodsSettings,
	bookings: bookingsSettings,
	measured_sales: measuredSalesSettings,
	checkout: checkoutSettings,
	delivery_zones: deliveryZonesSettings,
	courier_apis: courierApisSettings,
	taxes: taxesSettings,
	coupons: couponsSettings,
	deals: dealsSettings,
	loyalty: loyaltySettings,
	role_pricing: rolePricingSettings,
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
	events: eventsSettings,
	staff_alerts: staffAlertsSettings,
	seo: seoSettings,
	landing_pages: landingPagesSettings,
	feeds: feedsSettings,
	ai_copy: aiCopySettings,
	llms_txt: llmsTxtSettings,
	import: importSettings,
};

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/**
 * The `seo` settings as the schema gives them: what a shop's pages follow while the SEO feature is off (baseline SEO
 * with the catalog; the merchant's own settings are the SEO product's).
 * @type {Readonly<Record<string, any>>}
 */
export const SEO_DEFAULTS = Object.freeze(
	Object.fromEntries(Object.entries(seoSettings.properties).map(([key, node]) => [key, node.default])),
);

/** Ecommerce's own problem codes. */
const PROBLEM_CODES = Object.freeze({
	sign_in_required: Object.freeze({ status: 403, title: 'Sign in required' }),
	customer_blocked: Object.freeze({ status: 403, title: 'Ordering is not possible for this account' }),
	out_of_stock: Object.freeze({ status: 409, title: 'Out of stock' }),
	offer_unavailable: Object.freeze({ status: 409, title: 'Offer no longer available' }),
	points_changed: Object.freeze({ status: 409, title: 'Loyalty balance changed' }),
	price_changed: Object.freeze({ status: 409, title: 'Total changed' }),
	coupon_code_taken: Object.freeze({ status: 409, title: 'Coupon code already in use' }),
	slug_taken: Object.freeze({ status: 409, title: 'Slug already in use' }),
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
	flow_changed: Object.freeze({ status: 409, title: 'The order flow changed' }),
	too_many_open_orders: Object.freeze({ status: 409, title: 'Too many open orders' }),
	too_many_orders: Object.freeze({ status: 429, title: 'Too many orders' }),
	nothing_to_pay: Object.freeze({ status: 409, title: 'Nothing to pay' }),
	nothing_paid: Object.freeze({ status: 409, title: 'Nothing was paid' }),
	download_not_allowed: Object.freeze({ status: 403, title: 'Download not available' }),
	payment_not_allowed: Object.freeze({ status: 422, title: 'Payment method not possible for this order' }),
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
	...FULFILLMENT_INDEXES,
	...PROMOTIONS_INDEXES,
	...EXTRAS_INDEXES,
	...OUTBOX_INDEXES,
];

/**
 * What the Next.js route and the tests pass: every option but those the adapter sets itself.
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data'
 *   | 'problemCodes' | 'messages' | 'imports' | 'events' | 'lists' | 'openapi' | 'build'>} InstanceOptions
 */

/** The fallback key a misconfigured product builds its sealer with (it answers 503 everywhere anyway). */
const UNCONFIGURED_KEY = 'unconfigured-ecommerce-encryption-key-00000';

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus the list settings, the courier
 * APIs and the AI provider.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	const healthy = (options.problems ?? []).length === 0;
	// the kit's store and outbound send: Ecommerce keeps its list settings in the product database too, so the kit and the
	// product share one store
	const { store, send } = createProductBase(options);
	const couriers = createCouriers({ send });
	const ai = createAi({ send });
	/** The kit's product, once made (the order flow's guard reads the merchant database through it). @type {ReturnType<typeof createProduct> | null} */
	let kitProduct = null;
	const lists = createLists({
		store,
		now,
		guards: {
			// a status that has orders keeps its key and kind of step (the order engine's facts follow them)
			order_flow: async (websiteId, saved, next) => {
				if (!kitProduct || (await kitProduct.connections.value(websiteId, 'database')) === null) return [];
				const counts = await createOrdersStore(await kitProduct.data.forWebsite(websiteId)).statusCounts();
				return flowChangeProblems(saved, next, counts);
			},
			// a claim status that has claims keeps its key and role (E18)
			claim_statuses: async (websiteId, _saved, next) => {
				if (!kitProduct || (await kitProduct.connections.value(websiteId, 'database')) === null) return [];
				const data = await kitProduct.data.forWebsite(websiteId);
				const used = await data
					.collection(COLLECTIONS.returns)
					.aggregate([{ $match: { websiteId } }, { $group: { _id: { status: '$status', role: '$role' } } }])
					.toArray();
				return claimStatusProblems(
					next,
					used.map((row) => ({ status: String(row._id?.status ?? ''), role: String(row._id?.role ?? '') })),
				);
			},
			// item types name existing fields of the right kind, and keep what products, categories and units in stock
			// rely on (a used type stays with its kind; a type with units in stock keeps its units' fields; a type whose items
			// have stock keeps its unit of measure)
			item_types: async (websiteId, saved, next) => {
				if (!kitProduct || (await kitProduct.connections.value(websiteId, 'database')) === null) return [];
				return typeChangeProblems(saved, next, await typeUses(await kitProduct.data.forWebsite(websiteId), saved, next));
			},
		},
	});
	const searchState = createSearchState({ store, now });
	const keys = healthy ? options.config : undefined;
	const sealer = createSealer(keys?.encryptionKey || UNCONFIGURED_KEY, keys?.previousEncryptionKey ?? null);
	const secrets = createSiteSecrets({ store, sealer, now });
	/** @type {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>} */
	const hooks = {};

	/**
	 * Ecommerce's own part of the website Setup sheet: its event types while Events is on, the lists of the features that
	 * are on in its own words (a list that cannot be read is left out, so the kit shows its own count) and its summaries
	 * of the merchant's pages, what they serve from their own domain and their SEO tags. Never an address of a list or a
	 * secret.
	 * @param {{ websiteId: string, on: string[] }} website
	 */
	const setupPart = async ({ websiteId, on }) => {
		const names = /** @type {Array<keyof typeof LISTS>} */ (Object.keys(LISTS)).filter((name) =>
			on.includes(LISTS[name].feature),
		);
		const worded = await Promise.all(
			names.map(async (name) => {
				try {
					return /** @type {[string, string]} */ ([name, LIST_WORDS[name](await lists.get(websiteId, name))]);
				} catch {
					return null;
				}
			}),
		);
		/** @param {string} feature */
		const valuesOf = (feature) => (on.includes(feature) ? product.settings.values(websiteId, feature) : null);
		const [catalog, seo, landing, alerts, llms] = await Promise.all([
			valuesOf('catalog'),
			// the seo settings the pages follow while Catalog is on: the merchant's while SEO is on, else the defaults
			on.includes('catalog') && !on.includes('seo') ? SEO_DEFAULTS : valuesOf('seo'),
			valuesOf('landing_pages'),
			valuesOf('alerts'),
			valuesOf('llms_txt'),
		]);
		return {
			events: on.includes('events') ? EVENT_TYPES.map((type) => `${manifest.id}.${type}`) : [],
			lists: Object.fromEntries(worded.filter((entry) => entry !== null)),
			summaries: setupSummaries({ on, catalog, seo, landing, alerts, llms }),
		};
	};

	const product = createProduct({
		...options,
		store,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		// order, claim and stock messages and staff alerts with their default words: every send to Notifications carries
		// them (parity P1)
		messages,
		connections: {
			storage: {
				label: 'Storage for product images, downloads and return photos (S3-compatible)',
				kind: 'storage',
				neededBy: ['catalog', 'digital_goods', 'store_details'],
			},
			accounts: {
				label: 'Accounts token (shoppers sign in, activity-log copies)',
				kind: 'token',
				productId: 'accounts',
				neededBy: ['checkout', 'reviews', 'wishlist', 'role_pricing'],
			},
			payments: {
				label: 'Payments token (online payments and bank transfers at checkout, refunds)',
				kind: 'token',
				productId: 'payments',
				neededBy: [],
			},
			notifications: {
				label: 'Notifications token (order messages, alerts, staff alerts and event webhooks)',
				kind: 'token',
				productId: 'notifications',
				neededBy: ['alerts', 'staff_alerts'],
			},
			growth: {
				label: 'Growth token (send changed addresses to IndexNow; check tag ids in Shop health)',
				kind: 'token',
				productId: 'growth',
				neededBy: [],
			},
			// one courier API per courier the merchant books with, named by its entry of the couriers list (E25): the
			// feature needs the first; the others are there for more
			...Object.fromEntries(
				COURIER_CONNECTIONS.map((name, index) => [
					name,
					{
						label: `Courier API keys ${index + 1}`,
						kind: /** @type {const} */ ('secret'),
						neededBy: index === 0 ? ['courier_apis'] : [],
						secretField: 'apiKey',
						test: (/** @type {unknown} */ value) => couriers.test(value),
					},
				]),
			),
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
			// the Owner's Re-seal (RT-14): the deal-lock secrets in the product database
			resealProduct: () => secrets.reseal(),
			// its part of the website Setup sheet in its own words (events, lists, pages, routes, SEO tags); never secrets
			blueprint: (website) => setupPart(website),
		},
		data: { indexes: INDEXES },
		// the website Setup sheet: the API document and what the merchant's website builds per feature
		openapi,
		build: guide.build,
		// records moved in from another system with ss-import (feature `import`, PLAN 0.8.10 K10)
		imports: createImportOptions({
			list: (websiteId, name) => lists.get(websiteId, /** @type {any} */ (name)),
			settings: (websiteId, feature) => product.settings.values(websiteId, feature),
			featuresOn: (websiteId) => product.featuresOn(websiteId),
			now,
		}),
		// order, return, review, catalog and stock events (PLAN 0.8.10 K5, E32)
		events: true,
		// the list settings for the merchant's server (`GET|PUT /v1/lists/:list`, server token)
		lists: Object.fromEntries(
			/** @type {Array<keyof typeof LISTS>} */ (Object.keys(LISTS)).map((name) => [
				name,
				{
					feature: LISTS[name].feature,
					title: LISTS[name].title,
					get: (/** @type {string} */ websiteId) => lists.get(websiteId, name),
					save: (/** @type {string} */ websiteId, /** @type {unknown} */ value) => lists.save(websiteId, name, value),
				},
			]),
		),
	});
	kitProduct = product;
	return Object.freeze({
		...product,
		lists,
		searchState,
		secrets,
		couriers,
		ai,
		send,
		now,
		/** Attach the data-rights and widget-config hooks (api/routes.js). @param {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>} attached */
		attach: (attached) => Object.assign(hooks, attached),
	});
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
