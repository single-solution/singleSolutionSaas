/**
 * Ecommerce's routes (the kit adds its own: connect, notices, tickets, permissions, data rights, widget config, `/sso`
 * and the dashboard API). The shop's parts each bring their routes (`server/<part>.js`): catalog, checkout, orders,
 * promotions, extras (returns, reviews, wishlist, alerts, compare, reports) and SEO (with feeds, llms.txt and the Chat
 * lookups). Every browser-token, server-token and ticket route belongs to one feature; `openapi.json` is generated from
 * the definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and `permission` stay string literals.
 * This file adds the public widget script and docs, the dashboard's list settings, and joins the parts' data-rights
 * answers and widget settings. Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { LISTS, isListName } from '../adapters/lists.js';
import { createCatalog } from './catalog.js';
import { createCheckout } from './checkout.js';
import { renderDocs } from './docs.js';
import { createExtras } from './extras.js';
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
 * @property {(s: Site, user: Person) => Promise<{ deleted: number, anonymised: number }>} [deleteUser] erase or anonymise them
 * @property {(s: Site) => Promise<Record<string, unknown>>} [widgetSettings] settings the visitor widgets need (never secrets)
 */

/**
 * @param {Product} product
 */
export const createRoutes = (product) => {
	const service = createService(product);
	const areas = [
		createCatalog(product, service),
		createCheckout(product, service),
		createOrders(product, service),
		createPromotions(product, service),
		createExtras(product, service),
		createSeo(product, service),
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
			// the merchant's order statuses, couriers and grades (names only), for the admin widgets' pickers
			if (s.has('checkout')) {
				const flow = /** @type {import('../core/model.js').OrderFlow} */ (
					/** @type {unknown} */ (await s.list('order_flow'))
				);
				const couriers = await s.list('couriers');
				settings.orders = {
					statuses: flow.statuses.map((/** @type {any} */ status) => ({ key: status.key, label: status.label })),
					couriers: couriers.map((/** @type {any} */ courier) => ({ key: courier.key, name: courier.name })),
				};
			}
			if (s.has('grades_serials')) {
				const grades = (await s.list('grades')).map((/** @type {any} */ grade) => ({ key: grade.key, label: grade.label }));
				settings.catalog = { .../** @type {object} */ (settings.catalog ?? {}), grades };
			}
			return settings;
		},
	});

	/** @param {any} ctx */
	const listName = (ctx) => {
		const name = ctx.params.list;
		if (!isListName(name)) throw problem('not_found', 'There is no such list.');
		return name;
	};

	/** @param {any} ctx */
	const who = (ctx) => ({
		kind: ctx.session.kind,
		id: ctx.session.subject,
		name: ctx.session.name,
		...(ctx.session.role ? { role: ctx.session.role } : {}),
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

		// the dashboard's list settings (order flow, couriers, delivery zones, tax rules, grades, booking hours)
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/lists/:list',
			auth: 'dashboard',
			handler: async (ctx) => ({ value: await product.lists.get(String(ctx.params.websiteId), listName(ctx)) }),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/lists/:list',
			auth: 'dashboard',
			handler: async (ctx) => {
				const name = listName(ctx);
				const websiteId = String(ctx.params.websiteId);
				// merchants edit the settings of switched-on features only (admins may prepare them)
				if (ctx.session.kind === 'merchant' && !(await product.featuresOn(websiteId)).includes(LISTS[name].feature))
					throw problem('feature_off', 'This feature is off.');
				const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
				const saved = await product.lists.save(websiteId, name, /** @type {any} */ (body).value);
				if (!saved.ok)
					throw problem('validation_failed', saved.errors.join(' '), {
						errors: saved.errors.map((message) => ({ path: '/value', message, code: 'invalid' })),
					});
				await product.recentChanges.record({
					websiteId,
					who: who(ctx),
					what: 'settings',
					detail: `${LISTS[name].title}: changed`,
				});
				return { value: saved.value };
			},
		}),

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
