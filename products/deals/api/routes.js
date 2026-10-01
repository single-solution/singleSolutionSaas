/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Deals Mode C API and the
 * dashboard API (SSO sessions). Every product route is gated by its element: a disabled element answers 403
 * element_disabled in every mode. POSTs that create or move state require an Idempotency-Key (app-kit stores and
 * replays the response); quote, offer and lock calls are rate limited per website with the configured
 * `quote_api.rate_per_minute`. Handlers are thin — validation and rules live in core/.
 */
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { validateDeal } from '../core/deals.js';
import { checkCondition } from '../core/rules.js';
import { scheduleState } from '../core/schedule.js';
import { DAY_MS, MINUTE_MS } from '../core/time.js';
import { MAX_LINES, idCheck, isObject, validateCommit, validateItem, validateOffers, validateQuote } from '../core/validate.js';
import { repositoriesFor } from '../adapters/db.js';
import { DASHBOARD_WRITE_ROLES, dashboardActor } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createDealsService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').DealsApp} DealsApp */
/** @typedef {import('./service.js').Site} Site */

/** Rate-limit window of `quote_api.rate_per_minute`. */
const RATE_WINDOW_MS = MINUTE_MS;

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string }>} problems
 */
export const invalid = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: p.code.replace(/_/g, ' ') })),
	});

/**
 * Map a service failure to a problem.
 * @param {{ reason: string, detail?: string, dealId?: string, problems?: Array<{ path: string, code: string }> }} failure
 */
export const failure = (failure) => {
	if (failure.reason === 'validation_failed' && failure.problems) return invalid(failure.problems);
	if (failure.reason === 'conflict')
		return problem('conflict', failure.detail ?? 'The deal changed concurrently; read it again and retry.');
	if (failure.reason === 'not_found') return problem('not_found', 'Not found.');
	if (failure.reason === 'deal_exhausted')
		return problem('deal_exhausted', `Deal ${failure.dealId} ran out; quote the cart again.`, {
			errors: [{ path: '/deals', message: String(failure.dealId) }],
		});
	return problem(failure.reason, failure.detail ?? failure.reason.replace(/_/g, ' '));
};

/**
 * The application (service + site resolution) shared by the routes, the event consumers and the dashboard.
 * @param {DealsApp} app
 */
export const createDeals = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const service = createDealsService({
		publish: (event) => product.portal.publishEvent(event),
		recordUsage: (usage) => product.usage.record(usage),
		audit: (entry) => product.audit.record(entry),
		locks: app.locks,
		newId: (prefix) => createId(prefix),
		now: app.now,
	});
	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => ({
		websiteId,
		subscriptionId: typeof doc.subscriptionId === 'string' ? doc.subscriptionId : null,
		settings: settingsForDoc(product, doc),
		repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
	});
	/**
	 * Site of a website from its entitlement (null without an active subscription or with the engine off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'quote_api')) return null;
		return siteOf(websiteId, result.doc);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createDeals>} Deals */

/**
 * @param {Deals} deals
 */
export const buildRoutes = (deals) => {
	const { app, product, service, siteOf } = deals;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	const website = (/** @type {string} */ element, /** @type {'sk' | null} */ keyKind = 'sk') => ({
		auth: /** @type {const} */ ('website'),
		element,
		// browser routes read the shopper from SS-Identity (the website's own login, verified by app-kit)
		...(keyKind ? { keyKind } : { identity: /** @type {const} */ ('optional') }),
	});
	/** @param {any} ctx */
	const actorOf = (ctx) => ({ type: 'api', id: ctx.website.keyId });
	/** @param {any} ctx @param {Site} s */
	const customerOf = (ctx, s) =>
		service.customerOf(s, {
			keyKind: ctx.website.kind,
			identitySubject: ctx.identity?.subject ?? null,
			body: ctx.body?.customer,
		});

	/**
	 * The configured per-website rate limit (`quote_api.rate_per_minute`): headers for the response, or a 429 problem.
	 * @param {any} ctx
	 * @param {Site} s
	 * @returns {Promise<{ headers: Record<string, string>, limited: unknown | null }>}
	 */
	const rateLimit = async (ctx, s) => {
		const limit = s.settings.quote.rate_per_minute;
		try {
			const { count, resetAt } = await product.context.stores.rateLimits.hit(
				`deals.quote|w:${s.websiteId}`,
				RATE_WINDOW_MS,
				app.now(),
			);
			const reset = Math.max(0, Math.ceil((resetAt - app.now()) / 1000));
			const headers = {
				'ratelimit-limit': String(limit),
				'ratelimit-remaining': String(Math.max(0, limit - count)),
				'ratelimit-reset': String(reset),
			};
			if (count > limit)
				return {
					headers,
					limited: problem('rate_limited', 'Too many quotes for this website.', {
						headers: { ...headers, 'retry-after': String(Math.max(1, reset)) },
					}),
				};
			return { headers, limited: null };
		} catch {
			return { headers: {}, limited: null }; // a failing limiter store never blocks checkout
		}
	};

	/** @param {Site} s */
	const dealValidator = (s) => (/** @type {unknown} */ input) => validateDeal(input, s.settings.dealRules);

	/**
	 * Create a deal (API and dashboard).
	 * @param {Site} s
	 * @param {unknown} body
	 * @param {{ type: string, id?: string }} actor
	 */
	const createDeal = async (s, body, actor) => {
		const problems = validateDeal(body, s.settings.dealRules);
		if (problems.length > 0) return invalid(problems);
		const result = await service.createDeal(s, /** @type {Record<string, any>} */ (body), actor);
		if (!result.ok) return failure(result);
		return created(result.deal, { location: `/v1/deals/${result.deal.id}` });
	};

	/** @param {any} ctx */
	const reportWindow = (ctx, /** @type {Site} */ s) => {
		const to =
			typeof ctx.query.to === 'string' && Number.isFinite(Date.parse(ctx.query.to))
				? new Date(ctx.query.to)
				: new Date(app.now());
		const from =
			typeof ctx.query.from === 'string' && Number.isFinite(Date.parse(ctx.query.from))
				? new Date(ctx.query.from)
				: new Date(to.getTime() - s.settings.reporting.window_days * DAY_MS);
		return { from, to };
	};

	/** Dashboard session → site (null = pick a website / demo). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? site(ctx) : null);
	const pickWebsite = () => problem('bad_request', 'Open the dashboard for a website.');

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── quote_api: deals ─────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/deals',
			...website('quote_api'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const status = ['active', 'paused', 'archived'].includes(ctx.query.status) ? ctx.query.status : null;
				const kind = ['item', 'cart', 'flash', 'bundle'].includes(ctx.query.kind) ? ctx.query.kind : null;
				const items = await service.listDeals(await site(ctx), {
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
					status,
					kind,
				});
				return page.respond(items, (/** @type {{ id: string }} */ d) => d.id);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/deals',
			...website('quote_api'),
			handler: async (ctx) => createDeal(await site(ctx), ctx.body, actorOf(ctx)),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/deals:check',
			...website('quote_api'),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateDeal(ctx.body, s.settings.dealRules);
				const body = isObject(ctx.body) ? ctx.body : {};
				const sources = {
					'/scope/when': body.scope?.when,
					'/conditions/when': body.conditions?.when,
				};
				const state = scheduleState(isObject(body.schedule) ? body.schedule : {}, app.now(), s.settings.timeZone);
				return ok({
					valid: problems.length === 0,
					errors: problems,
					conditions: Object.fromEntries(
						Object.entries(sources)
							.filter(([, source]) => typeof source === 'string' && source.trim())
							.map(([path, source]) => [path, checkCondition(/** @type {string} */ (source))]),
					),
					schedule: {
						active: state.active,
						phase: state.phase,
						activeUntil: state.activeUntil === null ? null : new Date(state.activeUntil).toISOString(),
						nextStart: state.nextStart === null ? null : new Date(state.nextStart).toISOString(),
						timeZone: state.timeZone,
					},
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/deals/:id',
			...website('quote_api'),
			handler: async (ctx) => {
				const deal = await service.getDeal(await site(ctx), ctx.params.id);
				return deal ? ok(deal) : problem('not_found', 'No such deal.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/deals/:id',
			...website('quote_api'),
			handler: async (ctx) => {
				if (!isObject(ctx.body)) return invalid([{ path: '', code: 'body_invalid' }]);
				const s = await site(ctx);
				const result = await service.updateDeal(s, ctx.params.id, ctx.body, actorOf(ctx), dealValidator(s));
				return result.ok ? ok(result.deal) : failure(result);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/deals/:id',
			...website('quote_api'),
			handler: async (ctx) => {
				const result = await service.setStatus(await site(ctx), ctx.params.id, 'archived', actorOf(ctx));
				return result.ok ? ok({ id: ctx.params.id, status: 'archived' }) : failure(result);
			},
		}),
		.../** @type {Array<['pause' | 'resume', 'paused' | 'active']>} */ ([
			['pause', 'paused'],
			['resume', 'active'],
		]).map(([verb, status]) =>
			defineRoute({
				method: 'POST',
				path: `/v1/deals/:id/${verb}`,
				...website('quote_api'),
				idempotent: 'optional',
				handler: async (ctx) => {
					const result = await service.setStatus(await site(ctx), ctx.params.id, status, actorOf(ctx));
					return result.ok ? ok(result.deal) : failure(result);
				},
			}),
		),

		// ── quote_api: quotes ────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/quotes',
			...website('quote_api', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const { headers, limited } = await rateLimit(ctx, s);
				if (limited) return limited;
				const problems = validateQuote(ctx.body, { maxLines: s.settings.quote.max_lines });
				if (problems.length > 0) return invalid(problems);
				const result = await service.quote(s, ctx.body, { customer: customerOf(ctx, s) });
				if (!result.ok) return failure(result);
				return created(result.quote, { location: `/v1/quotes/${result.quote.id}`, headers });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/quotes/:id',
			...website('quote_api'),
			handler: async (ctx) => {
				const quote = await service.getQuote(await site(ctx), ctx.params.id);
				return quote ? ok(quote) : problem('not_found', 'No such quote.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/quotes/:id/commit',
			...website('quote_api'),
			handler: async (ctx) => {
				const problems = validateCommit(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.commit(await site(ctx), ctx.params.id, ctx.body);
				if (!result.ok) return failure(result);
				return result.replayed ? ok(result.application) : created(result.application);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/quotes/:id/release',
			...website('quote_api'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const result = await service.release(await site(ctx), ctx.params.id);
				return result.ok ? ok(result.application) : failure(result);
			},
		}),

		// ── quote_api: catalog sync ──────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/items',
			...website('quote_api'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const items = await (
					await site(ctx)
				).repos.items.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(items, (/** @type {any} */ i) => i.itemId);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/items/:itemId',
			...website('quote_api'),
			handler: async (ctx) => {
				const item = await service.getItem(await site(ctx), ctx.params.itemId);
				return item ? ok(item) : problem('not_found', 'No such item.');
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/items/:itemId',
			...website('quote_api'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (idCheck(ctx.params.itemId)) return invalid([{ path: '/itemId', code: 'id_invalid' }]);
				const body = isObject(ctx.body) ? { ...ctx.body, itemId: ctx.body.itemId ?? ctx.params.itemId } : ctx.body;
				const problems = validateItem(body, { maxVariants: s.settings.quote.max_variants });
				if (isObject(body) && body.itemId !== ctx.params.itemId) problems.push({ path: '/itemId', code: 'path_mismatch' });
				if (problems.length > 0) return invalid(problems);
				return ok(await service.upsertItem(s, /** @type {Record<string, any>} */ (body)));
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/items/:itemId',
			...website('quote_api'),
			handler: async (ctx) =>
				(await service.removeItem(await site(ctx), ctx.params.itemId))
					? ok({ itemId: ctx.params.itemId, deleted: true })
					: problem('not_found', 'No such item.'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/items:batch',
			...website('quote_api'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const list = isObject(ctx.body) && Array.isArray(ctx.body.items) ? ctx.body.items : null;
				if (!list || list.length === 0 || list.length > s.settings.quote.max_batch_items)
					return invalid([{ path: '/items', code: 'items_invalid' }]);
				const results = [];
				for (const [index, item] of list.entries()) {
					const problems = validateItem(item, { maxVariants: s.settings.quote.max_variants, at: `/items/${index}` });
					if (problems.length > 0) {
						results.push({
							index,
							itemId: isObject(item) ? (item.itemId ?? null) : null,
							status: 'rejected',
							errors: problems,
						});
						continue;
					}
					await service.upsertItem(s, item);
					results.push({ index, itemId: item.itemId, status: 'upserted' });
				}
				return ok({ results });
			},
		}),

		// ── badges: offers ───────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/offers',
			...website('badges', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const refs = String(ctx.query.items ?? '')
					.split(',')
					.map((ref) => ref.trim())
					.filter((ref) => ref.length > 0)
					.slice(0, MAX_LINES)
					.map((ref) => {
						const [itemId, variantId] = ref.split(':');
						return { itemId: /** @type {string} */ (itemId), ...(variantId ? { variantId } : {}) };
					});
				const body = { items: refs, ...(typeof ctx.query.currency === 'string' ? { currency: ctx.query.currency } : {}) };
				if (refs.length === 0) return ok({ currency: body.currency ?? null, items: [], missing: [] });
				const problems = validateOffers(body, { maxItems: s.settings.quote.max_lines });
				if (problems.length > 0) return invalid(problems);
				const { headers, limited } = await rateLimit(ctx, s);
				if (limited) return limited;
				return ok(await service.offers(s, body, { customer: customerOf(ctx, s), meter: ctx.requestId }), { headers });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/offers:evaluate',
			...website('badges', null),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateOffers(ctx.body, { maxItems: s.settings.quote.max_lines });
				if (problems.length > 0) return invalid(problems);
				const { headers, limited } = await rateLimit(ctx, s);
				if (limited) return limited;
				return ok(await service.offers(s, ctx.body, { customer: customerOf(ctx, s), meter: ctx.requestId }), { headers });
			},
		}),

		// ── price_locks ──────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/price-locks',
			...website('price_locks', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateOffers(ctx.body, { maxItems: s.settings.quote.max_lines });
				if (problems.length > 0) return invalid(problems);
				const { headers, limited } = await rateLimit(ctx, s);
				if (limited) return limited;
				const result = await service.offers(s, ctx.body, {
					customer: customerOf(ctx, s),
					meter: ctx.idempotencyKey ?? ctx.requestId,
					forceLock: true,
				});
				return created(
					{
						currency: result.currency,
						items: result.items.map((o) => ({
							itemId: o.itemId,
							variantId: o.variantId,
							unitAmount: o.unitAmount,
							price: o.price,
							lock: o.lock ?? null,
						})),
						missing: result.missing,
					},
					{ headers },
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/price-locks:verify',
			...website('price_locks', null),
			idempotent: false,
			handler: async (ctx) => {
				const token = isObject(ctx.body) ? ctx.body.token : undefined;
				if (typeof token !== 'string') return invalid([{ path: '/token', code: 'required' }]);
				const claims = app.locks.verify(token);
				if (!claims || claims.w !== ctx.websiteId) return ok({ valid: false, reason: 'invalid' });
				const expired = app.now() / 1000 > claims.exp;
				return ok({
					valid: !expired,
					reason: expired ? 'expired' : null,
					itemId: claims.i,
					variantId: claims.vr,
					currency: claims.cur,
					unitAmount: claims.u,
					price: claims.p,
					units: claims.n,
					dealIds: claims.d,
					expiresAt: new Date(claims.exp * 1000).toISOString(),
				});
			},
		}),

		// ── deals_page ───────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/deals-page',
			...website('deals_page', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const size = s.settings.dealsPage.page_size;
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: size, maxLimit: size },
				);
				const offset =
					Number.isSafeInteger(page.after) && /** @type {number} */ (page.after) >= 0
						? /** @type {number} */ (page.after)
						: 0;
				const result = await service.dealsPage(s, { offset, limit: page.limit });
				const nextCursor = offset + page.limit < result.total ? cursorOf(offset + page.limit) : null;
				const link = page.link(nextCursor);
				return ok({ items: result.items, nextCursor, hasMore: nextCursor !== null }, link ? { headers: { link } } : {});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/deals-page/:dealId/items',
			...website('deals_page', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 24, maxLimit: 48 },
				);
				const result = await service.dealItems(s, ctx.params.dealId, {
					after: typeof page.after === 'string' ? page.after : null,
					limit: page.limit,
				});
				if (!result) return problem('not_found', 'No such deal on the deals page.');
				const nextCursor = result.more && result.last ? cursorOf(result.last) : null;
				const link = page.link(nextCursor);
				return ok({ items: result.items, nextCursor, hasMore: nextCursor !== null }, link ? { headers: { link } } : {});
			},
		}),

		// ── reporting ────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/reports',
			...website('reporting'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(await service.report(s, reportWindow(ctx, s)));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reports/deals/:dealId',
			...website('reporting'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const deal = await service.getDeal(s, ctx.params.dealId);
				if (!deal) return problem('not_found', 'No such deal.');
				return ok({ deal, report: await service.report(s, { ...reportWindow(ctx, s), dealId: deal.id }) });
			},
		}),

		// ── dashboard (SSO session) ──────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'quote_api',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.overview(s)) : pickWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/deals',
			auth: 'launch',
			element: 'quote_api',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? createDeal(s, ctx.body, dashboardActor(ctx.session)) : pickWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/deals/:id/status',
			auth: 'launch',
			element: 'quote_api',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return pickWebsite();
				const status = isObject(ctx.body) ? ctx.body.status : undefined;
				if (!['active', 'paused', 'archived'].includes(status)) return invalid([{ path: '/status', code: 'status_invalid' }]);
				const result = await service.setStatus(s, ctx.params.id, status, dashboardActor(ctx.session));
				return result.ok ? ok(result.deal) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/quotes:preview',
			auth: 'launch',
			element: 'quote_api',
			idempotent: false,
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return pickWebsite();
				const problems = validateQuote(ctx.body, { maxLines: s.settings.quote.max_lines });
				if (problems.length > 0) return invalid(problems);
				const customer = service.customerOf(s, { keyKind: 'sk', identitySubject: null, body: ctx.body.customer });
				const result = await service.quote(s, ctx.body, { customer, preview: true });
				return result.ok ? ok(result.quote) : failure(result);
			},
		}),
	];
};

/**
 * Opaque page cursor in app-kit's encoding (`paginate` decodes it back into `page.after`).
 * @param {string | number} value
 */
const cursorOf = (value) => Buffer.from(JSON.stringify({ k: value })).toString('base64url');

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Deals} deals
 */
export const wireEvents = (deals) => {
	const log = deals.product.context?.logger;
	for (const [type, handler] of Object.entries(createEventHandlers({ ...deals, ...(log ? { log } : {}) })))
		deals.product.events.on(type, handler);
	return deals;
};
