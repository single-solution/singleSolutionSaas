/**
 * Ecommerce's routes (the kit adds its own: connect, notices, tickets, permissions, data rights, widget config, `/sso`
 * and the dashboard API). The shop's parts each bring their routes (`server/<part>.js`): catalog, checkout, orders,
 * promotions, extras (returns, reviews, wishlist, alerts, compare, reports) and SEO (with feeds, llms.txt and the Chat
 * lookups). Every browser-token, server-token and ticket route belongs to one feature; `openapi.json` is generated from
 * the definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and `permission` stay string literals.
 * This file adds the public widget script and docs, and joins the parts' data-rights answers and widget settings (the
 * dashboard's list settings are the kit's). Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { gradesByKey } from '../core/grades.js';
import { createCatalog } from './catalog.js';
import { createCheckout } from './checkout.js';
import { createDashboardSearch } from './dashboard-search.js';
import { renderDocs } from './docs.js';
import { createExtras } from './extras.js';
import { createImports } from './imports.js';
import { createOrderDocuments } from './orders-documents.js';
import { createOrderEvents } from './order-events.js';
import { createOrders } from './orders.js';
import { createPromotions } from './promotions.js';
import { createSeo } from './seo.js';
import { createService } from './service.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {{ id?: string, email?: string, phone?: string }} Person who a data-rights request is about */

/**
 * What a part of the shop brings.
 * @typedef {object} Area
 * @property {import('@ss/app-kit').RouteDefinition[]} routes
 * @property {(s: Site, user: Person) => Promise<Record<string, unknown[]>>} [exportUser] the person's records (data rights)
 * @property {(s: Site, user: Person) => Promise<{ deleted: number, anonymised: number }>} [deleteUser] erase or anonymize them
 * @property {(s: Site) => Promise<Record<string, unknown>>} [widgetSettings] settings the visitor widgets need (never secrets)
 */

/**
 * @param {Product} product
 */
export const createRoutes = (product) => {
	const service = createService(product);
	const checkout = createCheckout(product, service);
	const areas = [
		createCatalog(product, service),
		checkout,
		createOrders(product, service, { ordering: checkout.ordering }),
		createOrderEvents(product, service),
		createOrderDocuments(product, service),
		createPromotions(product, service),
		createExtras(product, service),
		createSeo(product, service),
		createImports(product),
	];

	product.attach({
		exportUser: async (ctx, user) => {
			const s = await service.site(ctx);
			/** @type {Record<string, unknown[]>} */
			const records = {};
			for (const area of areas) if (area.exportUser) Object.assign(records, await area.exportUser(s, user));
			return records;
		},
		deleteUser: async (ctx, user) => {
			const s = await service.site(ctx);
			const total = { deleted: 0, anonymised: 0 };
			for (const area of areas)
				if (area.deleteUser) {
					const done = await area.deleteUser(s, user);
					total.deleted += done.deleted;
					total.anonymised += done.anonymised;
				}
			return total;
		},
		widgetConfig: async (ctx) => {
			const s = await service.site(ctx);
			/** @type {Record<string, unknown>} */
			const settings = { currency: s.currency };
			for (const area of areas) if (area.widgetSettings) Object.assign(settings, await area.widgetSettings(s));
			// the merchant's order statuses (with their kind of step), couriers, payment methods and grades (names only),
			// for the admin
			// widgets' pickers
			if (s.has('checkout')) {
				const flow = /** @type {import('../core/model.js').OrderFlow} */ (
					/** @type {unknown} */ (await s.list('order_flow'))
				);
				const couriers = await s.list('couriers');
				const methods = /** @type {import('../core/payment-methods.js').PaymentMethodRecord[]} */ (
					await s.list('payment_methods')
				);
				settings.orders = {
					statuses: flow.statuses.map((/** @type {any} */ status) => ({
						key: status.key,
						label: status.label,
						role: status.role,
					})),
					couriers: couriers.map((/** @type {any} */ courier) => ({ key: courier.key, name: courier.name })),
					// the merchant's payment methods (names for orders, staff recording money against them, E16)
					paymentMethods: methods.map((method) => ({ key: method.key, name: method.name, kind: method.kind })),
				};
			}
			if (s.has('grades_serials')) {
				// one entry per key for the pickers: the one for every category first (E45)
				const grades = [...gradesByKey(await s.list('grades')).values()].map((/** @type {any} */ grade) => ({
					key: grade.key,
					label: grade.label,
					color: grade.color,
					active: grade.active,
					categoryIds: grade.categoryIds,
					typeKeys: grade.typeKeys,
				}));
				settings.catalog = { .../** @type {object} */ (settings.catalog ?? {}), grades };
			}
			return settings;
		},
	});

	return [
		...areas.flatMap((area) => area.routes),

		// the widgets' script: public and the same for every website (no token, no Origin needed)
		defineRoute({
			method: 'GET',
			path: '/widget.js',
			auth: 'none',
			handler: () =>
				new Response(WIDGET_SCRIPT, {
					headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),

		// the Atlas Search index state on Overview (E14)
		...createDashboardSearch(product),

		// public docs: no sign-in, no tokens
		defineRoute({
			method: 'GET',
			path: '/docs',
			auth: 'none',
			handler: (ctx) =>
				new Response(renderDocs({ base: product.address() ?? new URL(ctx.request.url).origin }), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
	];
};
