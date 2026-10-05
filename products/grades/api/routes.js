/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Grades Mode C API, the
 * Loader element-stub views and the dashboard API (SSO sessions). Every product route is gated by its element: a
 * disabled element answers 403 element_disabled in every mode. POSTs that create or move state require an
 * Idempotency-Key (app-kit stores and replays the response); handlers are thin — validation and rules live in core/.
 *
 * Keys: `sk_` (the merchant's server, inspection apps, feed builders) reads and changes everything; `pk_` (browsers,
 * domain-locked) reads public data only: tier definitions, item tiers, showcase, filters, warranty, conditions and
 * reports behind a report token.
 */
import { created, defineRoute, noContent, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { parseSelection } from '../core/filters.js';
import { checklistView } from '../core/inspection.js';
import { mappingProblems } from '../core/mapping.js';
import { checkCondition, RULE_ROOTS } from '../core/rules.js';
import { isId, isKey, isObject } from '../core/text.js';
import { tierView } from '../core/tiers.js';
import {
	idList,
	validateAssignment,
	validateBatch,
	validateInspection,
	validateInspectionPatch,
	validatePhotoUpload,
	validateReportLink,
	validateUnit,
	validateUnitPatch,
} from '../core/validate.js';
import {
	actionInput,
	filtersStub,
	inspectionStub,
	mappingStub,
	showcaseStub,
	tiersStub,
	warrantyStub,
	withReportPicker,
	withTierPicker,
} from '../core/views.js';
import { printableTerms } from '../core/warranty.js';
import { repositoriesFor } from '../adapters/db.js';
import { DASHBOARD_WRITE_ROLES, dashboardActor } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { inspectionView, unitView } from './inspections.js';
import { createGradesService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').GradesApp} GradesApp */
/** @typedef {import('./service.js').Site} Site */

/** Items per `?ids=` batch. */
const MAX_BATCH_ITEMS = 100;
/** Items per `:sort` request. */
const MAX_SORT_ITEMS = 500;
/** Language tags accepted in `?lang=`. */
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
/** Longest report token accepted from a stub action. */
const MAX_TOKEN_LENGTH = 100;

/**
 * Element stub actions (`POST /v1/elements/<key>/actions/<action>`, ss-element-stub@2): `refresh` re-reads the view;
 * `select` shows one tier (showcase, warranty); `open` opens an inspection report by its code. All are reads.
 */
export const STUB_ACTIONS = Object.freeze({
	tiers: Object.freeze(['refresh']),
	showcase: Object.freeze(['refresh', 'select']),
	filters: Object.freeze(['refresh']),
	warranty: Object.freeze(['refresh', 'select']),
	mapping: Object.freeze(['refresh']),
	inspection: Object.freeze(['refresh', 'open']),
});

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
 * @param {{ reason: string, detail?: string, errors?: Array<{ path: string, code: string }> }} result
 */
export const failure = (result) => {
	if (result.reason === 'validation_failed') return invalid(result.errors ?? []);
	return problem(result.reason, result.detail ?? result.reason.replace(/_/g, ' '), {
		...(result.errors
			? { errors: result.errors.map((p) => ({ path: p.path, code: p.code, message: p.code.replace(/_/g, ' ') })) }
			: {}),
	});
};

/**
 * The Loader stub's page context (`?ctx=` JSON: path, itemId, pageType) merged with direct query values.
 * @param {Record<string, string | undefined>} query
 * @returns {{ itemId: string | null, tier: string | null, token: string | null, collection: string | null }}
 */
export const pageContext = (query) => {
	/** @type {Record<string, unknown>} */
	let ctx = {};
	if (typeof query.ctx === 'string' && query.ctx.length <= 2048) {
		try {
			const parsed = JSON.parse(query.ctx);
			if (isObject(parsed)) ctx = parsed;
		} catch {
			ctx = {};
		}
	}
	const pick = (/** @type {unknown} */ value, /** @type {(v: unknown) => boolean} */ test) =>
		typeof value === 'string' && test(value) ? value : null;
	return {
		itemId: pick(query.itemId ?? ctx.itemId, isId),
		tier: pick(query.tier, isKey),
		token: pick(query.token, (v) => typeof v === 'string' && v.length <= 100),
		collection: pick(query.collection, isId),
	};
};

/**
 * The application (service + site resolution) shared by the routes, the event consumers and the dashboard.
 * @param {GradesApp} app
 */
export const createGrades = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const service = createGradesService({
		publish: (event) => product.portal.publishEvent(event),
		audit: (entry) => product.audit.record(entry),
		storage: (websiteId) => product.connectors.storage(websiteId),
		reports: app.reports,
		hash: app.hash,
		strings: app.strings,
		now: app.now,
	});
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
	 * Site of a website from its entitlement (null without an active subscription or with `tiers` off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'tiers')) return null;
		return siteOf(websiteId, result.doc);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createGrades>} Grades */

/**
 * @param {Grades} grades
 */
export const buildRoutes = (grades) => {
	const { product, service, siteOf } = grades;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/** @param {any} ctx */
	const isServer = (ctx) => ctx.website?.kind === 'sk';
	/**
	 * Website-key route options gated by an element; `pk` = browser keys allowed.
	 * @param {string} element
	 * @param {'sk' | 'pk'} [kind]
	 */
	const website = (element, kind = 'sk') => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(kind === 'sk' ? { keyKind: /** @type {const} */ ('sk') } : {}),
	});
	/** @param {any} ctx */
	const apiActor = (ctx) => ({ type: 'api', id: ctx.website.keyId });
	/**
	 * Public cache headers for `pk_` reads of public data; `no-store` for server keys.
	 * @param {any} ctx
	 * @param {unknown} seconds
	 */
	const cacheFor = (ctx, seconds) =>
		isServer(ctx) || !Number(seconds)
			? { 'cache-control': 'no-store' }
			: { 'cache-control': `public, max-age=${Number(seconds)}` };
	/** @param {any} ctx @param {Site} s */
	const langOf = (ctx, s) =>
		typeof ctx.query.lang === 'string' && LANG.test(ctx.query.lang) ? ctx.query.lang : s.settings.language;
	/** @param {any} ctx */
	const pageOf = (ctx) => paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
	/**
	 * A page response with the Link header.
	 * @param {ReturnType<typeof paginate>} page
	 * @param {any[]} rows
	 * @param {(row: any) => string} keyOf
	 * @param {(row: any) => unknown} view
	 * @param {Record<string, string>} [headers]
	 */
	const pageResponse = (page, rows, keyOf, view, headers = {}) => {
		const body = page.page(rows, keyOf);
		const link = page.link(body.nextCursor);
		return ok({ ...body, items: body.items.map(view) }, { headers: { ...headers, ...(link ? { link } : {}) } });
	};
	/** @param {any} ctx */
	const queryId = (ctx, /** @type {string} */ name) => {
		const value = ctx.query[name];
		return value === undefined ? { ok: true, value: null } : isId(value) ? { ok: true, value } : { ok: false, value: null };
	};
	/** Dashboard session → website (null = pick a website / demo). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? site(ctx) : null);
	const noWebsite = () => problem('bad_request', 'Open the dashboard for a website.');

	/** Active tiers for the stub's tier select. @param {Site} s */
	const tierOptions = (s) =>
		s.settings.tiers.filter((tier) => tier.active).map((tier) => ({ key: tier.key, label: tier.label }));
	/**
	 * Element stub view models, shared by `GET /v1/elements/<key>/view` and the action routes.
	 * @type {Record<keyof typeof STUB_ACTIONS, (ctx: any, s: Site, input: ReturnType<typeof pageContext>) => Promise<Record<string, unknown>>>}
	 */
	const stubViews = {
		tiers: async (ctx, s, { itemId }) => {
			const tiers = itemId
				? (await service.itemTiers(s, itemId)).tiers
				: s.settings.tiers.filter((tier) => tier.active).map((tier) => tierView(tier, s.settings.badgeStyle));
			return tiersStub(tiers, service.translate(langOf(ctx, s)));
		},
		showcase: async (ctx, s, { tier, itemId }) => {
			const t = service.translate(langOf(ctx, s));
			const view = await service.showcase(s, { tier, itemId, lang: langOf(ctx, s) });
			return withTierPicker(showcaseStub(view.entries, t), tierOptions(s), t);
		},
		filters: async (ctx, s, { collection }) => {
			const view = await service.filters(s, collection);
			return filtersStub(view.options, service.translate(langOf(ctx, s)));
		},
		warranty: async (ctx, s, { tier }) => {
			const lang = langOf(ctx, s);
			const t = service.translate(lang);
			const terms = service.warranty(s, lang).filter((term) => !tier || term.tier === tier);
			return withTierPicker(warrantyStub(terms, t), tierOptions(s), t);
		},
		mapping: async (ctx, s, { itemId }) => {
			const t = service.translate(langOf(ctx, s));
			if (!itemId) return mappingStub(null, t);
			const view = await service.conditions(s, itemId);
			const first = /** @type {{ tier: { label: string } | null, values: Record<string, string | null> } | null} */ (
				view.item ?? view.tiers[0] ?? null
			);
			const shown = view.vocabularies.filter((v) => v.display);
			return mappingStub(
				first ? { tier: first.tier, values: shown.map((v) => ({ name: v.name, value: first.values[v.key] ?? null })) } : null,
				t,
			);
		},
		inspection: async (ctx, s, { token }) => {
			const t = service.translate(langOf(ctx, s));
			const report = token ? await service.report(s, token) : null;
			const view = inspectionStub(report, t);
			return withReportPicker(token && !report ? { ...view, body: t('inspection.error.not_found') } : view, t);
		},
	};
	/**
	 * The page context with a stub action's input applied (`select` → tier, `open` → report token).
	 * @param {Site} s
	 * @param {string} action
	 * @param {ReturnType<typeof pageContext>} context
	 * @param {unknown} body
	 * @returns {{ ok: true, input: ReturnType<typeof pageContext> } | { ok: false, problems: Array<{ path: string, code: string }> }}
	 */
	const stubInput = (s, action, context, body) => {
		const input = actionInput(body);
		if (action === 'select') {
			const tier = input.tier ?? null;
			if (tier === null || tier === '') return { ok: true, input: { ...context, tier: null } };
			const known = typeof tier === 'string' ? s.settings.index.get(tier) : undefined;
			if (!isKey(tier) || !known?.active) return { ok: false, problems: [{ path: '/fields/tier', code: 'tier_invalid' }] };
			return { ok: true, input: { ...context, tier: /** @type {string} */ (tier) } };
		}
		if (action === 'open') {
			const token = input.token;
			if (typeof token !== 'string' || token.trim().length === 0 || token.length > MAX_TOKEN_LENGTH)
				return { ok: false, problems: [{ path: '/fields/token', code: 'token_invalid' }] };
			return { ok: true, input: { ...context, token: token.trim() } };
		}
		return { ok: true, input: context };
	};
	const stubActionRoutes = /** @type {Array<[keyof typeof STUB_ACTIONS, readonly string[]]>} */ (
		Object.entries(STUB_ACTIONS)
	).map(([element, actions]) =>
		defineRoute({
			method: 'POST',
			path: `/v1/elements/${element}/actions/:action`,
			...website(element, 'pk'),
			idempotent: 'optional',
			...(element === 'inspection' ? { rateLimit: { limit: 120, windowMs: 60_000 } } : {}),
			handler: async (ctx) => {
				if (!actions.includes(ctx.params.action)) return problem('not_found', 'Unknown action.');
				const s = await site(ctx);
				const parsed = stubInput(s, ctx.params.action, pageContext(ctx.query), ctx.body);
				if (!parsed.ok) return invalid(parsed.problems);
				return ok(await stubViews[element](ctx, s, parsed.input), { headers: { 'cache-control': 'private, no-store' } });
			},
		}),
	);

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── tiers ───────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/tiers',
			...website('tiers', 'pk'),
			handler: async (ctx) => {
				const { settings } = await site(ctx);
				const server = isServer(ctx);
				const tiers = settings.tiers
					.filter((tier) => server || tier.active)
					.map((tier) => ({ ...tierView(tier, settings.badgeStyle), ...(server ? { active: tier.active } : {}) }));
				return ok(
					{
						items: tiers,
						nextCursor: null,
						hasMore: false,
						defaultTier: settings.defaultTier,
						badgeStyle: settings.badgeStyle,
					},
					{ headers: cacheFor(ctx, settings.tiersConfig.cache_seconds) },
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/tiers/:key',
			...website('tiers', 'pk'),
			handler: async (ctx) => {
				const { settings } = await site(ctx);
				const tier = settings.index.get(ctx.params.key);
				if (!tier || (!tier.active && !isServer(ctx))) return problem('not_found', 'No such tier.');
				return ok(tierView(tier, settings.badgeStyle), { headers: cacheFor(ctx, settings.tiersConfig.cache_seconds) });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/items',
			...website('tiers', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const headers = cacheFor(ctx, s.settings.tiersConfig.cache_seconds);
				if (ctx.query.ids !== undefined) {
					const ids = idList(ctx.query.ids, MAX_BATCH_ITEMS);
					if (!ids) return invalid([{ path: '/ids', code: 'ids_invalid' }]);
					return ok({ items: await service.manyItemTiers(s, ids), nextCursor: null, hasMore: false }, { headers });
				}
				const page = pageOf(ctx);
				const rows = await s.repos.items.listGraded({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				const body = page.page(rows, (/** @type {any} */ row) => row.itemId);
				const link = page.link(body.nextCursor);
				return ok(
					{
						...body,
						items: await service.manyItemTiers(
							s,
							body.items.map((/** @type {any} */ row) => row.itemId),
						),
					},
					{ headers: { ...headers, ...(link ? { link } : {}) } },
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/items/:itemId',
			...website('tiers', 'pk'),
			handler: async (ctx) => {
				if (!isId(ctx.params.itemId)) return invalid([{ path: '/itemId', code: 'id_invalid' }]);
				const s = await site(ctx);
				return ok(await service.itemTiers(s, ctx.params.itemId), {
					headers: cacheFor(ctx, s.settings.tiersConfig.cache_seconds),
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/tier-assignments',
			...website('tiers'),
			handler: async (ctx) => {
				const itemId = queryId(ctx, 'filter[itemId]');
				if (!itemId.ok) return invalid([{ path: '/filter/itemId', code: 'id_invalid' }]);
				const tier = ctx.query['filter[tier]'];
				if (tier !== undefined && !isKey(tier)) return invalid([{ path: '/filter/tier', code: 'tier_invalid' }]);
				const s = await site(ctx);
				const page = pageOf(ctx);
				const rows = await s.repos.assignments.list({
					itemId: itemId.value,
					tier: tier ?? null,
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return pageResponse(page, rows, (row) => `${row.itemId}|${row.variantKey}`, service.assignmentView, {
					'cache-control': 'no-store',
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/tier-assignments',
			...website('tiers'),
			handler: async (ctx) => {
				const problems = validateAssignment(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.assign(await site(ctx), {
					itemId: ctx.body.itemId,
					variantId: ctx.body.variantId ?? null,
					tier: ctx.body.tier,
					note: ctx.body.note ?? null,
					actor: apiActor(ctx),
				});
				if (!result.ok) return failure(result);
				return result.created
					? created(result.assignment, { location: `/v1/tier-assignments/${result.assignment.id}` })
					: ok(result.assignment);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/tier-assignments:batch',
			...website('tiers'),
			handler: async (ctx) => {
				const problems = validateBatch(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				/** @type {any[]} */
				const results = [];
				for (const [index, entry] of ctx.body.assignments.entries()) {
					const result = await service.assign(s, {
						itemId: entry.itemId,
						variantId: entry.variantId ?? null,
						tier: entry.tier,
						note: entry.note ?? null,
						actor: apiActor(ctx),
					});
					results.push(
						result.ok
							? { index, status: result.created ? 'created' : 'updated', assignment: result.assignment }
							: { index, status: 'failed', code: result.reason },
					);
				}
				return ok({ results });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/tier-assignments/:id',
			...website('tiers'),
			handler: async (ctx) => {
				const row = await (await site(ctx)).repos.assignments.get(ctx.params.id);
				return row ? ok(service.assignmentView(row)) : problem('not_found', 'No such assignment.');
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/tier-assignments/:id',
			...website('tiers'),
			handler: async (ctx) =>
				(await service.unassign(await site(ctx), ctx.params.id, apiActor(ctx)))
					? noContent()
					: problem('not_found', 'No such assignment.'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/units',
			...website('tiers'),
			handler: async (ctx) => {
				const itemId = queryId(ctx, 'filter[itemId]');
				if (!itemId.ok) return invalid([{ path: '/filter/itemId', code: 'id_invalid' }]);
				const tier = ctx.query['filter[tier]'];
				if (tier !== undefined && !isKey(tier)) return invalid([{ path: '/filter/tier', code: 'tier_invalid' }]);
				const s = await site(ctx);
				const page = pageOf(ctx);
				const rows = await s.repos.units.list({
					itemId: itemId.value,
					tier: tier ?? null,
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return pageResponse(page, rows, (row) => `${row.addedAt}|${row.id}`, unitView, { 'cache-control': 'no-store' });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/units',
			...website('tiers'),
			handler: async (ctx) => {
				const problems = validateUnit(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.createUnit(await site(ctx), {
					itemId: ctx.body.itemId,
					variantId: ctx.body.variantId ?? null,
					serial: ctx.body.serial ?? null,
					tier: ctx.body.tier ?? null,
					note: ctx.body.note ?? null,
					available: ctx.body.available ?? true,
					key: ctx.idempotencyKey,
					actor: apiActor(ctx),
				});
				if (!result.ok) return failure(result);
				return created(result.unit, { location: `/v1/units/${result.unit.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/units/:id',
			...website('tiers'),
			handler: async (ctx) => {
				const unit = await (await site(ctx)).repos.units.get(ctx.params.id);
				return unit ? ok(unitView(unit)) : problem('not_found', 'No such unit.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/units/:id',
			...website('tiers'),
			handler: async (ctx) => {
				const problems = validateUnitPatch(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.updateUnit(await site(ctx), ctx.params.id, ctx.body, apiActor(ctx));
				return result.ok ? ok(result.unit) : failure(result);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/units/:id',
			...website('tiers'),
			handler: async (ctx) =>
				(await service.deleteUnit(await site(ctx), ctx.params.id, apiActor(ctx)))
					? noContent()
					: problem('not_found', 'No such unit.'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/tiers/view',
			...website('tiers', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(await stubViews.tiers(ctx, s, pageContext(ctx.query)), {
					headers: cacheFor(ctx, s.settings.tiersConfig.cache_seconds),
				});
			},
		}),

		// ── showcase ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/showcase',
			...website('showcase', 'pk'),
			handler: async (ctx) => {
				const { tier, itemId } = pageContext(ctx.query);
				if (ctx.query.tier !== undefined && !tier) return invalid([{ path: '/tier', code: 'tier_invalid' }]);
				if (ctx.query.itemId !== undefined && !itemId) return invalid([{ path: '/itemId', code: 'id_invalid' }]);
				const s = await site(ctx);
				return ok(await service.showcase(s, { tier, itemId, lang: langOf(ctx, s) }), {
					headers: cacheFor(ctx, s.settings.showcase.cache_seconds),
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/showcase/view',
			...website('showcase', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(await stubViews.showcase(ctx, s, pageContext(ctx.query)), {
					headers: cacheFor(ctx, s.settings.showcase.cache_seconds),
				});
			},
		}),

		// ── filters ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/tier-filters',
			...website('filters', 'pk'),
			handler: async (ctx) => {
				const { collection } = pageContext(ctx.query);
				if (ctx.query.collection !== undefined && !collection) return invalid([{ path: '/collection', code: 'id_invalid' }]);
				const s = await site(ctx);
				return ok(await service.filters(s, collection), { headers: cacheFor(ctx, s.settings.filters.cache_seconds) });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/tier-filters/items',
			...website('filters', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const { collection } = pageContext(ctx.query);
				if (ctx.query.collection !== undefined && !collection) return invalid([{ path: '/collection', code: 'id_invalid' }]);
				const tiers = parseSelection(ctx.query.tier, s.settings.index, { multi: s.settings.filters.multi_select === true });
				if (!tiers || tiers.length === 0) return invalid([{ path: '/tier', code: 'tier_invalid' }]);
				const page = pageOf(ctx);
				const rows = await s.repos.items.idsInTiers({
					tiers,
					collection,
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return pageResponse(
					page,
					rows,
					(row) => row.itemId,
					(row) => row,
					cacheFor(ctx, s.settings.filters.cache_seconds),
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/tier-filters:sort',
			...website('filters', 'pk'),
			idempotent: false,
			handler: async (ctx) => {
				const body = ctx.body;
				const ids = isObject(body) && Array.isArray(body.itemIds) ? body.itemIds : null;
				if (!ids || ids.length === 0 || ids.length > MAX_SORT_ITEMS || !ids.every(isId))
					return invalid([{ path: '/itemIds', code: 'ids_invalid' }]);
				const s = await site(ctx);
				const direction = body.direction ?? s.settings.filters.default_sort;
				if (!['tier_order', 'tier_order_desc', 'none'].includes(direction))
					return invalid([{ path: '/direction', code: 'direction_invalid' }]);
				return ok({ itemIds: await service.sortItems(s, [...new Set(ids)], direction), direction });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/filters/view',
			...website('filters', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(await stubViews.filters(ctx, s, pageContext(ctx.query)), {
					headers: cacheFor(ctx, s.settings.filters.cache_seconds),
				});
			},
		}),

		// ── warranty ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/warranty',
			...website('warranty', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const lang = langOf(ctx, s);
				const terms = service.warranty(s, lang);
				const headers = cacheFor(ctx, s.settings.warranty.cache_seconds);
				if (ctx.query.format === 'text')
					return new Response(printableTerms(terms, service.translate(lang)), {
						status: 200,
						headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
					});
				if (ctx.query.format !== undefined && ctx.query.format !== 'json')
					return invalid([{ path: '/format', code: 'format_invalid' }]);
				return ok({ items: terms, nextCursor: null, hasMore: false }, { headers });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/warranty/:tier',
			...website('warranty', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const term = service.warranty(s, langOf(ctx, s)).find((entry) => entry.tier === ctx.params.tier);
				return term
					? ok(term, { headers: cacheFor(ctx, s.settings.warranty.cache_seconds) })
					: problem('not_found', 'No warranty for this tier.');
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/warranty/view',
			...website('warranty', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(await stubViews.warranty(ctx, s, pageContext(ctx.query)), {
					headers: cacheFor(ctx, s.settings.warranty.cache_seconds),
				});
			},
		}),

		// ── mapping ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/condition-mappings',
			...website('mapping', 'pk'),
			handler: async (ctx) => {
				const { settings } = await site(ctx);
				const server = isServer(ctx);
				return ok(
					{
						items: settings.vocabularies.map((v) => ({
							key: v.key,
							name: v.name,
							target: v.target,
							property: v.property,
							allowed: v.allowed,
							fallback: v.fallback,
							display: v.display,
							values: v.rows.map((row) => ({ tier: row.tier, value: row.value, source: row.source })),
						})),
						nextCursor: null,
						hasMore: false,
						...(server ? { problems: mappingProblems(settings.vocabularies) } : {}),
					},
					{ headers: cacheFor(ctx, settings.mapping.cache_seconds) },
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/condition-mappings/items/:itemId',
			...website('mapping', 'pk'),
			handler: async (ctx) => {
				if (!isId(ctx.params.itemId)) return invalid([{ path: '/itemId', code: 'id_invalid' }]);
				const s = await site(ctx);
				return ok(await service.conditions(s, ctx.params.itemId), {
					headers: cacheFor(ctx, s.settings.mapping.cache_seconds),
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/condition-mappings/feed',
			...website('mapping'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const vocabulary = s.settings.vocabularies.find((v) => v.key === ctx.query.vocabulary);
				if (!vocabulary) return invalid([{ path: '/vocabulary', code: 'vocabulary_unknown' }]);
				const page = pageOf(ctx);
				const rows = await service.feedRows(s, vocabulary, {
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return pageResponse(
					page,
					rows,
					(row) => `${row.itemId}|${row.variantKey}`,
					(row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'variantKey')),
					{ 'cache-control': 'no-store' },
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/mapping/view',
			...website('mapping', 'pk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const context = pageContext(ctx.query);
				return ok(await stubViews.mapping(ctx, s, context), {
					...(context.itemId ? { headers: cacheFor(ctx, s.settings.mapping.cache_seconds) } : {}),
				});
			},
		}),

		// ── inspection ──────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/checklists',
			...website('inspection'),
			handler: async (ctx) => {
				const { settings } = await site(ctx);
				return ok({ items: settings.checklists.map(checklistView), nextCursor: null, hasMore: false });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/checklists/:key',
			...website('inspection'),
			handler: async (ctx) => {
				const checklist = (await site(ctx)).settings.checklists.find((entry) => entry.key === ctx.params.key);
				return checklist ? ok(checklistView(checklist)) : problem('not_found', 'No such checklist.');
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/inspections',
			...website('inspection'),
			handler: async (ctx) => {
				const unitId = queryId(ctx, 'filter[unitId]');
				if (!unitId.ok) return invalid([{ path: '/filter/unitId', code: 'id_invalid' }]);
				const status = ctx.query['filter[status]'];
				if (status !== undefined && status !== 'draft' && status !== 'completed')
					return invalid([{ path: '/filter/status', code: 'status_invalid' }]);
				const s = await site(ctx);
				const page = pageOf(ctx);
				const rows = await s.repos.inspections.list({
					unitId: unitId.value,
					status: status ?? null,
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return pageResponse(
					page,
					rows,
					(row) => `${row.startedAt}|${row.id}`,
					(row) => inspectionView(row),
					{
						'cache-control': 'no-store',
					},
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/inspections',
			...website('inspection'),
			handler: async (ctx) => {
				const problems = validateInspection(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.startInspection(await site(ctx), {
					unitId: ctx.body.unitId,
					checklist: ctx.body.checklist ?? null,
					results: ctx.body.results ?? [],
					inspector: ctx.body.inspector ?? null,
					complete: ctx.body.complete === true,
					tier: ctx.body.tier ?? null,
					key: ctx.idempotencyKey,
					actor: apiActor(ctx),
				});
				if (!result.ok) return failure(result);
				return created(result.inspection, { location: `/v1/inspections/${result.inspection.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/inspections/:id',
			...website('inspection'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const inspection = await s.repos.inspections.get(ctx.params.id);
				return inspection
					? ok(inspectionView(inspection, await s.repos.photos.forInspection(inspection.id)))
					: problem('not_found', 'No such inspection.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/inspections/:id',
			...website('inspection'),
			handler: async (ctx) => {
				const problems = validateInspectionPatch(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.updateInspection(await site(ctx), ctx.params.id, {
					...(ctx.body.results !== undefined ? { results: ctx.body.results } : {}),
					...(ctx.body.inspector !== undefined ? { inspector: ctx.body.inspector } : {}),
					complete: ctx.body.complete === true,
					tier: ctx.body.tier ?? null,
					actor: apiActor(ctx),
				});
				return result.ok ? ok(result.inspection) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/inspections/:id/photos',
			...website('inspection'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validatePhotoUpload(ctx.body, /** @type {any} */ (s.settings.inspection));
				if (problems.length > 0) return invalid(problems);
				const result = await service.photoUpload(s, ctx.params.id, {
					item: ctx.body.item,
					contentType: ctx.body.contentType,
					size: ctx.body.size,
					key: ctx.idempotencyKey,
				});
				return result.ok ? created(result.photo) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/units/:id/report-link',
			...website('inspection'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateReportLink(ctx.body, Number(s.settings.inspection.report_link_days));
				if (problems.length > 0) return invalid(problems);
				const result = await service.issueReportLink(s, ctx.params.id, { days: ctx.body?.days, actor: apiActor(ctx) });
				return result.ok ? created(result.link) : failure(result);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/units/:id/report-link',
			...website('inspection'),
			handler: async (ctx) =>
				(await service.revokeReportLink(await site(ctx), ctx.params.id, apiActor(ctx)))
					? noContent()
					: problem('not_found', 'No such unit.'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/inspection-reports/:token',
			...website('inspection', 'pk'),
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (ctx) => {
				const report = await service.report(await site(ctx), ctx.params.token);
				return report
					? ok(report, { headers: { 'cache-control': 'private, no-store' } })
					: problem('not_found', 'This report link is unknown, revoked or expired.');
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/inspection/view',
			...website('inspection', 'pk'),
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(await stubViews.inspection(ctx, s, pageContext(ctx.query)), {
					headers: { 'cache-control': 'private, no-store' },
				});
			},
		}),
		...stubActionRoutes,

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'tiers',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.overview(s)) : noWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/units/:id/tier',
			auth: 'launch',
			element: 'tiers',
			roles: [...DASHBOARD_WRITE_ROLES],
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const tier = ctx.body?.tier;
				if (tier !== null && !isKey(tier)) return invalid([{ path: '/tier', code: 'tier_invalid' }]);
				const result = await service.updateUnit(s, ctx.params.id, { tier }, dashboardActor(ctx.session), 'dashboard');
				return result.ok ? ok(result.unit) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/units/:id/report-link',
			auth: 'launch',
			element: 'inspection',
			roles: [...DASHBOARD_WRITE_ROLES],
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await service.issueReportLink(s, ctx.params.id, { actor: dashboardActor(ctx.session) });
				return result.ok ? created(result.link) : failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/conditions:check',
			auth: 'launch',
			idempotent: false,
			handler: (ctx) => {
				const source = ctx.body?.source;
				const kind = ctx.body?.kind;
				if (typeof source !== 'string' || source.length > 2000) return invalid([{ path: '/source', code: 'required' }]);
				if (!Object.hasOwn(RULE_ROOTS, kind)) return invalid([{ path: '/kind', code: 'kind_invalid' }]);
				return ok(checkCondition(source, kind));
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Grades} grades
 */
export const wireEvents = (grades) => {
	for (const [type, handler] of Object.entries(createEventHandlers(grades))) grades.product.events.on(type, handler);
	return grades;
};
