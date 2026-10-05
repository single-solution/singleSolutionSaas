/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Order Manager API, the
 * element views of the Loader's element stub and the dashboard API (SSO sessions).
 *
 * Keys (security): only `sk_` keys (the merchant's servers) and dashboard sessions read or change orders. Browsers
 * (`pk_` keys) read only public metadata (statuses, carriers), look up tracking by order number + contact, and — with a
 * verified `SS-Identity` from the website's own login — read and cancel the customer's own orders and print their
 * receipts. Every route is gated by its element (403 element_disabled in every mode); POSTs that create or move state
 * require an Idempotency-Key.
 */
import { defineRoute, ok, created, paginate, problem, standardRoutes } from '@ss/app-kit';
import { summarize } from '../core/ledger.js';
import { isRevenue, nextStatuses } from '../core/lifecycle.js';
import { customerKeys, ownerView } from '../core/orders.js';
import { customerSummary, customerView, trackingOf } from '../core/views.js';
import { cleanText, idList, isId } from '../core/text.js';
import { repositoriesFor } from '../adapters/db.js';
import { createMessenger } from '../adapters/messaging.js';
import { createBulk, filterOf, MAX_CSV_CHARS } from './bulk.js';
import { labelsFor } from './context.js';
import { createDashboardApi, HTML_VIEW_HEADERS } from './dashboard.js';
import { createDocuments } from './documents.js';
import { createEventHandlers } from './events.js';
import { createIntake } from './intake.js';
import { createLedger } from './ledger.js';
import { createLifecycle } from './lifecycle.js';
import { createNotifier } from './notify.js';
import { createOutbox } from './outbox.js';
import { createBlocklist, entryView } from './risk.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').OrdersApp} OrdersApp */
/** @typedef {import('./context.js').Site} Site */

/** Work per website and sweep run. */
const SWEEP_BATCH = 200;

/** Headers of the printable HTML views: no script can run, nothing is cached. */
export const HTML_HEADERS = HTML_VIEW_HEADERS;

/**
 * A service failure as an RFC 9457 problem.
 * @param {any} result a service failure (`ok: false`)
 */
export const failure = (result) =>
	problem(result.reason, result.detail ?? result.reason.replace(/_/g, ' '), {
		...(result.errors
			? { errors: result.errors.map((/** @type {any} */ e) => ({ ...e, message: e.code.replace(/_/g, ' ') })) }
			: {}),
		...(result.extensions ? { extensions: result.extensions } : {}),
	});

/**
 * The application (services + site resolution) shared by the routes, the event consumers, the job and the dashboard.
 * @param {OrdersApp} app
 */
export const createOrders = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	/** @type {import('./context.js').Deps} */
	const deps = {
		publish: (event) => product.portal.publishEvent(event),
		usage: (record) => product.usage.record(record),
		audit: (entry) => product.audit.record(entry),
		send: createMessenger(product),
		newId: app.newId,
		stableId: app.stableId,
		hashKey: app.hashKey,
		now: app.now,
		strings: app.strings,
		log: product.context?.logger ?? undefined,
	};
	const notifier = createNotifier(deps);
	const outbox = createOutbox(deps, notifier);
	const lifecycle = createLifecycle(deps, outbox);
	const ledger = createLedger(deps, outbox, lifecycle);
	const intake = createIntake(deps, outbox);
	const documents = createDocuments(deps);
	const bulk = createBulk(lifecycle);
	const blocklist = createBlocklist(deps);

	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => {
		await app.registry.remember(websiteId);
		return {
			websiteId,
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
		};
	};
	/**
	 * Site of a website from its entitlement (null without an active subscription or with the lifecycle off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'lifecycle')) return null;
		return siteOf(websiteId, result.doc);
	};
	/**
	 * Sweep one website: auto-expiry, the order outbox, message retries.
	 * @param {Site} site
	 */
	const sweepSite = async (site) => ({
		expired: await lifecycle.expireDue(site, SWEEP_BATCH),
		redelivered: await outbox.retry(site, SWEEP_BATCH),
		messages: site.settings.enabled('customer_updates') ? await notifier.retryDue(site, SWEEP_BATCH) : 0,
	});
	return {
		app,
		product,
		deps,
		notifier,
		outbox,
		lifecycle,
		ledger,
		intake,
		documents,
		bulk,
		blocklist,
		siteOf,
		siteFor,
		sweepSite,
	};
};

/** @typedef {ReturnType<typeof createOrders>} Orders */

/**
 * The owner's view of an order (sk_ keys and the dashboard).
 * @param {Site} site
 * @param {Record<string, any>} order
 * @param {string} [actor]
 */
export const ownerOrder = (site, order, actor = 'api') => ({
	...ownerView(order),
	revenue: isRevenue(site.settings.matrix, order.status),
	money: summarize(order),
	next: nextStatuses(site.settings.matrix, order.status, actor),
});

/** @param {Record<string, any>} order */
const keyOf = (order) => [new Date(order.placedAt).toISOString(), order.id];

/**
 * @param {Orders} orders
 */
export const buildRoutes = (orders) => {
	const { product, lifecycle, ledger, intake, documents, bulk, blocklist, notifier, siteOf } = orders;
	const deps = orders.deps;
	/** @param {any} ctx @returns {import('./context.js').Actor} */
	const apiActor = (ctx) => ({ type: 'api', id: ctx.website?.keyId ?? null });

	/**
	 * A website-key route gated by its element.
	 * @param {{ method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, element: string, sk?: boolean,
	 *   identity?: 'required', idempotent?: boolean | 'optional', maxBodyBytes?: number, rateLimit?: any,
	 *   handler: (ctx: any, site: Site) => Promise<any> }} spec
	 */
	const route = ({ method, path, element, sk = true, identity, idempotent, maxBodyBytes, rateLimit, handler }) =>
		defineRoute({
			method,
			path,
			auth: 'website',
			element,
			...(sk ? { keyKind: /** @type {const} */ ('sk') } : {}),
			...(identity ? { identity } : {}),
			...(idempotent === undefined ? {} : { idempotent }),
			...(maxBodyBytes ? { maxBodyBytes } : {}),
			...(rateLimit ? { rateLimit } : {}),
			handler: async (ctx) => handler(ctx, await siteOf(ctx.websiteId, ctx.entitlement.doc)),
		});

	/**
	 * A rate limit from a feature (per website).
	 * @param {string} element
	 * @param {string} feature
	 * @param {number} fallback
	 */
	const rate = (element, feature, fallback) => ({
		windowMs: 60_000,
		bucket: `orders-${element}-${feature}`,
		key: (/** @type {any} */ ctx) => `w:${ctx.websiteId}`,
		limit: (/** @type {any} */ ctx) => {
			const value = (product.entitlements.config(ctx.entitlement?.doc, element) ?? {})[feature];
			return Number.isSafeInteger(value) ? value : fallback;
		},
	});

	/** @param {any} ctx @param {Site} site */
	const getOrder = async (ctx, site) => (isId(ctx.params.id) ? site.repos.orders.get(ctx.params.id) : null);
	const notFound = () => problem('not_found', 'No such order.');

	/** @param {any} ctx @param {Site} site */
	const customerOrder = async (ctx, site) => {
		const order = await getOrder(ctx, site);
		return order && lifecycle.belongs(site, order, ctx.identity) ? order : null;
	};

	/**
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 */
	const customerCtx = (site, order) => {
		const labels = labelsFor(deps, site, order.lang);
		return {
			statusLabel: labels.statusLabel,
			methodLabel: labels.methodLabel,
			showTracking: site.settings.enabled('fulfilment') && site.settings.fulfilment.show_tracking_to_customer,
			showVideo: site.settings.enabled('fulfilment') && site.settings.fulfilment.show_video_to_customer,
			canCancel: lifecycle.cancelMoveFor(site, order) !== null,
		};
	};

	/**
	 * A keyset page of orders.
	 * @param {any} ctx
	 * @param {Site} site
	 * @param {Record<string, unknown>} filter
	 * @param {(order: Record<string, any>) => unknown} view
	 * @param {{ defaultLimit?: number }} [options]
	 */
	const orderPage = async (ctx, site, filter, view, { defaultLimit = 20 } = {}) => {
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
			{ defaultLimit, maxLimit: 100 },
		);
		const items = await site.repos.orders.page(filter, { after: page.after, limit: page.fetchLimit });
		const body = page.page(items, keyOf);
		const link = page.link(body.nextCursor);
		return ok(
			{ ...body, items: body.items.map(view) },
			{ headers: { 'cache-control': 'no-store', ...(link ? { link } : {}) } },
		);
	};

	/**
	 * HTML, or `{ title, html }` with `?format=json` (the headless receipt element).
	 * @param {any} ctx
	 * @param {{ html: string, title: string }} doc
	 */
	const htmlOrJson = (ctx, doc) =>
		ctx.query.format === 'json'
			? ok({ title: doc.title, html: doc.html }, { headers: { 'cache-control': 'no-store' } })
			: new Response(doc.html, { status: 200, headers: HTML_HEADERS });

	/** @param {any} ctx @param {Site} site */
	const printOrders = async (ctx, site) => {
		const ids = idList(ctx.query.ids, site.settings.print.max_orders_per_print);
		if (!ids) return null;
		return site.repos.orders.many(ids);
	};

	const dashboard = createDashboardApi(orders);

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/orders',
			element: 'lifecycle',
			handler: async (ctx, site) => {
				const filter = filterOf(ctx.query);
				if (!filter) return problem('validation_failed', 'Unknown filter value.');
				return orderPage(ctx, site, filter, (order) => ownerOrder(site, order));
			},
		}),
		route({
			method: 'GET',
			path: '/v1/orders/:id',
			element: 'lifecycle',
			handler: async (ctx, site) => {
				const order = await getOrder(ctx, site);
				return order ? ok(ownerOrder(site, order), { headers: { 'cache-control': 'no-store' } }) : notFound();
			},
		}),
		route({
			method: 'POST',
			path: '/v1/orders/:id/transitions',
			element: 'lifecycle',
			handler: async (ctx, site) => {
				if (!isId(ctx.params.id)) return notFound();
				const result = await lifecycle.move(site, ctx.params.id, ctx.body?.status, {
					actor: apiActor(ctx),
					reason: ctx.body?.reason,
					note: ctx.body?.note,
				});
				return result.ok ? ok(ownerOrder(site, result.order)) : failure(result);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/order-statuses',
			element: 'lifecycle',
			sk: false,
			handler: async (_ctx, site) => {
				const labels = labelsFor(deps, site);
				const { matrix } = site.settings;
				return ok(
					{
						items: matrix.statuses.map((s) => ({
							key: s.key,
							label: labels.statusLabel(s.key),
							revenue: s.revenue,
							open: s.open,
							customerCancellable: s.customerCancellable,
							terminal: s.terminal,
							expireAfterHours: s.expireAfterHours,
						})),
						transitions: matrix.transitions.map((t) => ({
							from: t.from,
							to: t.to,
							actors: t.actors,
							requires: t.requires,
						})),
						nextCursor: null,
						hasMore: false,
					},
					{ headers: { 'cache-control': 'public, max-age=60' } },
				);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/my-orders',
			element: 'lifecycle',
			sk: false,
			identity: 'required',
			handler: async (ctx, site) =>
				orderPage(
					ctx,
					site,
					lifecycle.customerFilter(site, ctx.identity),
					(order) => customerSummary(order, customerCtx(site, order)),
					{ defaultLimit: site.settings.lifecycle.customer_page_size },
				),
		}),
		route({
			method: 'GET',
			path: '/v1/my-orders/:id',
			element: 'lifecycle',
			sk: false,
			identity: 'required',
			handler: async (ctx, site) => {
				const order = await customerOrder(ctx, site);
				return order
					? ok(customerView(order, customerCtx(site, order)), { headers: { 'cache-control': 'no-store' } })
					: notFound();
			},
		}),
		route({
			method: 'POST',
			path: '/v1/my-orders/:id/cancel',
			element: 'lifecycle',
			sk: false,
			identity: 'required',
			idempotent: 'optional',
			handler: async (ctx, site) => {
				const order = await customerOrder(ctx, site);
				if (!order) return notFound();
				const result = await lifecycle.cancelByCustomer(site, order, ctx.identity);
				return result.ok ? ok(customerView(result.order, customerCtx(site, result.order))) : failure(result);
			},
		}),

		// ── fulfilment ──────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/carriers',
			element: 'fulfilment',
			sk: false,
			handler: async (_ctx, site) =>
				ok(
					{
						items: site.settings.carriers.map((c) => ({
							key: c.key,
							name: c.name,
							serviceLevels: c.serviceLevels,
							tracking: c.template !== null,
						})),
						nextCursor: null,
						hasMore: false,
					},
					{ headers: { 'cache-control': 'public, max-age=300' } },
				),
		}),
		route({
			method: 'PATCH',
			path: '/v1/orders/:id/fulfilment',
			element: 'fulfilment',
			handler: async (ctx, site) => {
				if (!isId(ctx.params.id)) return notFound();
				const result = await lifecycle.fulfil(site, ctx.params.id, ctx.body, apiActor(ctx));
				return result.ok ? ok(ownerOrder(site, result.order)) : failure(result);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/tracking-lookups',
			element: 'fulfilment',
			sk: false,
			idempotent: false,
			rateLimit: {
				limit: 60,
				windowMs: 60_000,
				bucket: 'orders-tracking',
				key: (/** @type {any} */ ctx) => `w:${ctx.websiteId}`,
			},
			handler: async (ctx, site) => {
				const number = cleanText(ctx.body?.number, 64);
				const contact = cleanText(ctx.body?.contact, 320);
				if (!number || !contact) return problem('validation_failed', 'Give the order number and the e-mail or phone used.');
				const order = await site.repos.orders.byNumber(number);
				const keys = customerKeys(
					{ email: contact.includes('@') ? contact.toLowerCase() : null, phone: contact.includes('@') ? null : contact },
					site.settings.risk.phone_match_digits,
				).map((key) => deps.hashKey(site.websiteId, key));
				// the same answer whether the number or the contact is wrong (no order enumeration)
				if (!order || !keys.some((key) => (order.customerKeys ?? []).includes(key))) return notFound();
				const view = customerView(order, customerCtx(site, order));
				return ok(
					{
						number: view.number,
						status: view.status,
						statusLabel: view.statusLabel,
						placedAt: view.placedAt,
						tracking: trackingOf(order, customerCtx(site, order)),
						timeline: view.timeline,
					},
					{ headers: { 'cache-control': 'no-store' } },
				);
			},
		}),

		// ── serials ─────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'PUT',
			path: '/v1/orders/:id/serials',
			element: 'serials',
			handler: async (ctx, site) => {
				if (!isId(ctx.params.id)) return notFound();
				const result = await lifecycle.setSerials(site, ctx.params.id, ctx.body, apiActor(ctx));
				return result.ok ? ok(ownerOrder(site, result.order)) : failure(result);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/serials',
			element: 'serials',
			handler: async (ctx, site) => {
				const serial = cleanText(ctx.query.serial, 128);
				const found = serial ? await site.repos.orders.bySerial(serial) : [];
				return ok(
					{
						items: found.flatMap((/** @type {any} */ order) =>
							order.lines
								.filter((/** @type {any} */ line) => (line.serials ?? []).includes(serial))
								.map((/** @type {any} */ line) => ({
									serial,
									orderId: order.id,
									number: order.number,
									status: order.status,
									lineId: line.id,
									title: line.title,
									sku: line.sku,
									placedAt: new Date(order.placedAt).toISOString(),
								})),
						),
						nextCursor: null,
						hasMore: false,
					},
					{ headers: { 'cache-control': 'no-store' } },
				);
			},
		}),

		// ── invoices ────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/invoices',
			element: 'invoices',
			handler: async (ctx, site) =>
				orderPage(ctx, site, { invoiceNumber: { $type: 'string' } }, (order) => ({
					orderId: order.id,
					number: order.number,
					invoiceNumber: order.invoiceNumber,
					placedAt: new Date(order.placedAt).toISOString(),
					currency: order.currency,
					total: order.amounts.total,
				})),
		}),
		route({
			method: 'GET',
			path: '/v1/orders/:id/invoice',
			element: 'invoices',
			rateLimit: rate('invoices', 'renders_per_minute', 120),
			handler: async (ctx, site) => {
				const order = await getOrder(ctx, site);
				if (!order) return notFound();
				return htmlOrJson(ctx, await documents.invoice(site, order, ctx.query.kind === 'internal' ? 'internal' : 'customer'));
			},
		}),
		route({
			method: 'GET',
			path: '/v1/my-orders/:id/receipt',
			element: 'invoices',
			sk: false,
			identity: 'required',
			rateLimit: rate('invoices', 'renders_per_minute', 120),
			handler: async (ctx, site) => {
				const order = await customerOrder(ctx, site);
				if (!order) return notFound();
				return htmlOrJson(ctx, await documents.invoice(site, order, 'customer'));
			},
		}),

		// ── print ───────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/packing-slips',
			element: 'print',
			handler: async (ctx, site) => {
				const list = await printOrders(ctx, site);
				if (!list) return problem('validation_failed', 'Pass ?ids= with 1 to print.max_orders_per_print order ids.');
				return new Response(documents.packingSlips(site, list), { status: 200, headers: HTML_HEADERS });
			},
		}),
		route({
			method: 'GET',
			path: '/v1/pick-lists',
			element: 'print',
			handler: async (ctx, site) => {
				const list = await printOrders(ctx, site);
				if (!list) return problem('validation_failed', 'Pass ?ids= with 1 to print.max_orders_per_print order ids.');
				return new Response(documents.pickList(site, list), { status: 200, headers: HTML_HEADERS });
			},
		}),

		// ── bulk ────────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'POST',
			path: '/v1/order-batches',
			element: 'bulk',
			handler: async (ctx, site) => {
				const result = await bulk.batch(site, ctx.body, apiActor(ctx));
				return result.ok ? ok(result.report) : failure(result);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/order-exports',
			element: 'bulk',
			handler: async (ctx, site) => {
				const result = await bulk.exportCsv(site, ctx.query);
				if (!result.ok) return failure(result);
				return new Response(result.csv, {
					status: 200,
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': 'attachment; filename="orders.csv"',
						'cache-control': 'no-store',
						'x-ss-rows': String(result.count),
					},
				});
			},
		}),
		route({
			method: 'POST',
			path: '/v1/order-imports',
			element: 'bulk',
			maxBodyBytes: MAX_CSV_CHARS * 2,
			handler: async (ctx, site) => {
				const result = await bulk.importCsv(site, ctx.body, apiActor(ctx));
				return result.ok ? ok(result.report) : failure(result);
			},
		}),

		// ── risk ────────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'POST',
			path: '/v1/risk-checks',
			element: 'risk',
			idempotent: 'optional',
			handler: async (ctx, site) => {
				const result = await intake.check(site, ctx.body);
				return result.ok ? ok(result.result) : failure(result);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/blocklist',
			element: 'risk',
			handler: async (ctx, site) => {
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 50, maxLimit: 100 },
				);
				const items = await site.repos.profiles.blocked({ after: page.after, limit: page.fetchLimit });
				const body = page.page(items, (p) => p.key);
				return ok({ ...body, items: body.items.map(entryView) }, { headers: { 'cache-control': 'no-store' } });
			},
		}),
		route({
			method: 'POST',
			path: '/v1/blocklist',
			element: 'risk',
			handler: async (ctx, site) => {
				const result = await blocklist.block(site, ctx.body, apiActor(ctx));
				return result.ok ? created(result.entry) : failure(result);
			},
		}),
		route({
			method: 'DELETE',
			path: '/v1/blocklist/:key',
			element: 'risk',
			handler: async (ctx, site) => {
				const result = await blocklist.unblock(site, String(ctx.params.key), apiActor(ctx));
				return result.ok ? ok({ key: ctx.params.key, blocked: false }) : failure(result);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/risk-reviews',
			element: 'risk',
			handler: async (ctx, site) => orderPage(ctx, site, { 'risk.review': 'pending' }, (order) => ownerOrder(site, order)),
		}),
		route({
			method: 'POST',
			path: '/v1/orders/:id/review',
			element: 'risk',
			handler: async (ctx, site) => {
				if (!isId(ctx.params.id)) return notFound();
				const result = await lifecycle.review(site, ctx.params.id, ctx.body, apiActor(ctx));
				return result.ok ? ok(ownerOrder(site, result.order)) : failure(result);
			},
		}),

		// ── customer updates ────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/customer-updates',
			element: 'customer_updates',
			handler: async (ctx, site) => {
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 50, maxLimit: 100 },
				);
				const filter = isId(ctx.query.orderId) ? { orderId: ctx.query.orderId } : {};
				const items = await site.repos.messages.page(filter, { after: page.after, limit: page.fetchLimit });
				const body = page.page(items, (m) => [new Date(m.createdAt).toISOString(), m.id]);
				return ok(
					{ ...body, items: body.items.map((m) => messageView(m, false)) },
					{ headers: { 'cache-control': 'no-store' } },
				);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/customer-updates/:id',
			element: 'customer_updates',
			handler: async (ctx, site) => {
				const message = isId(ctx.params.id) ? await site.repos.messages.get(ctx.params.id) : null;
				return message
					? ok(messageView(message, true), { headers: { 'cache-control': 'no-store' } })
					: problem('message_not_found', 'No such message.');
			},
		}),
		route({
			method: 'POST',
			path: '/v1/customer-updates/:id/retry',
			element: 'customer_updates',
			handler: async (ctx, site) => {
				const message = isId(ctx.params.id) ? await site.repos.messages.get(ctx.params.id) : null;
				if (!message) return problem('message_not_found', 'No such message.');
				await site.repos.messages.requeue(message.id);
				const state = await notifier.send(site, message.id);
				return ok({ id: message.id, result: state });
			},
		}),

		// ── ledger ──────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/ledger',
			element: 'ledger',
			handler: async (ctx, site) => {
				const result = await ledger.entries(site, ctx.query);
				return result.ok
					? ok(
							{ items: result.items, totals: result.totals, nextCursor: null, hasMore: false },
							{ headers: { 'cache-control': 'no-store' } },
						)
					: failure(result);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/orders/:id/payments',
			element: 'ledger',
			handler: async (ctx, site) => {
				if (!isId(ctx.params.id)) return notFound();
				const result = await ledger.pay(site, ctx.params.id, ctx.body, apiActor(ctx));
				return result.ok ? created({ entry: result.entry, order: ownerOrder(site, result.order) }) : failure(result);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/orders/:id/refunds',
			element: 'ledger',
			handler: async (ctx, site) => {
				if (!isId(ctx.params.id)) return notFound();
				const result = await ledger.refund(site, ctx.params.id, ctx.body, apiActor(ctx));
				return result.ok ? created({ entry: result.entry, order: ownerOrder(site, result.order) }) : failure(result);
			},
		}),

		// ── inbound orders ──────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'POST',
			path: '/v1/inbound-orders',
			element: 'inbound_api',
			rateLimit: rate('inbound_api', 'orders_per_minute', 300),
			handler: async (ctx, site) => {
				const mapping = typeof ctx.query.mapping === 'string' && ctx.query.mapping ? ctx.query.mapping : null;
				const result = await intake.take(site, ctx.body, { source: 'api', actor: apiActor(ctx), mapping });
				if (!result.ok) return failure(result);
				const body = { ...ownerOrder(site, result.order), duplicate: result.duplicate };
				return result.duplicate ? ok(body) : created(body, { location: `/v1/orders/${result.order.id}` });
			},
		}),
		route({
			method: 'GET',
			path: '/v1/inbound-orders',
			element: 'inbound_api',
			handler: async (ctx, site) =>
				orderPage(ctx, site, { source: 'api' }, (order) => ({
					id: order.id,
					number: order.number,
					externalId: order.externalId ?? null,
					sourceLabel: order.sourceLabel ?? null,
					status: order.status,
					placedAt: new Date(order.placedAt).toISOString(),
					currency: order.currency,
					total: order.amounts.total,
					risk: order.risk?.flags ?? [],
				})),
		}),

		// ── element views (the Loader's element stub, Mode A without a UI bundle) ─────────────────────────────────
		...['lifecycle', 'fulfilment', 'invoices'].map((element) =>
			defineRoute({
				method: 'GET',
				path: `/v1/elements/${element}/view`,
				auth: 'website',
				element,
				identity: 'optional',
				handler: async (ctx) => {
					const site = await siteOf(ctx.websiteId, ctx.entitlement.doc);
					return ok(await dashboard.elementView(site, element, ctx.identity), { headers: { 'cache-control': 'no-store' } });
				},
			}),
		),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		...dashboard.routes(),
	];
};

/**
 * A stored customer message (the recipient and text only for the full view).
 * @param {Record<string, any>} message
 * @param {boolean} full
 */
export const messageView = (message, full) => ({
	id: message.id,
	orderId: message.orderId,
	number: message.number,
	status: message.status,
	channel: message.channel,
	lang: message.lang,
	state: message.state,
	attempts: message.attempts ?? 0,
	error: message.error ?? null,
	createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : null,
	sentAt: message.sentAt ? new Date(message.sentAt).toISOString() : null,
	...(full ? { to: message.to, subject: message.subject ?? null, text: message.text } : {}),
});

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Orders} orders
 */
export const wireEvents = (orders) => {
	for (const [type, handler] of Object.entries(createEventHandlers(orders))) orders.product.events.on(type, handler);
	return orders;
};
