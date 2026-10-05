/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Configurator Builder
 * Mode C API and the dashboard API (SSO sessions). Every product route is gated by its element: a disabled element
 * answers 403 element_disabled in every mode. Handlers are thin — validation and logic live in core/ and the service.
 *
 * Keys: `sk_` (servers) manage configurators and read drafts; `pk_` (browsers, domain-locked) read published
 * configurators and evaluate, quote and build URLs for them.
 */
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { checkCondition } from '../core/rules.js';
import { validateEvaluation, validateLifecycle, validateQuote, validateUrlParams } from '../core/validate.js';
import { configuratorView, summaryView } from '../core/views.js';
import { itemView } from '../core/catalog.js';
import { repositoriesFor } from '../adapters/db.js';
import { createTranslator } from '../core/strings.js';
import { DASHBOARD_WRITE_ROLES, actorOf } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createConfiguratorService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').ConfiguratorApp} ConfiguratorApp */
/** @typedef {import('./service.js').Site} Site */

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string, message?: string }>} problems
 */
const invalid = (problems) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: problems.map((p) => ({ path: p.path, code: p.code, message: p.message ?? p.code.replace(/_/g, ' ') })),
	});

/**
 * Map a service failure to a problem.
 * @param {import('./service.js').Failure} failure
 */
export const failure = (failure) => {
	switch (failure.reason) {
		case 'validation_failed':
			return invalid(failure.problems ?? []);
		case 'not_found':
			return problem('not_found', 'No such configurator.');
		case 'gone':
			return problem('gone', 'The configurator is archived.');
		default:
			return problem(failure.reason, failure.detail ?? failure.reason.replace(/_/g, ' '), {
				...(failure.extensions ? { extensions: failure.extensions } : {}),
			});
	}
};

/**
 * The application (service + site resolution) shared by the routes, the event consumers and the dashboard.
 * @param {ConfiguratorApp} app
 */
export const createConfiguratorApp = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product);
	const service = createConfiguratorService({
		publish: (event) => product.portal.publishEvent(event),
		recordUsage: (usage) => product.usage.record(usage),
		audit: (entry) => product.audit.record(entry),
		now: app.now,
		newId: app.newId,
	});
	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => ({
		websiteId,
		settings: settingsForDoc(product, doc),
		repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
	});
	/**
	 * Site of a website from its entitlement (null without an active subscription or with `schema` off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'schema')) return null;
		return siteOf(websiteId, result.doc);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createConfiguratorApp>} Configurator */

/**
 * @param {Configurator} configurator
 */
export const buildRoutes = (configurator) => {
	const { app, product, service, siteOf } = configurator;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/** Browser keys only see published configurators. @param {any} ctx */
	const scope = (ctx) => ({ publishedOnly: ctx.website?.kind !== 'sk' });
	/** @param {string} element @param {'sk' | null} [keyKind] */
	const website = (element, keyKind = 'sk') => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(keyKind ? { keyKind } : {}),
	});
	/** @param {any} ctx */
	const apiActor = (ctx) => ({ type: 'api', id: ctx.website?.keyId ?? 'unknown' });
	/** Shared per-website evaluation window (evaluations and widget loads). */
	const evaluationLimit = {
		limit: async (/** @type {any} */ ctx) => settingsForDoc(product, ctx.entitlement.doc).api.evaluations_per_minute,
		windowMs: 60_000,
		key: (/** @type {any} */ ctx) => ctx.websiteId,
		bucket: 'evaluations',
	};
	/** @param {string} lang */
	const translator = (lang) => createTranslator(app.strings[lang] ?? app.strings.en ?? {});
	/** @param {any} ctx */
	const maxQuantity = async (ctx) => (await site(ctx)).settings.api.max_quantity;
	/** Dashboard session → website (null = pick a website / demo). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? site(ctx) : null);
	const pickWebsite = () => problem('bad_request', 'Open the dashboard for a website.');

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── schema: configurators ────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/configurators',
			...website('schema'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const status = ['draft', 'published', 'archived'].includes(ctx.query.status) ? ctx.query.status : null;
				const items = await (
					await site(ctx)
				).repos.configurators.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
					status,
				});
				return page.respond(items.map(summaryView), (/** @type {{ id: string }} */ item) => item.id);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/configurators',
			...website('schema'),
			handler: async (ctx) => {
				const problems = validateLifecycle(ctx.body, { update: false });
				if (problems.length > 0) return invalid(problems);
				const result = await service.create(await site(ctx), ctx.body, apiActor(ctx));
				return result.ok
					? created(configuratorView(result.record), { location: `/v1/configurators/${result.record.id}` })
					: failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/configurators:check',
			...website('schema'),
			idempotent: false,
			handler: async (ctx) => {
				if (ctx.body === null || typeof ctx.body !== 'object') return invalid([{ path: '', code: 'type' }]);
				return ok(service.check(await site(ctx), ctx.body));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/configurators/:id',
			...website('schema', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (ctx.website.kind !== 'sk' || ctx.query.view === 'public') {
					const result = await service.publicView(s, ctx.params.id, scope(ctx));
					return result.ok ? ok(result.view) : failure(result);
				}
				const record = await service.find(s, ctx.params.id);
				return record ? ok(configuratorView(record)) : problem('not_found', 'No such configurator.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/configurators/:id',
			...website('schema'),
			handler: async (ctx) => {
				const problems = validateLifecycle(ctx.body, { update: true });
				if (problems.length > 0) return invalid(problems);
				const result = await service.update(await site(ctx), ctx.params.id, ctx.body, apiActor(ctx));
				return result.ok ? ok(configuratorView(result.record)) : failure(result);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/configurators/:id',
			...website('schema'),
			handler: async (ctx) => {
				const result = await service.archive(await site(ctx), ctx.params.id, apiActor(ctx));
				return result.ok ? ok(configuratorView(result.record)) : failure(result);
			},
		}),

		// ── schema: catalog link (what item.* / inventory.changed events stored) ─────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/catalog-items',
			...website('schema'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const items = await (
					await site(ctx)
				).repos.items.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(items.map(itemView), (/** @type {{ itemId: string }} */ item) => item.itemId);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/catalog-items/:itemId',
			...website('schema'),
			handler: async (ctx) => {
				const item = await (await site(ctx)).repos.items.get(ctx.params.itemId);
				return item ? ok(itemView(item)) : problem('not_found', 'No such catalog item.');
			},
		}),

		// ── api: evaluations (resolver + price + URL) ────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/evaluations',
			...website('api', null),
			idempotent: false,
			rateLimit: evaluationLimit,
			handler: async (ctx) => {
				const problems = validateEvaluation(ctx.body, { maxQuantity: await maxQuantity(ctx) });
				if (problems.length > 0) return invalid(problems);
				const result = await service.evaluate(await site(ctx), ctx.body, scope(ctx));
				return result.ok ? ok(result.evaluation) : failure(result);
			},
		}),

		// ── price_deltas: quotes ─────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/quotes',
			...website('price_deltas', null),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateQuote(ctx.body, { maxQuantity: await maxQuantity(ctx) });
				if (problems.length > 0) return invalid(problems);
				const result = await service.quote(await site(ctx), ctx.body, scope(ctx));
				return result.ok ? ok(result.quote) : failure(result);
			},
		}),

		// ── url_sync: URL parameters ─────────────────────────────────────────────────────────────────────
		.../** @type {const} */ (['build', 'parse']).map((mode) =>
			defineRoute({
				method: 'POST',
				path: `/v1/url-params:${mode}`,
				...website('url_sync', null),
				idempotent: false,
				handler: async (ctx) => {
					const problems = validateUrlParams(ctx.body, mode);
					if (problems.length > 0) return invalid(problems);
					const result = await service.urlParams(await site(ctx), ctx.body, mode, scope(ctx));
					return result.ok ? ok(result.result) : failure(result);
				},
			}),
		),

		// ── widget: bootstrap (Mode B/C) and the element stub view (Mode A without a UI bundle) ──────────
		defineRoute({
			method: 'GET',
			path: '/v1/widgets/:configurator',
			...website('widget', null),
			rateLimit: evaluationLimit,
			handler: async (ctx) => {
				const search = typeof ctx.query.search === 'string' ? ctx.query.search.slice(0, 4096) : '';
				const result = await service.widget(await site(ctx), ctx.params.configurator, { search, ...scope(ctx) });
				return result.ok ? ok(result.widget) : failure(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/widget/view',
			...website('widget', null),
			handler: async (ctx) => {
				const t = translator(typeof ctx.query.lang === 'string' ? ctx.query.lang : 'en');
				const s = await site(ctx);
				/** @type {string | null} */
				let ref = typeof ctx.query.configurator === 'string' ? ctx.query.configurator : null;
				if (!ref && typeof ctx.query.ctx === 'string') {
					try {
						const page = JSON.parse(ctx.query.ctx.slice(0, 2048));
						const linked = typeof page?.itemId === 'string' ? await s.repos.configurators.byItem(page.itemId) : [];
						ref = linked.find((record) => record.status === 'published')?.id ?? null;
					} catch {
						ref = null;
					}
				}
				const result = ref ? await service.publicView(s, ref, { publishedOnly: true }) : null;
				if (!result?.ok) return ok({ title: t('widget.title'), body: t('widget.error.not_found'), items: [], actions: [] });
				const { view } = result;
				const groups = view.schema.groups.slice(0, 50);
				return ok({
					title: view.name.slice(0, 200),
					body: t('widget.stub.body', { count: groups.length }).slice(0, 2000),
					items: groups.map((group) => ({
						text: t('widget.stub.group', {
							group: group.label,
							options: group.options
								.filter((option) => !option.hidden)
								.map((option) => option.label)
								.join(t('widget.list.separator')),
						}).slice(0, 500),
					})),
					actions: [],
				});
			},
		}),

		// ── dashboard (SSO session) ──────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'schema',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.overview(s)) : pickWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/configurators',
			auth: 'launch',
			element: 'schema',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return pickWebsite();
				const problems = validateLifecycle(ctx.body, { update: false });
				if (problems.length > 0) return invalid(problems);
				const result = await service.create(s, ctx.body, actorOf(sessionView(ctx.session)));
				return result.ok ? created(configuratorView(result.record)) : failure(result);
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/dashboard/configurators/:id',
			auth: 'launch',
			element: 'schema',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return pickWebsite();
				const problems = validateLifecycle(ctx.body, { update: true });
				if (problems.length > 0) return invalid(problems);
				const result = await service.update(s, ctx.params.id, ctx.body, actorOf(sessionView(ctx.session)));
				return result.ok ? ok(configuratorView(result.record)) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/configurators:check',
			auth: 'launch',
			element: 'schema',
			idempotent: false,
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return pickWebsite();
				return ctx.body !== null && typeof ctx.body === 'object'
					? ok(service.check(s, ctx.body))
					: invalid([{ path: '', code: 'type' }]);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/evaluations',
			auth: 'launch',
			element: 'resolver',
			idempotent: false,
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return pickWebsite();
				const problems = validateEvaluation(ctx.body, { maxQuantity: s.settings.api.max_quantity });
				if (problems.length > 0) return invalid(problems);
				// the merchant's own previews are not metered
				const result = await service.evaluate(s, ctx.body, { publishedOnly: false, meter: false });
				return result.ok ? ok(result.evaluation) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/rules:check',
			auth: 'launch',
			idempotent: false,
			handler: (ctx) => {
				const source = ctx.body?.source;
				return typeof source === 'string' && source.length <= 2000
					? ok(checkCondition(source))
					: invalid([{ path: '/source', code: 'required' }]);
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Configurator} configurator
 */
export const wireEvents = (configurator) => {
	const handlers = createEventHandlers({
		service: configurator.service,
		siteFor: configurator.siteFor,
		now: configurator.app.now,
	});
	for (const [type, handler] of Object.entries(handlers)) configurator.product.events.on(type, handler);
	return configurator;
};
