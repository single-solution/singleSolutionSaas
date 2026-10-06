/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Catalog Mode C API, the
 * element views of the Loader's element stub, the public feed URLs and the dashboard API (SSO sessions).
 *
 * Keys: `pk_` keys (browsers, domain-locked) read public data only — public items in their publication window, visible
 * collections and brands, public custom fields, stock as a state — with public cache headers, and never see cost.
 * `sk_` keys (the merchant's server) read and write everything; they need the `api` element (metered per request,
 * separate read and write rate limits, `api.allow_writes`, `api.expose_cost`). Every route is gated by its element
 * (403 element_disabled in every mode); POSTs that create or move state require an Idempotency-Key.
 */
import { defineRoute, ok, created, paginate, problem, standardRoutes } from '@ss/app-kit';
import { mediaView, orderedMedia } from '../core/media.js';
import { isId, isSlug } from '../core/text.js';
import { repositoriesFor } from '../adapters/db.js';
import { createDashboardApi } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createFeedsService } from './feeds.js';
import { createItemsService, itemSchemaView } from './items.js';
import { createMediaService } from './media.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';
import { createTaxonomyService } from './taxonomy.js';
import { createTransferService, MAX_CSV_CHARS } from './transfer.js';
import { createVariantsService } from './variants.js';
import { attributeView } from '../core/views.js';
import { flushItem } from './catalog.js';
import { EVENT_TYPES } from '../core/events.js';
import { nextTransition, isPublic } from '../core/items.js';

/** @typedef {import('../adapters/platform.js').CatalogApp} CatalogApp */
/** @typedef {import('./catalog.js').Site} Site */

/** Items listed by an element view of the Loader's element stub. */
const VIEW_ITEMS = 12;
/** Work per website and sweep run. */
const SWEEP_BATCH = 200;

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string, line?: number }>} problems
 */
export const invalidProblem = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: p.code.replace(/_/g, ' ') })),
	});

/**
 * Map a service failure to a problem.
 * @param {import('./catalog.js').Failure} result
 */
export const failure = (result) => {
	if (result.reason === 'validation_failed' && result.errors) return invalidProblem(result.errors);
	return problem(result.reason, result.detail ?? result.reason.replace(/_/g, ' '));
};

/**
 * The application (services + site resolution) shared by the routes, the event consumers, the job and the dashboard.
 * @param {CatalogApp} app
 */
export const createCatalog = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	/** @type {import('./catalog.js').Deps} */
	const deps = {
		publish: (event) => product.portal.publishEvent(event),
		audit: (entry) => product.audit.record(entry),
		storage: (websiteId) => product.connectors.storage(websiteId),
		tokens: app.tokens,
		newId: app.newId,
		stableId: app.stableId,
		now: app.now,
		log: product.context?.logger ?? undefined,
	};
	const items = createItemsService(deps);
	const variants = createVariantsService(deps);
	const taxonomy = createTaxonomyService(deps);
	const media = createMediaService(deps);
	const transfer = createTransferService(deps, { items, variants, media });
	const feeds = createFeedsService(deps, { items, baseUrl: () => product.manifest.endpoints.base });
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
	 * Site of a website from its entitlement (null without an active subscription or with items off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'items')) return null;
		return siteOf(websiteId, result.doc);
	};
	/**
	 * Sweep one website: scheduled visibility changes, expired reservations, leftover outbox entries. Each step takes at
	 * most `limit` records; the rest is left for the next run.
	 * @param {Site} site
	 * @param {{ limit?: number }} [options]
	 */
	const sweepSite = async (site, { limit = SWEEP_BATCH } = {}) => {
		const now = app.now();
		let published = 0;
		for (const item of await site.repos.items.dueTransitions(new Date(now), limit)) {
			const visible = isPublic(item, { statuses: site.settings.items.statuses, now, scheduled: true });
			const key = `item.updated:${item.id}:visibility:${item.nextTransitionAt instanceof Date ? item.nextTransitionAt.toISOString() : String(item.nextTransitionAt)}`;
			const next = {
				...item,
				nextTransitionAt: nextTransition(item, now),
				version: (item.version ?? 1) + 1,
				updatedAt: new Date(now),
			};
			const entries = [{ type: EVENT_TYPES.updated, key, changed: [visible ? 'published' : 'unpublished'] }];
			if (await site.repos.items.write(next, item.version ?? 1, entries)) {
				await flushItem(deps, site, { ...next, outbox: [...(item.outbox ?? []), ...entries] });
				published += 1;
			}
		}
		const expired = site.settings.enabled('variants') ? await variants.expire(site, limit) : 0;
		let republished = 0;
		for (const item of await site.repos.items.pendingOutbox(new Date(now - 60_000), limit))
			republished += (await flushItem(deps, site, item)).published;
		return { transitions: published, expiredReservations: expired, republished };
	};
	return { app, product, deps, items, variants, taxonomy, media, transfer, feeds, siteOf, siteFor, sweepSite };
};

/** @typedef {ReturnType<typeof createCatalog>} Catalog */

/**
 * @param {Catalog} catalog
 */
export const buildRoutes = (catalog) => {
	const { product, items, variants, taxonomy, media, transfer, feeds, siteOf } = catalog;
	/** @param {any} ctx */
	const isServer = (ctx) => ctx.website?.kind === 'sk';
	/** @param {any} ctx */
	const apiActor = (ctx) => ({ type: 'api', id: ctx.website?.keyId ?? 'unknown' });
	/** @param {any} ctx @param {Site} s */
	const exposeCost = (ctx, s) => isServer(ctx) && s.settings.api.expose_cost === true;

	/**
	 * Rate limits: browsers share `api.public_rate_per_minute`; servers `api.read_rate_per_minute` and
	 * `api.write_rate_per_minute`.
	 * @param {'read' | 'write'} kind
	 */
	const rate = (kind) => ({
		windowMs: 60_000,
		bucket: `catalog-${kind}`,
		key: (/** @type {any} */ ctx) => `w:${ctx.websiteId}:${ctx.website?.kind ?? 'x'}`,
		limit: (/** @type {any} */ ctx) => {
			const config = { ...(product.entitlements.config(ctx.entitlement?.doc, 'api') ?? {}) };
			const pick = (/** @type {string} */ name, /** @type {number} */ fallback) =>
				Number.isSafeInteger(config[name]) ? config[name] : fallback;
			if (!isServer(ctx)) return pick('public_rate_per_minute', 1200);
			return kind === 'write' ? pick('write_rate_per_minute', 120) : pick('read_rate_per_minute', 600);
		},
	});

	/**
	 * A website-key route: element gating by app-kit, then (for `sk_`) the `api` element, writes switch and metering.
	 * @param {{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, element: string, write?: boolean, skOnly?: boolean,
	 *   maxBodyBytes?: number, idempotent?: boolean | 'optional', handler: (ctx: any, site: Site) => Promise<any> }} spec
	 */
	const route = ({ method, path, element, write = false, skOnly = write, maxBodyBytes, idempotent, handler }) =>
		defineRoute({
			method,
			path,
			auth: 'website',
			element,
			...(skOnly ? { keyKind: /** @type {const} */ ('sk') } : {}),
			...(maxBodyBytes ? { maxBodyBytes } : {}),
			...(idempotent === undefined ? {} : { idempotent }),
			rateLimit: rate(write ? 'write' : 'read'),
			handler: async (ctx) => {
				const s = await siteOf(ctx.websiteId, ctx.entitlement.doc);
				if (isServer(ctx)) {
					if (!s.settings.enabled('api')) return problem('element_disabled', "Server keys need the 'api' element.");
					if (write && !s.settings.api.allow_writes)
						return problem('writes_disabled', 'Writes with sk_ keys are turned off (api.allow_writes).');
					await Promise.resolve(
						product.usage.record({
							websiteId: ctx.websiteId,
							unit: 'request',
							quantity: 1,
							idempotencyKey: `req:${catalog.app.newId('req')}`,
						}),
					).catch(() => undefined);
				}
				return handler(ctx, s);
			},
		});

	/**
	 * Cache headers: public data for `pk_` reads, nothing cached for `sk_`.
	 * @param {any} ctx
	 * @param {Site} s
	 */
	const cacheFor = (ctx, s) =>
		isServer(ctx)
			? { 'cache-control': 'no-store' }
			: {
					'cache-control': `public, max-age=${s.settings.items.cache_seconds}, stale-while-revalidate=${s.settings.items.cache_seconds}`,
				};

	/**
	 * A page of items for the request's key kind.
	 * @param {any} ctx
	 * @param {Site} s
	 */
	const itemPage = async (ctx, s) => {
		const owner = isServer(ctx);
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
			{ defaultLimit: owner ? 20 : s.settings.items.page_size, maxLimit: 100 },
		);
		const result = await items.list(s, ctx.query, {
			owner,
			after: page.after,
			fetchLimit: page.fetchLimit,
			total: ctx.query.page !== undefined || include(ctx).includes('total'),
		});
		if (!result.ok) return { failure: result };
		const body = page.page(result.items, (item) => items.cursorKey(item, result.spec));
		// offset pages (`?page=`): the next page number instead of a cursor
		if (result.page !== null)
			return {
				page,
				body: { ...body, nextCursor: null, page: result.page, next: body.hasMore ? result.page + 1 : null },
				sort: result.sort,
				owner,
				result,
			};
		return { page, body, sort: result.sort, owner, result };
	};

	/** @param {any} ctx @returns {string[]} */
	const include = (ctx) => String(ctx.query.include ?? '').split(',');

	/**
	 * Facets of a listing (`include=facets`): the filterable attributes with counts over the listed items, plus the
	 * price range.
	 * @param {Site} s
	 * @param {Record<string, unknown>} where
	 * @param {string | undefined} collectionId
	 */
	const listFacets = async (s, where, collectionId) => {
		// attributes scoped to a collection apply to it and to every collection below it
		const collection = collectionId && isId(collectionId) ? await s.repos.collections.get(collectionId) : null;
		const scope = collection ? [collection.id, ...collection.ancestors] : null;
		const [facets, range] = await Promise.all([
			taxonomy.facets(s, where, { collectionIds: scope }),
			s.repos.items.priceRange(where),
		]);
		return [
			...facets,
			...(range
				? [{ key: 'price', label: 'price', type: 'range', unit: null, visibility: { type: 'always' }, values: [], range }]
				: []),
		];
	};

	/** @param {any} ctx @param {Site} s @param {Array<Record<string, any>>} list */
	const viewsOf = async (ctx, s, list) =>
		isServer(ctx)
			? Promise.all(list.map((item) => items.owner(s, item, { exposeCost: exposeCost(ctx, s) })))
			: items.publicViews(s, list, { lang: ctx.query.lang ?? null });

	/** @param {import('./catalog.js').Failure | { ok: true } & Record<string, any>} result @param {(r: any) => any} map */
	const reply = (result, map) => (result.ok ? map(result) : failure(/** @type {any} */ (result)));

	const dashboard = createDashboardApi(catalog);

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── items ───────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/items',
			element: 'items',
			handler: async (ctx, s) => {
				const result = await itemPage(ctx, s);
				if ('failure' in result) return failure(/** @type {any} */ (result.failure));
				const { page, body, sort } = result;
				const link = page.link(body.nextCursor);
				const extra = {
					...(result.result.total === null ? {} : { total: result.result.total }),
					...(include(ctx).includes('facets') && s.settings.enabled('attributes') && s.settings.attributes.facets
						? { facets: await listFacets(s, result.result.where, ctx.query['filter[collectionId]']) }
						: {}),
				};
				return ok(
					{ ...body, items: await viewsOf(ctx, s, body.items), sort, ...extra },
					{ headers: { ...cacheFor(ctx, s), ...(link ? { link } : {}) } },
				);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/items',
			element: 'items',
			write: true,
			handler: async (ctx, s) =>
				reply(
					await items.create(s, ctx.body, { key: ctx.idempotencyKey, actor: apiActor(ctx), exposeCost: exposeCost(ctx, s) }),
					(r) => (r.created ? created(r.view, { location: `/v1/items/${r.item.id}` }) : ok(r.view)),
				),
		}),
		route({
			method: 'GET',
			path: '/v1/items/:ref',
			element: 'items',
			handler: async (ctx, s) => {
				const ref = ctx.params.ref;
				if (!isId(ref) && !isSlug(ref)) return problem('not_found', 'No such item.');
				const item = await items.find(s, ref, { owner: isServer(ctx) });
				if (!item) return problem('not_found', 'No such item.');
				const signed = s.settings.enabled('media') ? await media.signedLinks(s, [item]) : undefined;
				const view = isServer(ctx)
					? await items.owner(s, item, { exposeCost: exposeCost(ctx, s), ...(signed ? { signed } : {}) })
					: (await items.publicViews(s, [item], { lang: ctx.query.lang ?? null, ...(signed ? { signed } : {}) }))[0];
				return ok(
					{ ...view, ...(item.slug !== ref && !ref.startsWith('itm_') ? { redirectFrom: ref } : {}) },
					{ headers: signed ? { 'cache-control': 'no-store' } : cacheFor(ctx, s) },
				);
			},
		}),
		route({
			method: 'PATCH',
			path: '/v1/items/:id',
			element: 'items',
			write: true,
			handler: async (ctx, s) => {
				const match = /^"?(\d{1,15})"?$/.exec(ctx.headers.get('if-match') ?? '');
				return reply(
					await items.update(s, ctx.params.id, ctx.body, {
						actor: apiActor(ctx),
						exposeCost: exposeCost(ctx, s),
						expectedVersion: match ? Number(match[1]) : null,
					}),
					(r) => ok(r.view),
				);
			},
		}),
		route({
			method: 'DELETE',
			path: '/v1/items/:id',
			element: 'items',
			write: true,
			handler: async (ctx, s) =>
				reply(await items.remove(s, ctx.params.id, { actor: apiActor(ctx) }), () => ok({ id: ctx.params.id, deleted: true })),
		}),
		route({
			method: 'GET',
			path: '/v1/item-schema',
			element: 'items',
			handler: async (ctx, s) => ok(itemSchemaView(s, { owner: isServer(ctx) }), { headers: cacheFor(ctx, s) }),
		}),

		// ── variants & stock ────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/variants',
			element: 'variants',
			handler: async (ctx, s) => {
				const itemId = ctx.query['filter[itemId]'];
				const sku = ctx.query['filter[sku]'];
				if (itemId !== undefined || sku !== undefined) {
					const item =
						itemId !== undefined
							? isId(itemId)
								? await items.find(s, itemId, { owner: isServer(ctx) })
								: null
							: await s.repos.items.bySku(String(sku));
					const visible = item && (isServer(ctx) || (await items.find(s, item.id, { owner: false })));
					const [view] = visible ? await viewsOf(ctx, s, [item]) : [];
					const list = (view?.variants ?? []).filter((/** @type {any} */ v) => sku === undefined || v.sku === sku);
					return ok(
						{ items: list.map((/** @type {any} */ v) => ({ ...v, itemId: item?.id })), nextCursor: null, hasMore: false },
						{ headers: cacheFor(ctx, s) },
					);
				}
				const result = await itemPage(ctx, s);
				if ('failure' in result) return failure(/** @type {any} */ (result.failure));
				const views = await viewsOf(ctx, s, result.body.items);
				const link = result.page.link(result.body.nextCursor);
				return ok(
					{
						items: views.flatMap((view) => view.variants.map((/** @type {any} */ v) => ({ ...v, itemId: view.id }))),
						nextCursor: result.body.nextCursor,
						hasMore: result.body.hasMore,
					},
					{ headers: { ...cacheFor(ctx, s), ...(link ? { link } : {}) } },
				);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/variants',
			element: 'variants',
			write: true,
			handler: async (ctx, s) =>
				reply(await variants.create(s, ctx.body, { key: ctx.idempotencyKey }), async (r) => {
					const view = await items.owner(s, r.item, { exposeCost: exposeCost(ctx, s) });
					return created(view.variants.find((/** @type {any} */ v) => v.id === r.result) ?? view, {
						location: `/v1/variants/${r.result}`,
					});
				}),
		}),
		route({
			method: 'PATCH',
			path: '/v1/variants/:id',
			element: 'variants',
			write: true,
			handler: async (ctx, s) =>
				reply(await variants.update(s, ctx.params.id, ctx.body, { key: catalog.app.newId('chg') }), async (r) => {
					const view = await items.owner(s, r.item, { exposeCost: exposeCost(ctx, s) });
					return ok(view.variants.find((/** @type {any} */ v) => v.id === ctx.params.id));
				}),
		}),
		route({
			method: 'DELETE',
			path: '/v1/variants/:id',
			element: 'variants',
			write: true,
			handler: async (ctx, s) =>
				reply(await variants.remove(s, ctx.params.id), () => ok({ id: ctx.params.id, deleted: true })),
		}),
		route({
			method: 'POST',
			path: '/v1/variants/:id/stock',
			element: 'variants',
			write: true,
			handler: async (ctx, s) =>
				reply(await variants.adjust(s, ctx.params.id, ctx.body, { key: ctx.idempotencyKey }), async (r) => {
					const view = await items.owner(s, r.item, { exposeCost: exposeCost(ctx, s) });
					return ok(view.variants.find((/** @type {any} */ v) => v.id === ctx.params.id));
				}),
		}),
		route({
			method: 'POST',
			path: '/v1/stock-reservations',
			element: 'variants',
			write: true,
			handler: async (ctx, s) =>
				reply(await variants.reserve(s, ctx.body, { key: ctx.idempotencyKey }), (r) =>
					r.created ? created(r.reservation, { location: `/v1/stock-reservations/${r.reservation.id}` }) : ok(r.reservation),
				),
		}),
		route({
			method: 'GET',
			path: '/v1/stock-reservations/:id',
			element: 'variants',
			skOnly: true,
			handler: async (ctx, s) => {
				const reservation = await variants.getReservation(s, ctx.params.id);
				return reservation
					? ok(reservation, { headers: { 'cache-control': 'no-store' } })
					: problem('not_found', 'No such reservation.');
			},
		}),
		route({
			method: 'DELETE',
			path: '/v1/stock-reservations/:id',
			element: 'variants',
			write: true,
			handler: async (ctx, s) => reply(await variants.release(s, ctx.params.id), (r) => ok(r.reservation)),
		}),

		// ── attributes ──────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/attributes',
			element: 'attributes',
			handler: async (ctx, s) => {
				const list = await s.repos.attributes.list({ limit: 1000 });
				return ok({ items: list.map(attributeView), nextCursor: null, hasMore: false }, { headers: cacheFor(ctx, s) });
			},
		}),
		route({
			method: 'GET',
			path: '/v1/attributes:facets',
			element: 'attributes',
			handler: async (ctx, s) => {
				if (!s.settings.attributes.facets) return problem('forbidden', 'Facet counts are turned off (attributes.facets).');
				const listed = await items.list(
					s,
					{ ...ctx.query, sort: undefined, page: undefined },
					{ owner: false, after: null, fetchLimit: 1 },
				);
				if (!listed.ok) return failure(listed);
				return ok(
					{ items: await listFacets(s, listed.where, ctx.query['filter[collectionId]']) },
					{ headers: cacheFor(ctx, s) },
				);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/attributes',
			element: 'attributes',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.createAttribute(s, ctx.body, { key: ctx.idempotencyKey }), (r) =>
					r.created
						? created(attributeView(r.value), { location: `/v1/attributes/${r.value.id}` })
						: ok(attributeView(r.value)),
				),
		}),
		route({
			method: 'PATCH',
			path: '/v1/attributes/:id',
			element: 'attributes',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.updateAttribute(s, ctx.params.id, ctx.body), (r) => ok(attributeView(r.value))),
		}),
		route({
			method: 'DELETE',
			path: '/v1/attributes/:id',
			element: 'attributes',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.removeAttribute(s, ctx.params.id), () => ok({ id: ctx.params.id, deleted: true })),
		}),

		// ── collections ─────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/collections',
			element: 'collections',
			handler: async (ctx, s) => {
				const parent = ctx.query['filter[parentId]'];
				if (parent !== undefined && parent !== 'root' && !isId(parent))
					return invalidProblem([{ path: '/filter/parentId', code: 'id_invalid' }]);
				const list = await taxonomy.listCollections(s, {
					owner: isServer(ctx),
					tree: ctx.query.tree === 'true',
					...(parent === undefined ? {} : { parentId: parent === 'root' ? null : parent }),
				});
				return ok({ items: list, nextCursor: null, hasMore: false }, { headers: cacheFor(ctx, s) });
			},
		}),
		route({
			method: 'GET',
			path: '/v1/collections/:ref',
			element: 'collections',
			handler: async (ctx, s) => {
				const view = await taxonomy.getCollection(s, ctx.params.ref, { owner: isServer(ctx) });
				return view ? ok(view, { headers: cacheFor(ctx, s) }) : problem('not_found', 'No such collection.');
			},
		}),
		route({
			method: 'POST',
			path: '/v1/collections',
			element: 'collections',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.createCollection(s, ctx.body, { key: ctx.idempotencyKey }), async (r) => {
					const view = await taxonomy.getCollection(s, r.value.id, { owner: true });
					return r.created ? created(view, { location: `/v1/collections/${r.value.id}` }) : ok(view);
				}),
		}),
		route({
			method: 'PATCH',
			path: '/v1/collections/:id',
			element: 'collections',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.updateCollection(s, ctx.params.id, ctx.body), async () =>
					ok(await taxonomy.getCollection(s, ctx.params.id, { owner: true })),
				),
		}),
		route({
			method: 'DELETE',
			path: '/v1/collections/:id',
			element: 'collections',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.removeCollection(s, ctx.params.id), () => ok({ id: ctx.params.id, deleted: true })),
		}),

		// ── brands ──────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/brands',
			element: 'brands',
			handler: async (ctx, s) =>
				ok(
					{ items: await taxonomy.listBrands(s, { owner: isServer(ctx) }), nextCursor: null, hasMore: false },
					{ headers: cacheFor(ctx, s) },
				),
		}),
		route({
			method: 'GET',
			path: '/v1/brands/:ref',
			element: 'brands',
			handler: async (ctx, s) => {
				const list = await taxonomy.listBrands(s, { owner: isServer(ctx) });
				const brand = list.find((/** @type {any} */ b) => b.id === ctx.params.ref || b.slug === ctx.params.ref);
				return brand ? ok(brand, { headers: cacheFor(ctx, s) }) : problem('not_found', 'No such brand.');
			},
		}),
		route({
			method: 'POST',
			path: '/v1/brands',
			element: 'brands',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.createBrand(s, ctx.body, { key: ctx.idempotencyKey }), async (r) => {
					const view = (await taxonomy.listBrands(s, { owner: true })).find((/** @type {any} */ b) => b.id === r.value.id);
					return r.created ? created(view, { location: `/v1/brands/${r.value.id}` }) : ok(view);
				}),
		}),
		route({
			method: 'PATCH',
			path: '/v1/brands/:id',
			element: 'brands',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.updateBrand(s, ctx.params.id, ctx.body), async () =>
					ok((await taxonomy.listBrands(s, { owner: true })).find((/** @type {any} */ b) => b.id === ctx.params.id)),
				),
		}),
		route({
			method: 'DELETE',
			path: '/v1/brands/:id',
			element: 'brands',
			write: true,
			handler: async (ctx, s) =>
				reply(await taxonomy.removeBrand(s, ctx.params.id), () => ok({ id: ctx.params.id, deleted: true })),
		}),

		// ── media ───────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/media',
			element: 'media',
			handler: async (ctx, s) => {
				const itemId = ctx.query['filter[itemId]'];
				if (itemId !== undefined) {
					const item = isId(itemId) ? await items.find(s, itemId, { owner: isServer(ctx) }) : null;
					if (!item) return ok({ items: [], nextCursor: null, hasMore: false }, { headers: cacheFor(ctx, s) });
					const signed = await media.signedLinks(s, [item]);
					const list = orderedMedia(item.media ?? []).map((m, index) =>
						mediaView(m, { settings: s.settings.media, index, title: item.title, ...(signed ? { signed } : {}) }),
					);
					return ok(
						{ items: list.map((m) => ({ ...m, itemId: item.id })), nextCursor: null, hasMore: false },
						{ headers: signed ? { 'cache-control': 'no-store' } : cacheFor(ctx, s) },
					);
				}
				const result = await itemPage(ctx, s);
				if ('failure' in result) return failure(/** @type {any} */ (result.failure));
				const views = await viewsOf(ctx, s, result.body.items);
				return ok(
					{
						items: views.flatMap((view) => view.media.map((/** @type {any} */ m) => ({ ...m, itemId: view.id }))),
						nextCursor: result.body.nextCursor,
						hasMore: result.body.hasMore,
					},
					{ headers: cacheFor(ctx, s) },
				);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/media',
			element: 'media',
			write: true,
			handler: async (ctx, s) =>
				reply(await media.add(s, ctx.body, { key: ctx.idempotencyKey }), async (r) => {
					const view = await items.owner(s, r.item, { exposeCost: false });
					return created(view.media.find((/** @type {any} */ m) => m.id === r.result) ?? view.media.at(-1), {
						location: `/v1/media/${r.result}`,
					});
				}),
		}),
		route({
			method: 'POST',
			path: '/v1/media:reorder',
			element: 'media',
			write: true,
			idempotent: 'optional',
			handler: async (ctx, s) =>
				reply(await media.reorder(s, ctx.body), async (r) =>
					ok({ items: (await items.owner(s, r.item, { exposeCost: false })).media }),
				),
		}),
		route({
			method: 'PATCH',
			path: '/v1/media/:id',
			element: 'media',
			write: true,
			handler: async (ctx, s) =>
				reply(await media.update(s, ctx.params.id, ctx.body), async (r) =>
					ok(
						(await items.owner(s, r.item, { exposeCost: false })).media.find(
							(/** @type {any} */ m) => m.id === ctx.params.id,
						),
					),
				),
		}),
		route({
			method: 'DELETE',
			path: '/v1/media/:id',
			element: 'media',
			write: true,
			handler: async (ctx, s) => reply(await media.remove(s, ctx.params.id), () => ok({ id: ctx.params.id, deleted: true })),
		}),
		route({
			method: 'POST',
			path: '/v1/media-uploads',
			element: 'media',
			write: true,
			idempotent: 'optional',
			handler: async (ctx, s) => reply(await media.presign(s, ctx.body), (r) => created(r.upload)),
		}),

		// ── import & export ─────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'POST',
			path: '/v1/imports',
			element: 'import_export',
			write: true,
			maxBodyBytes: MAX_CSV_CHARS * 2,
			handler: async (ctx, s) =>
				reply(
					await transfer.run(s, ctx.body, { key: ctx.idempotencyKey, actor: apiActor(ctx), exposeCost: exposeCost(ctx, s) }),
					(r) => ok(r.report),
				),
		}),
		route({
			method: 'GET',
			path: '/v1/exports',
			element: 'import_export',
			skOnly: true,
			handler: async (ctx, s) => {
				const result = await transfer.exportItems(s, ctx.query, { exposeCost: exposeCost(ctx, s) });
				if (!result.ok) return failure(result);
				return new Response(result.csv, {
					status: 200,
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': 'attachment; filename="catalog.csv"',
						'cache-control': 'no-store',
						'x-ss-rows': String(result.count),
					},
				});
			},
		}),
		route({
			method: 'GET',
			path: '/v1/exports:template',
			element: 'import_export',
			skOnly: true,
			handler: async (_ctx, s) =>
				new Response(transfer.template(s), {
					status: 200,
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': 'attachment; filename="catalog-template.csv"',
						'cache-control': 'no-store',
					},
				}),
		}),

		// ── feeds ───────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/feeds',
			element: 'feeds',
			skOnly: true,
			handler: async (_ctx, s) =>
				ok({ items: feeds.list(s), nextCursor: null, hasMore: false }, { headers: { 'cache-control': 'no-store' } }),
		}),
		route({
			method: 'GET',
			path: '/v1/feeds/:key/preview',
			element: 'feeds',
			skOnly: true,
			handler: async (ctx, s) => {
				const rendered = await feeds.render(s, ctx.params.key);
				if (!rendered) return problem('not_found', 'No such feed.');
				return new Response(rendered.body.slice(0, 200_000), {
					status: 200,
					headers: { 'content-type': rendered.contentType, 'cache-control': 'no-store', 'x-ss-rows': String(rendered.rows) },
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/feeds/:token',
			auth: 'none',
			rateLimit: { limit: 120, windowMs: 60_000, key: (ctx) => `feed:${String(ctx.params.token).slice(-24)}` },
			handler: async (ctx) => {
				const claims = catalog.app.tokens.verify(String(ctx.params.token).replace(/\.(xml|csv|tsv|json)$/, ''));
				if (!claims) return problem('not_found', 'No such feed.');
				const result = await product.entitlements.forWebsite(claims.websiteId);
				if (!result.ok || !product.entitlements.can(result.doc, 'feeds') || !product.entitlements.can(result.doc, 'items'))
					return problem('not_found', 'No such feed.');
				const s = await siteOf(claims.websiteId, result.doc);
				if (claims.version !== s.settings.feeds.token_version) return problem('not_found', 'No such feed.');
				const rendered = await feeds.render(s, claims.feedKey);
				if (!rendered) return problem('not_found', 'No such feed.');
				const headers = {
					'content-type': rendered.contentType,
					'cache-control': `public, max-age=${rendered.maxAge}, stale-while-revalidate=${rendered.maxAge}`,
					etag: rendered.etag,
					'x-robots-tag': 'noindex',
					...(rendered.truncated ? { 'x-ss-truncated': 'true' } : {}),
				};
				if (ctx.headers.get('if-none-match') === rendered.etag) return new Response(null, { status: 304, headers });
				return new Response(rendered.body, { status: 200, headers });
			},
		}),

		// ── api ─────────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/catalog-stats',
			element: 'api',
			skOnly: true,
			handler: async (_ctx, s) => ok(await dashboard.stats(s), { headers: { 'cache-control': 'no-store' } }),
		}),

		// ── element views (the Loader's element stub, Mode A without a UI bundle) ─────────────────────────────────
		...['items', 'variants', 'attributes', 'collections', 'brands', 'media'].map((element) =>
			route({
				method: 'GET',
				path: `/v1/elements/${element}/view`,
				element,
				handler: async (ctx, s) =>
					ok(await dashboard.elementView(s, element, ctx.query.ctx, VIEW_ITEMS), { headers: cacheFor(ctx, s) }),
			}),
		),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		...dashboard.routes(),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Catalog} catalog
 */
export const wireEvents = (catalog) => {
	for (const [type, handler] of Object.entries(createEventHandlers(catalog))) catalog.product.events.on(type, handler);
	return catalog;
};
