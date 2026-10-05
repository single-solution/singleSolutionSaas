/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise, the
 * .well-known endpoints, /sso and — in development — the certification probes) plus the After-sales Mode C API and the
 * dashboard API (SSO sessions). Every product route is gated by its element: a disabled element answers 403
 * element_disabled in every mode. POSTs that create or move state require an Idempotency-Key (app-kit stores and
 * replays the response); handlers are thin — validation and rules live in core/.
 *
 * Keys: `sk_` (the merchant's server) sees and changes everything; `pk_` (browsers, domain-locked) reads public data
 * and acts only for the customer it identifies — the website's own login token (`SS-Identity`, verified by app-kit) or
 * a signed claim token (guests, bound to one purchase, sent in the JSON body). A customer only ever sees their own
 * purchases, claims and messages.
 */
import { defineRoute, ok, created, paginate, problem, standardRoutes } from '@ss/app-kit';
import { checkCondition } from '../core/rules.js';
import { serialKey } from '../core/serials.js';
import { isId, isKey } from '../core/text.js';
import {
	validateAccess,
	validateAssign,
	validateClaim,
	validateMessage,
	validateNote,
	validatePhotoUpload,
	validatePurchase,
	validateRefund,
	validateRestock,
	validateSerial,
	validateTransition,
	validateView,
} from '../core/validate.js';
import {
	customerPurchaseView,
	formView,
	messageView,
	ownerPurchaseView,
	ownerSerialView,
	publicSerialView,
} from '../core/views.js';
import { repositoriesFor } from '../adapters/db.js';
import { DASHBOARD_WRITE_ROLES, dashboardActor } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createAftersalesService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').AftersalesApp} AftersalesApp */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Who} Who */

/** Seconds browsers may cache the claim form. */
const FORM_CACHE_SECONDS = 60;
/** Claims shown by the Loader element stub view. */
const STUB_CLAIMS = 5;

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
	if (result.reason === 'validation_failed' && result.errors) return invalid(result.errors);
	if (result.reason === 'identity_required')
		return problem('identity_required', "Send the customer's login token in the SS-Identity header (or a claim token).");
	return problem(result.reason, result.detail ?? result.reason.replace(/_/g, ' '), {
		...(result.errors ? { errors: result.errors.map((e) => ({ ...e, message: e.code.replace(/_/g, ' ') })) } : {}),
	});
};

/**
 * A query value as an id (null when absent or malformed).
 * @param {unknown} value
 */
const queryId = (value) => (isId(value) ? /** @type {string} */ (value) : null);

/**
 * The application (service + site resolution) shared by the routes, the event consumers and the dashboard.
 * @param {AftersalesApp} app
 */
export const createAftersales = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product);
	const service = createAftersalesService({
		publish: (event) => product.portal.publishEvent(event),
		recordUsage: (usage) => product.usage.record(usage),
		audit: (entry) => product.audit.record(entry),
		storage: (websiteId) => product.connectors.storage(websiteId),
		messaging: (websiteId) => product.connectors.messaging(websiteId),
		tokens: app.tokens,
		hash: app.hash,
		retention: app.retention,
		strings: app.strings,
		now: app.now,
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
	 * Site of a website from its entitlement (null without an active subscription, or with neither claims nor the
	 * serial registry on).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok) return null;
		if (!product.entitlements.can(result.doc, 'claims') && !product.entitlements.can(result.doc, 'serial_registry'))
			return null;
		return siteOf(websiteId, result.doc);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createAftersales>} Aftersales */

/**
 * @param {Aftersales} aftersales
 */
export const buildRoutes = (aftersales) => {
	const { product, service, siteOf, app } = aftersales;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/** @param {any} ctx */
	const isServer = (ctx) => ctx.website?.kind === 'sk';
	/**
	 * Route options: website key auth gated by an element; `null` key kind = browser-capable (identity optional).
	 * @param {string} element
	 * @param {'sk' | null} [keyKind]
	 */
	const website = (element, keyKind = 'sk') => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(keyKind ? { keyKind } : { identity: /** @type {const} */ ('optional') }),
	});
	/** @param {any} ctx */
	const apiActor = (ctx) => ({ type: 'api', id: ctx.website.keyId });
	/** Dashboard session → website and settings. @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? site(ctx) : null);
	const noWebsite = () => problem('bad_request', 'Open the dashboard for a website.');
	/** @param {any} ctx @param {string} element @param {string} feature @param {number} fallback */
	const rateOf = (ctx, element, feature, fallback) => {
		const value = product.entitlements.config(ctx.entitlement?.doc, element)?.[feature];
		return Number.isInteger(value) ? value : fallback;
	};

	/**
	 * Who asks: the server, a guest with a claim token, or the signed-in customer (null = a bad token or login token).
	 * @param {any} ctx
	 * @param {unknown} [token]
	 * @returns {Who | null}
	 */
	const whoOf = (ctx, token) => {
		if (isServer(ctx)) return { via: 'server' };
		if (typeof token === 'string') {
			const purchaseId = app.tokens.verify(token, ctx.websiteId);
			return purchaseId ? { via: 'token', purchaseId } : null;
		}
		if (ctx.identity?.subject) return { via: 'identity', subject: ctx.identity.subject };
		if (ctx.identityProblem && !['identity_missing', 'identity_not_configured'].includes(ctx.identityProblem)) return null;
		return { via: 'none' };
	};
	/** @param {any} ctx @param {unknown} [token] */
	const refusal = (ctx, token) =>
		typeof token === 'string'
			? problem('invalid_token', 'The claim link is invalid or expired.')
			: problem('identity_invalid', `The SS-Identity token was refused (${ctx.identityProblem}).`);

	/**
	 * A page of claims for the owner or one customer.
	 * @param {any} ctx
	 * @param {Site} s
	 * @param {{ owner: boolean, customerKey?: string, extra?: () => Promise<Record<string, unknown>> }} options
	 */
	const claimPage = async (ctx, s, { owner, customerKey, extra }) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
		const known = s.settings.vocabulary.statuses.map((status) => status.key);
		const statusFilter = ctx.query['filter[status]'];
		const statuses = typeof statusFilter === 'string' ? statusFilter.split(',') : undefined;
		if (statuses && !statuses.every((status) => known.includes(status)))
			return invalid([{ path: '/filter/status', code: 'status_invalid' }]);
		const type = ctx.query['filter[type]'];
		if (type !== undefined && !isKey(type)) return invalid([{ path: '/filter/type', code: 'invalid' }]);
		const rows = await s.repos.claims.list({
			...(statuses ? { statuses } : {}),
			...(type ? { type } : {}),
			...(owner && queryId(ctx.query['filter[purchaseId]']) ? { purchaseId: ctx.query['filter[purchaseId]'] } : {}),
			...(owner && typeof ctx.query['filter[assignee]'] === 'string' ? { assignee: ctx.query['filter[assignee]'] } : {}),
			...(owner && typeof ctx.query['filter[customerId]'] === 'string'
				? { customerKey: ctx.query['filter[customerId]'] }
				: {}),
			...(customerKey ? { customerKey } : {}),
			after: page.after,
			fetchLimit: page.fetchLimit,
			oldest: ctx.query.sort === 'oldest',
		});
		const views = await service.viewsFor(s);
		const body = page.page(rows, (/** @type {any} */ row) => [row.submittedAt, row.id]);
		const link = page.link(body.nextCursor);
		return ok(
			{
				...body,
				items: body.items.map((/** @type {any} */ row) => (owner ? views.owner(row) : views.customer(row))),
				...(extra ? await extra() : {}),
			},
			{ headers: { 'cache-control': 'no-store', ...(link ? { link } : {}) } },
		);
	};

	/**
	 * The guest view of a claim token: the purchase, its claims and (one claim's) messages.
	 * @param {Site} s
	 * @param {string} purchaseId
	 * @param {string | null} claimId
	 */
	const tokenView = async (s, purchaseId, claimId) => {
		const purchase = await s.repos.purchases.get(purchaseId);
		if (!purchase) return problem('invalid_token', 'The claim link is invalid or expired.');
		const claims = await s.repos.claims.forPurchase(purchase.id);
		const views = await service.viewsFor(s);
		const selected = claimId ? claims.find((/** @type {any} */ claim) => claim.id === claimId) : null;
		if (claimId && !selected) return problem('not_found', 'No such claim.');
		return ok(
			{
				purchase: customerPurchaseView(purchase, await service.eligibilityOf(s, purchase, claims)),
				claims: claims.map((/** @type {any} */ claim) => views.customer(claim)),
				...(selected && s.settings.messages
					? {
							messages: (await s.repos.messages.list(selected.id, { fetchLimit: 200 })).map((/** @type {any} */ m) =>
								messageView(m, false),
							),
						}
					: {}),
			},
			{ headers: { 'cache-control': 'no-store' } },
		);
	};

	// ── shared actions (Mode C and the dashboard) ──────────────────────────────────────────────────────────────

	/** @param {Site} s @param {string} id @param {unknown} body @param {{ type: string, id?: string }} actor */
	const transitionAction = async (s, id, body, actor) => {
		const { problems, value } = validateTransition(body, s.settings.queue.note_max_length);
		if (!value) return invalid(problems);
		const result = await service.transition(s, id, value, actor);
		return result.ok ? ok((await service.viewsFor(s)).owner(result.claim)) : failure(result);
	};
	/** @param {Site} s @param {string} id @param {unknown} body @param {{ type: string, id?: string }} actor @param {string} key */
	const noteAction = async (s, id, body, actor, key) => {
		const { problems, value } = validateNote(body, s.settings.queue.note_max_length);
		if (!value) return invalid(problems);
		const result = await service.addNote(s, id, value.body, actor, key);
		return result.ok ? created((await service.viewsFor(s)).owner(/** @type {any} */ (result).claim)) : failure(result);
	};
	/** @param {Site} s @param {string} id @param {unknown} body @param {{ type: string, id?: string }} actor */
	const assignAction = async (s, id, body, actor) => {
		const { problems, value } = validateAssign(body);
		if (!value) return invalid(problems);
		const result = await service.assign(s, id, value.assignee, actor);
		return result.ok ? ok((await service.viewsFor(s)).owner(/** @type {any} */ (result).claim)) : failure(result);
	};
	/** @param {Site} s @param {unknown} body @param {{ type: string, id?: string }} actor @param {string} key */
	const refundAction = async (s, body, actor, key) => {
		const { problems, value } = validateRefund(body);
		if (!value) return invalid(problems);
		const result = await service.refund(s, value, actor, key);
		return result.ok
			? created({ refund: result.refund, claim: (await service.viewsFor(s)).owner(result.claim) })
			: failure(result);
	};
	/** @param {Site} s @param {unknown} body @param {{ type: string, id?: string }} actor */
	const restockAction = async (s, body, actor) => {
		const { problems, value } = validateRestock(body);
		if (!value) return invalid(problems);
		const result = await service.restock(s, value, actor);
		return result.ok
			? ok({ results: result.results, claim: (await service.viewsFor(s)).owner(result.claim) })
			: failure(result);
	};
	/** @param {Site} s @param {unknown} body @param {Who} who @param {{ type: string, id?: string }} actor @param {string} key */
	const messageAction = async (s, body, who, actor, key) => {
		const config = /** @type {Record<string, any>} */ (s.settings.messages);
		const { problems, value } = validateMessage(body, config.max_length);
		if (!value) return invalid(problems);
		const result = await service.postMessage(s, value, who, { actor, key });
		return result.ok ? created(messageView(result.message, who.via === 'server')) : failure(result);
	};

	/**
	 * Dashboard action routes (element-gated, write roles only).
	 * @param {string} action
	 * @param {string} element
	 * @param {(s: Site, ctx: any, actor: { type: string, id: string }) => Promise<any>} run
	 */
	const dashboardRoute = (action, element, run) =>
		defineRoute({
			method: 'POST',
			path: `/v1/dashboard/claims/:id/${action}`,
			auth: 'launch',
			element,
			roles: [...DASHBOARD_WRITE_ROLES],
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? run(s, ctx, dashboardActor(ctx.session)) : noWebsite();
			},
		});

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── claims: form, purchases, access, claims ─────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/claim-form',
			...website('claims', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const { vocabulary, claims, photos, messages } = s.settings;
				return ok(formView({ types: vocabulary.types, reasons: vocabulary.reasons, claims, photos, messages }), {
					headers: {
						'cache-control': isServer(ctx) ? 'no-store' : `public, max-age=${FORM_CACHE_SECONDS}`,
					},
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/claim-form:check',
			...website('claims'),
			idempotent: false,
			handler: async (ctx) =>
				typeof ctx.body?.when === 'string'
					? ok(checkCondition(ctx.body.when))
					: invalid([{ path: '/when', code: 'required' }]),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/purchases',
			...website('claims'),
			handler: async (ctx) => {
				const { problems, value } = validatePurchase(ctx.body);
				if (!value) return invalid(problems);
				const s = await site(ctx);
				const result = await service.createPurchase(s, value, ctx.idempotencyKey);
				const view = ownerPurchaseView(result.purchase, await service.eligibilityOf(s, result.purchase));
				return result.created ? created(view, { location: `/v1/purchases/${result.purchase.id}` }) : ok(view);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/purchases',
			...website('claims', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = whoOf(ctx);
				if (!who) return refusal(ctx);
				if (who.via === 'none' || who.via === 'token') return failure({ reason: 'identity_required' });
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const rows = await s.repos.purchases.list({
					...(who.via === 'identity' ? { customerKey: who.subject } : {}),
					...(who.via === 'server' && typeof ctx.query['filter[customerId]'] === 'string'
						? { customerKey: ctx.query['filter[customerId]'] }
						: {}),
					...(who.via === 'server' && queryId(ctx.query['filter[orderId]'])
						? { orderId: ctx.query['filter[orderId]'] }
						: {}),
					after: page.after,
					fetchLimit: page.fetchLimit,
				});
				const body = page.page(rows, (/** @type {any} */ row) => [row.placedAt, row.id]);
				const items = await Promise.all(
					body.items.map(async (/** @type {any} */ row) => {
						const eligibility = await service.eligibilityOf(s, row);
						return who.via === 'server' ? ownerPurchaseView(row, eligibility) : customerPurchaseView(row, eligibility);
					}),
				);
				const link = page.link(body.nextCursor);
				return ok({ ...body, items }, { headers: { 'cache-control': 'no-store', ...(link ? { link } : {}) } });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/purchases/:id',
			...website('claims', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = whoOf(ctx);
				if (!who) return refusal(ctx);
				if (who.via === 'none' || who.via === 'token') return failure({ reason: 'identity_required' });
				const purchase = await s.repos.purchases.get(ctx.params.id);
				if (!service.owns(purchase, who)) return problem('not_found', 'No such purchase.');
				const eligibility = await service.eligibilityOf(s, purchase);
				return ok(
					who.via === 'server' ? ownerPurchaseView(purchase, eligibility) : customerPurchaseView(purchase, eligibility),
					{
						headers: { 'cache-control': 'no-store' },
					},
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/claim-access',
			...website('claims', null),
			idempotent: false,
			rateLimit: { limit: 10, windowMs: 60_000 },
			handler: async (ctx) => {
				const { problems, value } = validateAccess(ctx.body);
				if (!value) return invalid(problems);
				const result = await service.access(await site(ctx), value);
				return result.ok
					? ok(
							{ token: result.token, expiresAt: result.expiresAt, purchaseId: result.purchaseId },
							{ headers: { 'cache-control': 'no-store' } },
						)
					: failure(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/claims',
			...website('claims', null),
			rateLimit: { limit: (ctx) => rateOf(ctx, 'claims', 'create_rate_per_minute', 30), windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				const { problems, value } = validateClaim(ctx.body, {
					detailsMax: s.settings.claims.details_max_length,
					linesMax: s.settings.claims.max_lines_per_claim,
				});
				if (!value) return invalid(problems);
				const who = whoOf(ctx, value.token ?? undefined);
				if (!who) return refusal(ctx, value.token ?? undefined);
				if (who.via === 'none') return failure({ reason: 'identity_required' });
				const result = await service.submit(s, { value, who, key: ctx.idempotencyKey });
				if (!result.ok) return failure(result);
				const views = await service.viewsFor(s);
				const body = who.via === 'server' ? views.owner(result.claim) : views.customer(result.claim);
				return created(body, { location: `/v1/claims/${result.claim.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/claims',
			...website('claims', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = whoOf(ctx);
				if (!who) return refusal(ctx);
				if (who.via === 'server') return claimPage(ctx, s, { owner: true });
				if (who.via === 'identity') return claimPage(ctx, s, { owner: false, customerKey: who.subject });
				return failure({ reason: 'identity_required' });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/claims:view',
			...website('claims', null),
			idempotent: false,
			handler: async (ctx) => {
				const { problems, value } = validateView(ctx.body);
				if (!value) return invalid(problems);
				const purchaseId = app.tokens.verify(value.token, ctx.websiteId);
				if (!purchaseId) return problem('invalid_token', 'The claim link is invalid or expired.');
				return tokenView(await site(ctx), purchaseId, value.claimId);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/claims/:id',
			...website('claims', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = whoOf(ctx);
				if (!who) return refusal(ctx);
				if (who.via === 'none' || who.via === 'token') return failure({ reason: 'identity_required' });
				const claim = await service.claimFor(s, ctx.params.id, who);
				if (!claim) return problem('not_found', 'No such claim.');
				const views = await service.viewsFor(s);
				return ok(who.via === 'server' ? views.owner(claim) : views.customer(claim), {
					headers: { 'cache-control': 'no-store' },
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/claims/view',
			...website('claims', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const t = { ...(app.strings.en ?? {}) };
				const who = whoOf(ctx);
				const rows =
					who?.via === 'identity' ? await s.repos.claims.list({ customerKey: who.subject, fetchLimit: STUB_CLAIMS }) : [];
				const views = await service.viewsFor(s);
				return ok(
					{
						title: t['claims.title'] ?? '',
						body:
							who?.via === 'identity' ? (rows.length === 0 ? (t['claims.empty'] ?? '') : '') : (t['claims.sign_in'] ?? ''),
						items: rows.map((/** @type {any} */ row) => {
							const view = views.customer(row);
							return { text: `${view.reference} · ${view.typeLabel} · ${view.statusLabel}`.slice(0, 500) };
						}),
					},
					{ headers: { 'cache-control': 'no-store' } },
				);
			},
		}),

		// ── photos ──────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/claim-photos',
			...website('photos', null),
			rateLimit: { limit: 60, windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				const config = /** @type {Record<string, any>} */ (s.settings.photos);
				const { problems, value } = validatePhotoUpload(ctx.body, {
					allowedTypes: config.allowed_types,
					maxBytes: config.max_photo_bytes,
				});
				if (!value) return invalid(problems);
				const who = whoOf(ctx, value.token ?? undefined);
				if (!who) return refusal(ctx, value.token ?? undefined);
				if (who.via === 'none') return failure({ reason: 'identity_required' });
				const owner =
					who.via === 'server'
						? 'server'
						: who.via === 'identity'
							? `customer:${who.subject}`
							: `purchase:${who.purchaseId}`;
				const result = await service.createUpload(s, {
					contentType: value.contentType,
					size: value.size,
					owner,
					key: ctx.idempotencyKey,
				});
				return result.ok ? created(result.photo) : failure(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/claim-photos/:id',
			...website('photos'),
			handler: async (ctx) => {
				const photo = await (await site(ctx)).repos.photos.get(ctx.params.id);
				return photo
					? ok({
							id: photo.id,
							status: photo.status,
							claimId: photo.claimId ?? null,
							contentType: photo.contentType,
							size: photo.size,
						})
					: problem('not_found', 'No such photo.');
			},
		}),

		// ── queue ───────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/queue',
			...website('queue'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return claimPage(ctx, s, { owner: true, extra: async () => ({ counts: await service.overview(s) }) });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/queue/:id/transition',
			...website('queue'),
			idempotent: 'optional',
			handler: async (ctx) => transitionAction(await site(ctx), ctx.params.id, ctx.body, apiActor(ctx)),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/queue/:id/notes',
			...website('queue'),
			handler: async (ctx) => noteAction(await site(ctx), ctx.params.id, ctx.body, apiActor(ctx), ctx.idempotencyKey),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/queue/:id/assign',
			...website('queue'),
			idempotent: 'optional',
			handler: async (ctx) => assignAction(await site(ctx), ctx.params.id, ctx.body, apiActor(ctx)),
		}),

		// ── refunds ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/refunds',
			...website('refunds'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const rows = await s.repos.refunds.list({
					...(queryId(ctx.query['filter[claimId]']) ? { claimId: ctx.query['filter[claimId]'] } : {}),
					after: page.after,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(rows, (/** @type {any} */ row) => [row.at, row.id]);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/refunds',
			...website('refunds'),
			handler: async (ctx) => refundAction(await site(ctx), ctx.body, apiActor(ctx), ctx.idempotencyKey),
		}),

		// ── restock ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/restocks',
			...website('restock'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const rows = await s.repos.restocks.list({
					...(queryId(ctx.query['filter[claimId]']) ? { claimId: ctx.query['filter[claimId]'] } : {}),
					after: page.after,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(rows, (/** @type {any} */ row) => [row.at, row.id]);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/restocks',
			...website('restock'),
			idempotent: 'optional',
			handler: async (ctx) => restockAction(await site(ctx), ctx.body, apiActor(ctx)),
		}),

		// ── serial registry ─────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/serials',
			...website('serial_registry'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const rows = await s.repos.serials.list({
					...(queryId(ctx.query['filter[orderId]']) ? { orderId: ctx.query['filter[orderId]'] } : {}),
					...(queryId(ctx.query['filter[itemId]']) ? { itemId: ctx.query['filter[itemId]'] } : {}),
					after: page.after,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(rows, (/** @type {any} */ row) => [row.registeredAt, row.id]);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/serials',
			...website('serial_registry'),
			handler: async (ctx) => {
				const { problems, value } = validateSerial(ctx.body);
				if (!value) return invalid(problems);
				const result = await service.registerSerial(await site(ctx), value);
				return result.ok ? created(result.serial) : failure(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/serials/:serial',
			...website('serial_registry', null),
			rateLimit: {
				limit: (ctx) => (isServer(ctx) ? Infinity : rateOf(ctx, 'serial_registry', 'lookup_rate_per_minute', 60)),
				windowMs: 60_000,
			},
			handler: async (ctx) => {
				const s = await site(ctx);
				if (!isServer(ctx) && !s.settings.serials.public_lookup)
					return problem('lookup_disabled', 'The public lookup is off.');
				const result = await service.lookupSerial(s, ctx.params.serial);
				if (!result.ok) return failure(result);
				const { types } = s.settings.vocabulary;
				return ok(
					isServer(ctx)
						? ownerSerialView({ serial: result.serial, entry: result.entry, types, claims: result.claims })
						: publicSerialView({
								serial: result.serial,
								entry: result.entry,
								types,
								showSaleDate: s.settings.serials.show_sale_date,
							}),
					{ headers: { 'cache-control': 'no-store' } },
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/serial_registry/view',
			...website('serial_registry', null),
			handler: async () => {
				const t = { ...(app.strings.en ?? {}) };
				return ok(
					{
						title: t['serials.title'] ?? '',
						body: t['serials.intro'] ?? '',
						items: [],
						actions: [{ action: 'lookup', label: t['serials.lookup'] ?? '' }],
					},
					{ headers: { 'cache-control': 'public, max-age=300' } },
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/elements/serial_registry/actions/lookup',
			...website('serial_registry', null),
			idempotent: false,
			rateLimit: {
				limit: (ctx) => rateOf(ctx, 'serial_registry', 'lookup_rate_per_minute', 60),
				windowMs: 60_000,
				bucket: 'serial-lookup',
			},
			handler: async (ctx) => {
				const s = await site(ctx);
				const t = { ...(app.strings.en ?? {}) };
				if (!s.settings.serials.public_lookup) return problem('lookup_disabled', 'The public lookup is off.');
				const raw = ctx.body?.fields?.serial;
				if (typeof raw !== 'string' || serialKey(raw, /** @type {any} */ (s.settings.serials)) === null)
					return invalid([{ path: '/fields/serial', code: 'serial_invalid' }]);
				const result = await service.lookupSerial(s, raw);
				if (!result.ok) return ok({ title: t['serials.title'] ?? '', body: t['serials.not_found'] ?? '', items: [] });
				const view = publicSerialView({
					serial: result.serial,
					entry: result.entry,
					types: s.settings.vocabulary.types,
					showSaleDate: s.settings.serials.show_sale_date,
				});
				return ok({
					title: view.title ?? view.serial,
					body: view.soldAt ? (t['serials.sold_on'] ?? '').replace('{date}', view.soldAt.slice(0, 10)) : '',
					items: view.cover.map((cover) => ({
						text: (cover.active ? (t['serials.cover.active'] ?? '') : (t['serials.cover.ended'] ?? ''))
							.replace('{type}', cover.label)
							.replace('{date}', (cover.endsAt ?? '').slice(0, 10)),
					})),
				});
			},
		}),

		// ── messages ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/messages',
			...website('messages', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const who = whoOf(ctx);
				if (!who) return refusal(ctx);
				if (who.via === 'none' || who.via === 'token') return failure({ reason: 'identity_required' });
				const claimId = queryId(ctx.query['filter[claimId]']);
				if (!claimId) return invalid([{ path: '/filter/claimId', code: 'required' }]);
				const claim = await service.claimFor(s, claimId, who);
				if (!claim) return problem('not_found', 'No such claim.');
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 50, maxLimit: 200 },
				);
				const rows = await s.repos.messages.list(claim.id, { after: page.after, fetchLimit: page.fetchLimit });
				const body = page.page(rows, (/** @type {any} */ row) => [row.at, row.id]);
				const link = page.link(body.nextCursor);
				return ok(
					{ ...body, items: body.items.map((/** @type {any} */ row) => messageView(row, who.via === 'server')) },
					{ headers: { 'cache-control': 'no-store', ...(link ? { link } : {}) } },
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages',
			...website('messages', null),
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				const token = typeof ctx.body?.token === 'string' ? ctx.body.token : undefined;
				const who = whoOf(ctx, token);
				if (!who) return refusal(ctx, token);
				if (who.via === 'none') return failure({ reason: 'identity_required' });
				const actor = who.via === 'server' ? apiActor(ctx) : { type: 'customer' };
				return messageAction(s, ctx.body, who, actor, ctx.idempotencyKey);
			},
		}),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'claims',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.overview(s)) : noWebsite();
			},
		}),
		dashboardRoute('transition', 'queue', (s, ctx, actor) => transitionAction(s, ctx.params.id, ctx.body, actor)),
		dashboardRoute('notes', 'queue', (s, ctx, actor) =>
			noteAction(
				s,
				ctx.params.id,
				ctx.body,
				actor,
				ctx.idempotencyKey ?? service.idFor(s.websiteId, 'dsh', `${ctx.requestId}`),
			),
		),
		dashboardRoute('assign', 'queue', (s, ctx, actor) => assignAction(s, ctx.params.id, ctx.body, actor)),
		dashboardRoute('refunds', 'refunds', (s, ctx, actor) =>
			refundAction(s, { ...ctx.body, claimId: ctx.params.id }, actor, ctx.idempotencyKey ?? `${ctx.requestId}`),
		),
		dashboardRoute('restocks', 'restock', (s, ctx, actor) => restockAction(s, { ...ctx.body, claimId: ctx.params.id }, actor)),
		dashboardRoute('messages', 'messages', (s, ctx, actor) =>
			messageAction(
				s,
				{ ...ctx.body, claimId: ctx.params.id },
				{ via: 'server' },
				actor,
				ctx.idempotencyKey ?? `${ctx.requestId}`,
			),
		),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Aftersales} aftersales
 */
export const wireEvents = (aftersales) => {
	for (const [type, handler] of Object.entries(createEventHandlers(aftersales))) aftersales.product.events.on(type, handler);
	return aftersales;
};
