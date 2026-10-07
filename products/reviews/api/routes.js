/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Reviews Mode C API and the
 * dashboard API (SSO sessions). Nothing runs on a timer: review requests are sent when an order completes (and on
 * demand), stale photo slots are swept on the website's next upload (and on demand).
 * Every product route is gated by its element: a disabled element answers 403 element_disabled in every mode. POSTs
 * that create or move state require an Idempotency-Key (app-kit stores and replays the response); handlers are thin —
 * validation and rules live in core/.
 *
 * Keys: `sk_` (the merchant's server) sees and changes everything; `pk_` (browsers, domain-locked) reads public data
 * only and identifies the customer with the website's own login token (`SS-Identity`, verified by app-kit) or a signed
 * review link token.
 */
import { defineRoute, ok, created, paginate, problem, standardRoutes } from '@ss/app-kit';
import { decide, moderationContext } from '../core/moderation.js';
import { orderFacts } from '../core/orders.js';
import { checkCondition } from '../core/rules.js';
import { afterFilter, cursorOf, pickSort, sortSpec } from '../core/sort.js';
import {
	idCheck,
	isObject,
	validateAnswer,
	validateApprove,
	validateImport,
	validateModerationCheck,
	validatePhotoUpload,
	validateQuestion,
	validateReject,
	validateReply,
	validateRequestInput,
	validateReview,
	validateToken,
} from '../core/validate.js';
import { formView } from '../core/views.js';
import { repositoriesFor } from '../adapters/db.js';
import { DASHBOARD_WRITE_ROLES, dashboardActor } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createReviewsService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').ReviewsApp} ReviewsApp */
/** @typedef {import('./service.js').Site} Site */

/** Largest CSV import body (bytes); rows are bounded by `import.max_rows`. */
const IMPORT_MAX_BYTES = 3_900_000; // under the 4.5 MB request body limit of serverless hosts
/** Items per `GET /v1/ratings?itemIds=` batch. */
const MAX_BATCH_ITEMS = 100;
/** Reviews shown by the Loader element stub view. */
const STUB_REVIEWS = 5;

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
	if (result.errors) return invalid(result.errors);
	if (result.reason === 'not_found') return problem('not_found', result.detail ?? 'Not found.');
	if (result.reason === 'identity_required')
		return problem('identity_required', "Send the customer's login token in the SS-Identity header (or a review link token).");
	return problem(result.reason, result.detail ?? result.reason.replace(/_/g, ' '));
};

/**
 * A query value as an id (null when absent or malformed).
 * @param {unknown} value
 */
const queryId = (value) => (typeof value === 'string' && idCheck(value) === null ? value : null);

/**
 * `true` / `false` query flags.
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
const queryFlag = (value) => (value === 'true' ? true : value === 'false' ? false : undefined);

/**
 * Statuses from `filter[status]` (comma-separated; `all` = every status).
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {readonly string[] | undefined} fallback
 * @returns {string[] | undefined | null} null when malformed
 */
const statusesOf = (value, allowed, fallback) => {
	if (value === undefined) return fallback ? [...fallback] : undefined;
	if (value === 'all') return undefined;
	const list = String(value).split(',');
	return list.every((status) => allowed.includes(status)) ? list : null;
};

/**
 * The application (service + site resolution) shared by the routes, the event consumers and the dashboard.
 * @param {ReviewsApp} app
 */
export const createReviews = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const service = createReviewsService({
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
	 * Site of a website from its entitlement (null without an active subscription or with the base element off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'collection')) return null;
		return siteOf(websiteId, result.doc);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createReviews>} Reviews */

/**
 * @param {Reviews} reviews
 */
export const buildRoutes = (reviews) => {
	const { product, service, siteOf } = reviews;
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
	/**
	 * Public cache headers for `pk_` reads of public data.
	 * @param {any} ctx
	 * @param {number} seconds
	 */
	const cacheFor = (ctx, seconds) =>
		isServer(ctx) ? { 'cache-control': 'no-store' } : { 'cache-control': `public, max-age=${seconds}` };
	/** Dashboard session → website and settings (null = pick a website / demo). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? site(ctx) : null);
	const noWebsite = () => problem('bad_request', 'Open the dashboard for a website.');

	/**
	 * A page of reviews (public for `pk_`, owner views for `sk_` and the dashboard).
	 * @param {any} ctx
	 * @param {Site} s
	 * @param {{ owner: boolean, statuses?: string[], extra?: () => Promise<Record<string, unknown>> }} options `extra`: more
	 *   body fields (e.g. moderation counts)
	 */
	const reviewPage = async (ctx, s, { owner, statuses, extra }) => {
		const { display } = s.settings;
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
			owner ? {} : { defaultLimit: display.page_size, maxLimit: 50 },
		);
		const sort = owner
			? pickSort(ctx.query.sort, { sorts: ['newest', 'oldest', 'rating_high', 'rating_low'], fallback: 'newest' })
			: pickSort(ctx.query.sort, { sorts: display.sorts, fallback: display.default_sort });
		const spec = sortSpec(sort);
		const rating = ctx.query['filter[rating]'] === undefined ? undefined : Number(ctx.query['filter[rating]']);
		if (rating !== undefined && !Number.isInteger(rating)) return invalid([{ path: '/filter/rating', code: 'rating_invalid' }]);
		const itemId = queryId(ctx.query['filter[itemId]']);
		if (ctx.query['filter[itemId]'] !== undefined && !itemId) return invalid([{ path: '/filter/itemId', code: 'id_invalid' }]);
		const after = page.after === null ? null : afterFilter(spec, page.after);
		if (page.after !== null && !after) return problem('bad_request', 'The cursor does not match this order.');
		const customerId =
			owner && typeof ctx.query['filter[customerId]'] === 'string' ? ctx.query['filter[customerId]'] : undefined;
		const items = await s.repos.reviews.list({
			filter: {
				...(itemId ? { itemId } : {}),
				.../** @type {any} */ (statuses ? { statuses } : {}),
				...(rating !== undefined ? { rating } : {}),
				...(queryFlag(ctx.query['filter[verified]']) !== undefined
					? { verified: queryFlag(ctx.query['filter[verified]']) }
					: {}),
				...(queryFlag(ctx.query['filter[photos]']) !== undefined
					? { withPhotos: queryFlag(ctx.query['filter[photos]']) }
					: {}),
				...(customerId ? { customerId } : {}),
			},
			sort: Object.fromEntries(spec),
			after,
			fetchLimit: page.fetchLimit,
		});
		const views = await service.viewsFor(s);
		const body = page.page(items, (/** @type {any} */ item) => cursorOf(item, spec));
		const include = String(ctx.query.include ?? '').split(',');
		return ok(
			{
				...body,
				items: body.items.map((/** @type {any} */ item) => (owner ? views.owner(item) : views.public(item))),
				sort,
				...(include.includes('summary') && itemId ? { summary: await service.summary(s, itemId) } : {}),
				...(extra ? await extra() : {}),
			},
			{
				headers: {
					...cacheFor(ctx, display.cache_seconds),
					...(page.link(body.nextCursor) ? { link: /** @type {string} */ (page.link(body.nextCursor)) } : {}),
				},
			},
		);
	};

	/**
	 * Who submits from a request: the merchant's server, the federated customer, a review link, or a guest.
	 * @param {any} ctx
	 * @returns {{ via: 'server' | 'identity' | 'token' | 'guest', customerId: string | null }}
	 */
	const submitterOf = (ctx) => {
		if (isServer(ctx)) return { via: 'server', customerId: null };
		if (isObject(ctx.body) && typeof ctx.body.token === 'string') return { via: 'token', customerId: null };
		if (ctx.identity?.subject) return { via: 'identity', customerId: ctx.identity.subject };
		return { via: 'guest', customerId: null };
	};

	/**
	 * A moderation action on a review (shared by Mode C and the dashboard).
	 * @param {Site} s
	 * @param {string} id
	 * @param {'approve' | 'reject' | 'reply' | 'unreply'} action
	 * @param {unknown} body
	 * @param {{ type: string, id?: string }} actor
	 */
	const moderate = async (s, id, action, body, actor) => {
		const moderation = /** @type {import('../core/moderation.js').ModerationSettings} */ (s.settings.moderation);
		/** @type {any} */
		let result;
		if (action === 'approve') {
			const problems = validateApprove(body);
			if (problems.length > 0) return invalid(problems);
			result = await service.approve(s, id, { actor, note: /** @type {any} */ (body)?.note ?? null });
		} else if (action === 'reject') {
			const problems = validateReject(body, moderation.rejection_reasons);
			if (problems.length > 0) return invalid(problems);
			const input = /** @type {{ reason: string, note?: string }} */ (body);
			result = await service.reject(s, id, { actor, reason: input.reason, note: input.note ?? null });
		} else if (action === 'reply') {
			const problems = validateReply(body, moderation.reply_max_length);
			if (problems.length > 0) return invalid(problems);
			result = await service.reply(s, id, { actor, body: /** @type {{ body: string }} */ (body).body });
		} else result = await service.reply(s, id, { actor, body: null });
		if (!result.ok) return failure(result);
		return ok((await service.viewsFor(s)).owner(result.review));
	};

	/**
	 * A question decision (shared by Mode C and the dashboard).
	 * @param {Site} s
	 * @param {any} params
	 * @param {'published' | 'rejected'} decision
	 * @param {{ type: string, id?: string }} actor
	 */
	const decideQuestion = async (s, params, decision, actor) => {
		const result = await service.decideQuestion(s, {
			questionId: params.id,
			answerId: params.answerId ?? null,
			decision,
			actor,
		});
		return result.ok ? ok((await service.viewsFor(s)).question(result.question, true)) : failure(result);
	};

	/**
	 * Answer a question as the merchant or a customer.
	 * @param {any} ctx
	 * @param {Site} s
	 * @param {{ merchant: boolean, customerId: string | null }} who
	 */
	const answerQuestion = async (ctx, s, who) => {
		const problems = validateAnswer(ctx.body, { maxLength: s.settings.qna.answer_max_length, server: false });
		if (problems.length > 0) return invalid(problems);
		const result = await service.answer(s, ctx.params.id, {
			body: ctx.body.body,
			author: ctx.body.author ?? null,
			customerId: who.customerId,
			merchant: who.merchant,
			key: ctx.idempotencyKey,
		});
		return result.ok ? created((await service.viewsFor(s)).question(result.question, who.merchant)) : failure(result);
	};

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── collection: reviews ─────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/reviews',
			...website('collection', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (isServer(ctx)) {
					const statuses = statusesOf(ctx.query['filter[status]'], ['pending', 'approved', 'rejected'], undefined);
					if (statuses === null) return invalid([{ path: '/filter/status', code: 'status_invalid' }]);
					return reviewPage(ctx, s, { owner: true, ...(statuses ? { statuses } : {}) });
				}
				if (!s.settings.enabled('display'))
					return problem('element_disabled', 'Public review lists need the display element.');
				return reviewPage(ctx, s, { owner: false, statuses: ['approved'] });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/reviews',
			...website('collection', null),
			rateLimit: { limit: 60, windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				const server = isServer(ctx);
				const { problems, value } = validateReview(ctx.body, {
					content: s.settings.content,
					maxPhotos: s.settings.photos?.max_photos_per_review ?? null,
					server,
				});
				if (!value) return invalid(problems);
				const result = await service.submit(s, { value, submitter: submitterOf(ctx), key: ctx.idempotencyKey });
				if (!result.ok) return failure(result);
				const views = await service.viewsFor(s);
				const body = server ? views.owner(result.review) : { ...views.public(result.review), status: result.review.status };
				return created(body, { location: `/v1/reviews/${result.review.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/reviews/:id',
			...website('collection', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const review = await s.repos.reviews.get(ctx.params.id);
				const views = await service.viewsFor(s);
				if (isServer(ctx)) return review ? ok(views.owner(review)) : problem('not_found', 'No such review.');
				if (!review || review.status !== 'approved' || review.deletedAt || !s.settings.enabled('display'))
					return problem('not_found', 'No such review.');
				return ok(views.public(review), { headers: cacheFor(ctx, s.settings.display.cache_seconds) });
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/reviews/:id',
			...website('collection'),
			handler: async (ctx) => {
				const result = await service.remove(await site(ctx), ctx.params.id, apiActor(ctx));
				return result.ok ? ok({ id: ctx.params.id, deleted: true }) : failure(result);
			},
		}),

		// ── collection: review requests ─────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/review-requests',
			...website('collection', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const statuses = statusesOf(
					ctx.query['filter[status]'],
					['open', 'completed', 'expired', 'cancelled'],
					isServer(ctx) ? undefined : ['open'],
				);
				if (statuses === null) return invalid([{ path: '/filter/status', code: 'status_invalid' }]);
				const customerId = isServer(ctx) ? ctx.query['filter[customerId]'] : ctx.identity?.subject;
				if (!isServer(ctx) && !customerId) return failure({ reason: 'identity_required' });
				const query = { ...(statuses ? { statuses } : {}), after: page.after, fetchLimit: page.fetchLimit };
				const items = customerId
					? await s.repos.requests.forCustomer([customerId], query)
					: await s.repos.requests.list(query);
				const views = await service.viewsFor(s);
				const body = page.page(items, (/** @type {any} */ request) => `${request.completedAt}|${request.id}`);
				const link = page.link(body.nextCursor);
				return ok(
					{ ...body, items: body.items.map((/** @type {any} */ request) => views.request(request, isServer(ctx))) },
					{ headers: link ? { link } : {} },
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/review-requests',
			...website('collection'),
			handler: async (ctx) => {
				const problems = validateRequestInput(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const completedAt = ctx.body.completedAt ? Date.parse(ctx.body.completedAt) : service.now();
				const result = await service.createRequest(s, orderFacts(ctx.body), {
					completedAt,
					locale: ctx.body.locale ?? null,
					source: 'api',
				});
				if (!result.ok) return failure(result);
				const view = (await service.viewsFor(s)).request(result.request, true);
				return result.created ? created(view, { location: `/v1/review-requests/${result.request.id}` }) : ok(view);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/review-requests:open',
			...website('collection', null),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateToken(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const opened = await service.openRequest(s, ctx.body.token);
				return opened ? ok({ ...opened.request, contactName: opened.contactName }) : failure({ reason: 'invalid_token' });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/review-requests/:id',
			...website('collection'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const request = await s.repos.requests.get(ctx.params.id);
				return request ? ok((await service.viewsFor(s)).request(request, true)) : problem('not_found', 'No such request.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/review-requests/:id/link',
			...website('collection'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const request = await s.repos.requests.get(ctx.params.id);
				return request ? ok(service.linkFor(s, request)) : problem('not_found', 'No such request.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/review-requests/:id/cancel',
			...website('collection'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const changed = await s.repos.requests.update(
					ctx.params.id,
					{ status: 'cancelled', 'delivery.state': 'done', 'delivery.nextAt': null },
					['open'],
				);
				const request = await s.repos.requests.get(ctx.params.id);
				if (!request) return problem('not_found', 'No such request.');
				if (!changed && request.status !== 'cancelled') return failure({ reason: 'request_closed' });
				return ok((await service.viewsFor(s)).request(request, true));
			},
		}),

		// ── request_flow ────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/request-flow',
			...website('request_flow'),
			handler: async (ctx) => ok(await service.flowStatus(await site(ctx))),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/request-flow:run',
			...website('request_flow'),
			idempotent: 'optional',
			handler: async (ctx) => ok(await service.runRequests(await site(ctx))),
		}),

		// ── moderation ──────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/moderation',
			...website('moderation'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const statuses = statusesOf(ctx.query['filter[status]'], ['pending', 'approved', 'rejected'], ['pending']);
				if (statuses === null) return invalid([{ path: '/filter/status', code: 'status_invalid' }]);
				return reviewPage(ctx, s, {
					owner: true,
					...(statuses ? { statuses } : {}),
					extra: async () => ({ counts: await s.repos.reviews.countByStatus() }),
				});
			},
		}),
		.../** @type {const} */ (['approve', 'reject', 'reply']).map((action) =>
			defineRoute({
				method: 'POST',
				path: `/v1/moderation/:id/${action}`,
				...website('moderation'),
				idempotent: 'optional',
				handler: async (ctx) => moderate(await site(ctx), ctx.params.id, action, ctx.body, apiActor(ctx)),
			}),
		),
		defineRoute({
			method: 'DELETE',
			path: '/v1/moderation/:id/reply',
			...website('moderation'),
			handler: async (ctx) => moderate(await site(ctx), ctx.params.id, 'unreply', null, apiActor(ctx)),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/moderation:check',
			...website('moderation'),
			idempotent: false,
			handler: async (ctx) => {
				const problems = validateModerationCheck(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const s = await site(ctx);
				const sample = ctx.body.review;
				const submission = sample
					? {
							rating: Number.isInteger(sample.rating) ? sample.rating : s.settings.content.rating_scale,
							title: typeof sample.title === 'string' ? sample.title : null,
							body: typeof sample.body === 'string' ? sample.body : null,
							verified: sample.verified === true,
							photos: Number.isInteger(sample.photos) ? sample.photos : 0,
						}
					: null;
				return ok({
					condition: typeof ctx.body.source === 'string' ? checkCondition(ctx.body.source) : null,
					decision: submission
						? decide({
								review: submission,
								settings: s.settings.moderation,
								context: moderationContext({
									review: { ...submission, itemId: 'sample', scale: s.settings.content.rating_scale },
									flags: [],
								}),
								now: service.now(),
								timeZone: s.settings.timeZone,
							})
						: null,
				});
			},
		}),

		// ── content ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/review-form',
			...website('content', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok(formView(s.settings.content, s.settings.photos), {
					headers: cacheFor(ctx, s.settings.display.cache_seconds),
				});
			},
		}),

		// ── photos ──────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/review-photos',
			...website('photos', null),
			rateLimit: { limit: 60, windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				const config = /** @type {NonNullable<import('./settings.js').Settings['photos']>} */ (s.settings.photos);
				const server = isServer(ctx);
				const problems = validatePhotoUpload(ctx.body, {
					allowedTypes: config.allowed_types,
					maxBytes: config.max_photo_bytes,
					server,
				});
				if (problems.length > 0) return invalid(problems);
				/** @type {string | null} */
				let customerId = server ? (ctx.body.customerId ?? null) : (ctx.identity?.subject ?? null);
				if (!server && typeof ctx.body.token === 'string') {
					const requestId = reviews.app.tokens.verify(ctx.body.token, ctx.websiteId);
					const request = requestId ? await s.repos.requests.get(requestId) : null;
					if (!request) return failure({ reason: 'invalid_token' });
					customerId = request.customerId;
				}
				if (!server && !customerId && s.settings.collection.who !== 'anyone') return failure({ reason: 'identity_required' });
				const result = await service.createUpload(s, {
					contentType: ctx.body.contentType,
					size: ctx.body.size,
					customerId: server ? null : customerId,
					key: ctx.idempotencyKey,
				});
				return result.ok ? created(result.photo) : failure(result);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/review-photos/:id',
			...website('photos'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const photo = await s.repos.photos.get(ctx.params.id);
				return photo
					? ok({
							id: photo.id,
							status: photo.status,
							reviewId: photo.reviewId ?? null,
							contentType: photo.contentType,
							size: photo.size,
						})
					: problem('not_found', 'No such photo.');
			},
		}),

		// ── display: ratings ────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/ratings',
			...website('display', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const headers = cacheFor(ctx, s.settings.display.cache_seconds);
				if (typeof ctx.query.itemIds === 'string') {
					const ids = [...new Set(ctx.query.itemIds.split(',').filter(Boolean))];
					if (ids.length === 0 || ids.length > MAX_BATCH_ITEMS || ids.some((id) => idCheck(id) !== null))
						return invalid([{ path: '/itemIds', code: 'ids_invalid' }]);
					return ok({ items: await service.stars(s, ids), nextCursor: null, hasMore: false }, { headers });
				}
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const rows = await s.repos.items.listRated({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				const body = page.page(rows, (/** @type {any} */ row) => row.itemId);
				const items = await service.stars(
					s,
					body.items.map((/** @type {any} */ row) => row.itemId),
				);
				const link = page.link(body.nextCursor);
				return ok({ ...body, items }, { headers: { ...headers, ...(link ? { link } : {}) } });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/ratings/:itemId',
			...website('display', null),
			handler: async (ctx) => {
				if (idCheck(ctx.params.itemId) !== null) return invalid([{ path: '/itemId', code: 'id_invalid' }]);
				const s = await site(ctx);
				const { display } = s.settings;
				const summary = await service.summary(s, ctx.params.itemId);
				return ok(
					{
						...summary,
						display: {
							showSummary: summary.count >= display.min_reviews_for_summary,
							showDistribution: display.show_distribution,
							showAttributes: display.show_attributes,
							allowSubmit: display.allow_submit,
							sorts: display.sorts,
							defaultSort: display.default_sort,
							filters: display.filters,
							pageSize: display.page_size,
						},
					},
					{ headers: cacheFor(ctx, display.cache_seconds) },
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/elements/display/view',
			...website('display', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const t = { ...(reviews.app.strings.en ?? {}) };
				const itemId = queryId(ctx.query.itemId);
				const list = await s.repos.reviews.list({
					filter: { ...(itemId ? { itemId } : {}), statuses: ['approved'] },
					sort: { submittedAt: -1, id: -1 },
					after: null,
					fetchLimit: STUB_REVIEWS,
				});
				const views = await service.viewsFor(s);
				const summary = itemId ? await service.summary(s, itemId) : null;
				const stars = (/** @type {number} */ n, /** @type {number} */ of) => '★'.repeat(n) + '☆'.repeat(Math.max(0, of - n));
				return ok(
					{
						title:
							summary && summary.count > 0
								? `${summary.average} / ${summary.scale} · ${(t['reviews.count.other'] ?? '{count} reviews').replace('{count}', String(summary.count))}`
								: (t['reviews.title'] ?? 'Reviews'),
						body: list.length === 0 ? (t['reviews.empty'] ?? '') : '',
						items: list.map((/** @type {any} */ review) => {
							const view = views.public(review);
							const text = [stars(view.rating, view.scale), view.title, view.body, view.author ? `— ${view.author}` : null]
								.filter(Boolean)
								.join(' ');
							return { text: text.slice(0, 500) };
						}),
					},
					{ headers: cacheFor(ctx, s.settings.display.cache_seconds) },
				);
			},
		}),

		// ── structured_data ─────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/structured-data/:itemId',
			...website('structured_data', null),
			handler: async (ctx) => {
				if (idCheck(ctx.params.itemId) !== null) return invalid([{ path: '/itemId', code: 'id_invalid' }]);
				/** @param {string} name @param {number} max @param {boolean} [url] */
				const param = (name, max, url = false) => {
					const value = ctx.query[name];
					if (value === undefined) return { ok: true, value: null };
					const good =
						typeof value === 'string' && value.length > 0 && value.length <= max && (!url || /^https:\/\/\S+$/.test(value));
					return good ? { ok: true, value } : { ok: false, value: null };
				};
				const fields = {
					name: param('name', 300),
					url: param('url', 2000, true),
					image: param('image', 2000, true),
					sku: param('sku', 100),
				};
				const bad = Object.entries(fields).filter(([, field]) => !field.ok);
				if (bad.length > 0) return invalid(bad.map(([name]) => ({ path: `/${name}`, code: 'text_invalid' })));
				const s = await site(ctx);
				const result = await service.jsonLd(s, ctx.params.itemId, {
					name: fields.name.value,
					url: fields.url.value,
					image: fields.image.value,
					sku: fields.sku.value,
				});
				if (!result.ok) return failure(result);
				return ok(result.value, {
					headers: { 'content-type': 'application/ld+json', ...cacheFor(ctx, s.settings.structured.cache_seconds) },
				});
			},
		}),

		// ── qna ─────────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/questions',
			...website('qna', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const server = isServer(ctx);
				const statuses = server
					? statusesOf(ctx.query['filter[status]'], ['pending', 'published', 'rejected'], undefined)
					: ['published'];
				if (statuses === null) return invalid([{ path: '/filter/status', code: 'status_invalid' }]);
				const itemId = queryId(ctx.query['filter[itemId]']);
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					server ? {} : { defaultLimit: 10, maxLimit: 50 },
				);
				const rows = await s.repos.questions.list({
					...(itemId ? { itemId } : {}),
					...(statuses ? { statuses } : {}),
					after: page.after,
					fetchLimit: page.fetchLimit,
				});
				const views = await service.viewsFor(s);
				const body = page.page(rows, (/** @type {any} */ row) => `${row.askedAt}|${row.id}`);
				const link = page.link(body.nextCursor);
				return ok(
					{ ...body, items: body.items.map((/** @type {any} */ row) => views.question(row, server)) },
					{ headers: { ...cacheFor(ctx, s.settings.display.cache_seconds), ...(link ? { link } : {}) } },
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/questions',
			...website('qna', null),
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				const server = isServer(ctx);
				const problems = validateQuestion(ctx.body, { maxLength: s.settings.qna.question_max_length, server });
				if (problems.length > 0) return invalid(problems);
				const customerId = server ? (ctx.body.customerId ?? null) : (ctx.identity?.subject ?? null);
				if (!server && !customerId && s.settings.qna.who_can_ask !== 'anyone')
					return failure({ reason: 'identity_required' });
				if (!server && !customerId && !ctx.body.author?.name) return invalid([{ path: '/author/name', code: 'required' }]);
				const result = await service.ask(s, {
					itemId: ctx.body.itemId,
					body: ctx.body.body,
					author: ctx.body.author ?? null,
					customerId,
					locale: ctx.body.locale ?? null,
					key: ctx.idempotencyKey,
					server,
				});
				if (!result.ok) return failure(result);
				const view = (await service.viewsFor(s)).question(result.question, server);
				return created(server ? view : { ...view, status: result.question.status });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/questions/:id',
			...website('qna', null),
			handler: async (ctx) => {
				const s = await site(ctx);
				const question = await s.repos.questions.get(ctx.params.id);
				if (!question || (!isServer(ctx) && question.status !== 'published'))
					return problem('not_found', 'No such question.');
				return ok((await service.viewsFor(s)).question(question, isServer(ctx)));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/questions/:id/answers',
			...website('qna', null),
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (ctx) => {
				const s = await site(ctx);
				const server = isServer(ctx);
				return answerQuestion(ctx, s, { merchant: server, customerId: server ? null : (ctx.identity?.subject ?? null) });
			},
		}),
		.../** @type {const} */ (['publish', 'reject']).flatMap((verb) => {
			const decision = verb === 'publish' ? 'published' : 'rejected';
			return [
				defineRoute({
					method: 'POST',
					path: `/v1/questions/:id/${verb}`,
					...website('qna'),
					idempotent: 'optional',
					handler: async (ctx) => decideQuestion(await site(ctx), ctx.params, decision, apiActor(ctx)),
				}),
				defineRoute({
					method: 'POST',
					path: `/v1/questions/:id/answers/:answerId/${verb}`,
					...website('qna'),
					idempotent: 'optional',
					handler: async (ctx) => decideQuestion(await site(ctx), ctx.params, decision, apiActor(ctx)),
				}),
			];
		}),

		// ── import ──────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/imports',
			...website('import'),
			maxBodyBytes: IMPORT_MAX_BYTES,
			handler: async (ctx) => {
				const problems = validateImport(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await service.importCsv(await site(ctx), {
					csv: ctx.body.csv,
					dryRun: ctx.body.dryRun === true,
					key: ctx.idempotencyKey,
					actor: apiActor(ctx),
				});
				return result.ok ? ok(result.report) : failure(result);
			},
		}),

		// ── analytics ───────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/analytics',
			...website('analytics'),
			handler: async (ctx) => {
				const result = await service.analytics(await site(ctx), ctx.query);
				return result.ok ? ok(result.value) : invalid([{ path: result.path, code: result.code }]);
			},
		}),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'collection',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.overview(s)) : noWebsite();
			},
		}),
		.../** @type {const} */ (['approve', 'reject', 'reply']).map((action) =>
			defineRoute({
				method: 'POST',
				path: `/v1/dashboard/moderation/:id/${action}`,
				auth: 'launch',
				element: 'moderation',
				roles: [...DASHBOARD_WRITE_ROLES],
				idempotent: 'optional',
				handler: async (ctx) => {
					const s = await dashboardSite(ctx);
					return s ? moderate(s, ctx.params.id, action, ctx.body, dashboardActor(ctx.session)) : noWebsite();
				},
			}),
		),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/questions/:id/answers',
			auth: 'launch',
			element: 'qna',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? answerQuestion(ctx, s, { merchant: true, customerId: null }) : noWebsite();
			},
		}),
		.../** @type {const} */ (['publish', 'reject']).map((verb) =>
			defineRoute({
				method: 'POST',
				path: `/v1/dashboard/questions/:id/${verb}`,
				auth: 'launch',
				element: 'qna',
				roles: [...DASHBOARD_WRITE_ROLES],
				idempotent: 'optional',
				handler: async (ctx) => {
					const s = await dashboardSite(ctx);
					return s
						? decideQuestion(s, ctx.params, verb === 'publish' ? 'published' : 'rejected', dashboardActor(ctx.session))
						: noWebsite();
				},
			}),
		),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/request-flow:run',
			auth: 'launch',
			element: 'request_flow',
			roles: [...DASHBOARD_WRITE_ROLES],
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.runRequests(s)) : noWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/photos:sweep',
			auth: 'launch',
			element: 'photos',
			roles: [...DASHBOARD_WRITE_ROLES],
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.sweepPhotos(s)) : noWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/moderation:check',
			auth: 'launch',
			idempotent: false,
			handler: (ctx) => {
				const source = ctx.body?.source;
				return typeof source === 'string' ? ok(checkCondition(source)) : invalid([{ path: '/source', code: 'required' }]);
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Reviews} reviews
 */
export const wireEvents = (reviews) => {
	for (const [type, handler] of Object.entries(createEventHandlers(reviews))) reviews.product.events.on(type, handler);
	return reviews;
};
