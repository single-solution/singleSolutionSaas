/**
 * The request handler: `(Request) → Promise<Response>` (WHATWG Fetch API). Pipeline per request:
 *
 *   configuration problems (503) → request id → CORS preflight → route match (404/405) → Portal connection (503 before
 *   connect, except `none` routes) → body with a byte cap (413) → auth → status of the product on the website (403
 *   `product_unavailable`, 503 `portal_unreachable`) → feature (403 `feature_off`) → merchant database (403
 *   `database_not_connected`) → JSON (415/400) → rate limits (429) → `Idempotency-Key` (409) → handler → RFC 9457
 *   problems for every error.
 *
 * Auth: `browser` (browser token from `Authorization: Bearer`; the Origin must be `https://<exact domain>` or local,
 * CORS only for it), `server` (server token; refused when an Origin header is
 * present; no CORS), `ticket` (ticket bound to the request's Origin; CORS only for it), `dashboard` (session cookie;
 * writes only from the product's own address; never framed) and `none`. Every token or ticket failure is the same
 * 401 `invalid_token`.
 *
 * Right after the response (Next.js `after`, through `toNextRoute`): a pending price report, a stale business.json,
 * unsent activity copies, the staff named in a ticket and the widget last-seen time.
 * @module
 */
import { canonicalOrigin, isLocalOrigin, isProtocolError, originAllowed, verifyToken } from '@ss/protocol';
import { createId } from '@ss/contracts';
import { isKitError, sha256Hex } from '../util.js';
import { isProblem, isResult, noContent, ok, problem } from './results.js';
import { compileRoutes, matchPath, matchRoute, splitPath } from './routes.js';

/** @typedef {import('./routes.js').RouteDefinition} RouteDefinition */
/** @typedef {import('./routes.js').CompiledRoute} CompiledRoute */
/** @typedef {import('./results.js').ProblemResult} ProblemResult */
/** @typedef {import('./results.js').RouteResult} RouteResult */

/**
 * @typedef {object} RequestContext
 * @property {Request} request
 * @property {string} requestId
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} params
 * @property {Record<string, string>} query first value of each query parameter
 * @property {URLSearchParams} searchParams
 * @property {Headers} headers
 * @property {string | undefined} idempotencyKey
 * @property {unknown} body parsed JSON (undefined when empty or for `rawBody` routes)
 * @property {string} rawBody
 * @property {string | null} origin the canonical Origin header, if any
 * @property {string | null} websiteId
 * @property {string | null} merchantId
 * @property {import('@ss/contracts').StatusResponse | null} status the status response of the website
 * @property {import('@ss/protocol').TokenClaims | null} token browser or server token claims
 * @property {import('@ss/protocol').TicketClaims | null} ticket
 * @property {import('../dashboard.js').Session | null} session dashboard session
 * @property {(task: () => Promise<unknown>) => void} after run work right after the response
 * @property {() => Promise<import('../data.js').WebsiteData>} data the website's merchant database (tenant guard)
 * @property {import('../logger.js').Logger} log
 */

/** Per-request `after()` schedulers registered by adapters (`toNextRoute`). */
const SCHEDULERS = new WeakMap();

/**
 * Register the framework's `after(fn)` for a request.
 * @param {Request} request
 * @param {(task: () => Promise<unknown>) => void} after
 */
export const rememberScheduler = (request, after) => {
	SCHEDULERS.set(request, after);
};

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DUPLICATE_WINDOW_MS = 24 * 60 * 60_000;
// `ss-sign-in`: a visitor's Accounts sign-in next to the browser token (signed-in visitor routes);
// `ss-guest`: a Chat guest's device key (Chat's guest visitor routes)
const CORS_HEADERS = 'authorization, content-type, idempotency-key, ss-guest, ss-sign-in, x-request-id';
const LAST_SEEN_EVERY_MS = 60 * 60_000;
const STAFF_EVERY_MS = 10 * 60_000;
const NO_FRAMES = Object.freeze({ 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });

/** @param {URLSearchParams} params */
const firstValues = (params) => {
	/** @type {Record<string, string>} */
	const out = {};
	for (const [name, value] of params) if (!Object.hasOwn(out, name)) out[name] = value;
	return out;
};

/**
 * Read at most `max` bytes of the request body.
 * @param {Request} request
 * @param {number} max
 * @returns {Promise<string | null>} null when too large
 */
const readBody = async (request, max) => {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > max) return null;
	if (!request.body) return '';
	const reader = request.body.getReader();
	/** @type {Uint8Array[]} */
	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
};

/** @param {string | null} header */
const bearerOf = (header) => /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? null;

/**
 * Create the request handler.
 * @param {import('../product.js').Kit} kit the internal parts `createProduct` wires
 * @param {ReadonlyArray<RouteDefinition>} routes
 * @param {{ after?: (task: () => Promise<unknown>) => void }} [options] `after`: the post-response scheduler for requests
 *   that did not come through `toNextRoute` (default: run detached)
 * @returns {(request: Request) => Promise<Response>}
 */
export const createRequestHandler = (kit, routes, options = {}) => {
	const { problems, logger, now, randomBytes, store, manifest } = kit;
	const compiled = compileRoutes(routes);
	const featureKeys = manifest.features.map((/** @type {{ key: string }} */ f) => f.key);
	/** @type {Map<string, string>} */
	const featureOfPermission = new Map(
		manifest.permissions.map((/** @type {{ key: string, feature: string }} */ p) => [p.key, p.feature]),
	);
	for (const route of compiled) {
		for (const key of route.feature === undefined ? [] : [route.feature].flat())
			if (!featureKeys.includes(key)) throw new TypeError(`route ${route.id}: unknown feature ${key}`);
		if (route.permission !== undefined && !featureOfPermission.has(route.permission))
			throw new TypeError(`route ${route.id}: unknown permission ${route.permission}`);
	}
	/** @type {Map<string, number>} */
	const lastWrites = new Map();

	/**
	 * @param {RouteResult} result
	 * @param {string} requestId
	 * @param {string} instance
	 * @returns {{ status: number, headers: Record<string, string>, body: string | null }}
	 */
	const render = (result, requestId, instance) => {
		if (isProblem(result)) {
			/** @type {import('@ss/contracts').Problem} */
			let doc;
			try {
				const { reason, ...extensions } = result.extensions ?? {};
				doc = problems.create(result.code, {
					...(result.detail === undefined ? {} : { detail: result.detail }),
					...(result.errors === undefined ? {} : { errors: result.errors }),
					...(reason === undefined
						? {}
						: { reason: /** @type {import('@ss/contracts').ProductUnavailableReason} */ (reason) }),
					requestId,
					instance,
				});
				doc = Object.freeze({ ...extensions, ...doc });
			} catch {
				doc = problems.create('internal_error', { requestId, instance });
			}
			return {
				status: doc.status,
				headers: { ...result.headers, 'content-type': 'application/problem+json' },
				body: JSON.stringify(doc),
			};
		}
		const hasBody = result.body !== undefined && result.status !== 204 && result.status !== 304;
		return {
			status: result.status,
			headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...result.headers },
			body: hasBody ? JSON.stringify(result.body) : null,
		};
	};

	/**
	 * Browser or server token of a request.
	 * @param {CompiledRoute} r
	 * @param {Request} request
	 * @param {string | null} rawOrigin
	 * @returns {Promise<import('@ss/protocol').TokenClaims | null>}
	 */
	const verifyWebsiteToken = async (r, request, rawOrigin) => {
		const kind = r.auth === 'browser' ? 'browser' : 'server';
		if (kind === 'server' && rawOrigin !== null) return null;
		if (kind === 'browser' && rawOrigin === null) return null;
		const token = bearerOf(request.headers.get('authorization'));
		if (!token) return null;
		const { portalUrl, portalKeys } = kit.connection.active();
		try {
			const claims = await verifyToken({
				token,
				keyResolver: portalKeys,
				issuer: portalUrl,
				productId: manifest.id,
				kind,
				isRevoked: kit.status.isRevoked,
				now,
			});
			if (kind === 'browser' && rawOrigin !== null && !originAllowed({ origin: rawOrigin, domain: claims.domain }))
				return null;
			return claims;
		} catch (error) {
			if (isProtocolError(error)) return null;
			throw error;
		}
	};

	/**
	 * Work right after a website request.
	 * @param {RequestContext} ctx
	 * @param {CompiledRoute} r
	 */
	const afterWebsiteRequest = async (ctx, r) => {
		const websiteId = /** @type {string} */ (ctx.websiteId);
		const status = /** @type {import('@ss/contracts').StatusResponse} */ (ctx.status);
		const tasks = [
			async () => {
				const kept = await kit.business.get(websiteId, status.domain);
				if (kept.stale) await kit.business.refresh(websiteId, status.domain);
			},
			async () => {
				if (r.database !== false) await kit.activity.retry(websiteId, ctx.merchantId);
			},
			async () => {
				// widget installed: a visitor-widget request from the real domain (never a local origin)
				if (r.auth !== 'browser' || ctx.origin === null || isLocalOrigin(ctx.origin)) return;
				if (now() - (lastWrites.get(`seen|${websiteId}`) ?? -Infinity) < LAST_SEEN_EVERY_MS) return;
				lastWrites.set(`seen|${websiteId}`, now());
				await store.put('widget', websiteId, { websiteId, lastSeenAt: now() });
			},
			async () => {
				// the merchant's staff named in a ticket
				const user = ctx.ticket?.user;
				if (!user || r.database === false) return;
				const key = `staff|${websiteId}|${user.id}`;
				if (now() - (lastWrites.get(key) ?? -Infinity) < STAFF_EVERY_MS) return;
				lastWrites.set(key, now());
				const db = await ctx.data();
				await db
					.collection('staff')
					.updateOne(
						{ websiteId, id: user.id },
						{ $set: { name: user.name, email: user.email, lastSeenAt: new Date(now()) } },
						{ upsert: true },
					);
			},
		];
		for (const task of tasks) await task().catch((error) => logger.warn('work after the request failed', { websiteId, error }));
	};

	/**
	 * @param {Request} request
	 * @returns {Promise<Response>}
	 */
	return async (request) => {
		const started = now();
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const presented = request.headers.get('x-request-id');
		const requestId = presented && REQUEST_ID.test(presented) ? presented : createId('req', { randomBytes });
		const log = logger.child({ requestId });
		const pathname = url.pathname;
		const rawOrigin = request.headers.get('origin');
		/** @type {Record<string, string>} */
		const extra = { 'x-request-id': requestId };
		/** @type {Array<() => Promise<unknown>>} */
		const afterTasks = [];
		/** @type {CompiledRoute | null} */
		let route = null;
		/** @type {string | null} */
		let websiteId = null;

		/** @param {{ status: number, headers: Record<string, string>, body: string | null }} rendered */
		const finish = (rendered) => {
			/** @type {(task: () => Promise<unknown>) => void} */
			const scheduler = SCHEDULERS.get(request) ?? options.after ?? ((task) => void task());
			if (kit.connection.connected()) afterTasks.unshift(() => kit.reports.syncManifest());
			if (afterTasks.length > 0)
				scheduler(async () => {
					for (const task of afterTasks) await task().catch((error) => log.warn('work after the request failed', { error }));
				});
			log.info('request', {
				method,
				path: pathname,
				status: rendered.status,
				ms: now() - started,
				...(websiteId ? { websiteId } : {}),
			});
			return new Response(method === 'HEAD' ? null : rendered.body, {
				status: rendered.status,
				headers: { ...rendered.headers, ...extra },
			});
		};
		/** @param {ProblemResult} p */
		const fail = (p) => finish(render(p, requestId, pathname));

		try {
			if (kit.configProblems.length > 0) {
				extra['retry-after'] = '60';
				return fail(
					problem('unavailable', 'This product is misconfigured.', { extensions: { problems: [...kit.configProblems] } }),
				);
			}
			if (method === 'OPTIONS') {
				const parts = splitPath(pathname);
				const matching = compiled.filter((r) => matchPath(r, parts) !== null);
				if (matching.length === 0) return fail(problem('not_found'));
				const methods = [...new Set(matching.map((r) => r.method))];
				const origin = canonicalOrigin(rawOrigin);
				if (origin && matching.some((r) => r.auth === 'browser' || r.auth === 'ticket')) {
					Object.assign(extra, {
						'access-control-allow-origin': origin,
						'access-control-allow-methods': methods.join(', '),
						'access-control-allow-headers': CORS_HEADERS,
						'access-control-max-age': '600',
						vary: 'Origin',
					});
				}
				extra.allow = [...methods, 'OPTIONS'].join(', ');
				return finish({ status: 204, headers: {}, body: null });
			}

			const matched = matchRoute(compiled, method, pathname);
			if (!matched.route) {
				const allow = /** @type {{ allow: string[] }} */ (matched).allow;
				if (allow.length === 0) return fail(problem('not_found', 'No such resource.'));
				extra.allow = allow.join(', ');
				return fail(problem('method_not_allowed'));
			}
			const r = matched.route;
			route = r;
			if (r.auth === 'dashboard' || pathname === '/sso') Object.assign(extra, NO_FRAMES);
			if (r.auth === 'dashboard') extra['cache-control'] = 'no-store';

			await kit.connection.ready();
			if (r.auth !== 'none' && !kit.connection.connected()) {
				extra['retry-after'] = '60';
				return fail(problem('unavailable', 'This product is not connected to a Portal yet.'));
			}

			/** @type {RequestContext} */
			const ctx = {
				request,
				requestId,
				method,
				path: pathname,
				params: matched.params,
				query: firstValues(url.searchParams),
				searchParams: url.searchParams,
				headers: request.headers,
				idempotencyKey: IDEMPOTENCY_KEY.test(request.headers.get('idempotency-key') ?? '')
					? /** @type {string} */ (request.headers.get('idempotency-key'))
					: undefined,
				body: undefined,
				rawBody: '',
				origin: canonicalOrigin(rawOrigin),
				websiteId: null,
				merchantId: null,
				status: null,
				token: null,
				ticket: null,
				session: null,
				after: (task) => {
					afterTasks.push(task);
				},
				data: () => {
					if (!ctx.websiteId) throw problem('bad_request', 'This request names no website.');
					return kit.data.forWebsite(ctx.websiteId, ctx.merchantId ? { merchantId: ctx.merchantId } : {});
				},
				log,
			};

			if (BODY_METHODS.has(method)) {
				const max = r.maxBodyBytes ?? 1024 * 1024;
				const text = await readBody(request, max);
				if (text === null) return fail(problem('payload_too_large', `The body exceeds ${max} bytes.`));
				ctx.rawBody = text;
			}

			// auth
			if (r.auth === 'browser' || r.auth === 'server') {
				const claims = await verifyWebsiteToken(r, request, rawOrigin);
				if (!claims) return fail(problem('invalid_token', 'The token is not valid.'));
				ctx.token = claims;
				ctx.websiteId = claims.websiteId;
				if (r.auth === 'browser' && ctx.origin)
					Object.assign(extra, { 'access-control-allow-origin': ctx.origin, vary: 'Origin' });
			} else if (r.auth === 'ticket') {
				const ticket = bearerOf(request.headers.get('authorization')) ?? '';
				try {
					ctx.ticket = await kit.tickets.verify({ ticket, origin: rawOrigin, isRevoked: kit.status.isRevoked });
				} catch (error) {
					if (!isProtocolError(error)) throw error;
					return fail(problem('invalid_token', 'The token is not valid.'));
				}
				ctx.websiteId = ctx.ticket.websiteId;
				Object.assign(extra, { 'access-control-allow-origin': ctx.ticket.origin, vary: 'Origin' });
				if (r.permission !== undefined && !ctx.ticket.permissions.includes(r.permission))
					return fail(problem('forbidden', 'The ticket does not carry this permission.'));
			} else if (r.auth === 'dashboard') {
				const allowed = await kit.dashboard.authorize(ctx, r);
				if (!allowed.ok) return fail(allowed.problem);
				Object.assign(ctx, {
					session: allowed.session,
					websiteId: allowed.websiteId,
					merchantId: allowed.merchantId,
					status: allowed.status,
				});
			}
			websiteId = ctx.websiteId;

			if (r.auth === 'browser' || r.auth === 'server' || r.auth === 'ticket') {
				const id = /** @type {string} */ (ctx.websiteId);
				const serving = await kit.status.serving(id);
				if (!serving.ok) return fail(serving.problem);
				// a status fetch also refreshes the revocation list: check the token (or the ticket's server token) again
				if (await kit.status.isRevoked(ctx.token?.jti ?? ctx.ticket?.tid ?? ''))
					return fail(problem('invalid_token', 'The token is not valid.'));
				ctx.status = serving.status;
				ctx.merchantId = serving.status.merchantId;
				const feature = r.feature ?? (r.permission === undefined ? undefined : featureOfPermission.get(r.permission));
				// a list: the route works while any of its features is on
				const keys = feature === undefined ? [] : [feature].flat();
				if (keys.length > 0 && !(await kit.reports.switches(id)).on.some((key) => keys.includes(key)))
					return fail(problem('feature_off', `The feature ${keys.join(' or ')} is off.`));
				if (r.database !== false && (await kit.connections.value(id, 'database')) === null)
					return fail(problem('database_not_connected', 'Connect the merchant database in the product dashboard first.'));
				afterTasks.push(() => afterWebsiteRequest(ctx, r));
			}

			if (!r.rawBody && ctx.rawBody.length > 0) {
				const type = (request.headers.get('content-type') ?? '').toLowerCase();
				if (!/^application\/([a-z0-9.+-]+\+)?json(\s*;|$)/.test(type))
					return fail(problem('unsupported_media_type', 'Send application/json.'));
				try {
					ctx.body = JSON.parse(ctx.rawBody);
				} catch {
					return fail(problem('bad_request', 'The body is not valid JSON.'));
				}
			}

			for (const limit of r.rateLimit === undefined ? [] : [r.rateLimit].flat()) {
				const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
				const per = limit.per ?? (ctx.websiteId ? 'website' : 'visitor');
				const subject = per === 'website' && ctx.websiteId ? `w:${ctx.websiteId}` : `ip:${ip}`;
				try {
					const windowMs = limit.windowSeconds * 1000;
					const { count, resetAt } = await store.hit(`${r.id}|${per}|${subject}`, windowMs, now());
					if (count > limit.limit) {
						extra['retry-after'] = String(Math.max(1, Math.ceil((resetAt - now()) / 1000)));
						return fail(problem('rate_limited', 'Too many requests.'));
					}
				} catch (error) {
					log.warn('rate limit store failed; allowing the request', { error });
				}
			}

			/** @type {string | null} */
			let duplicateKey = null;
			if (r.idempotent === true && ctx.idempotencyKey) {
				const principal = ctx.websiteId ?? ctx.session?.subject ?? 'anonymous';
				duplicateKey = `idem:${sha256Hex(`${principal}\n${r.id}\n${ctx.idempotencyKey}`)}`;
				if (await store.seen(duplicateKey, now() + DUPLICATE_WINDOW_MS))
					return fail(problem('duplicate_request', 'A request with this Idempotency-Key was already processed.'));
			}

			/** @type {{ status: number, headers: Record<string, string>, body: string | null }} */
			let rendered;
			try {
				const out = await r.handler(ctx);
				if (out instanceof Response) {
					const text = await out.text();
					rendered = {
						status: out.status,
						headers: Object.fromEntries(out.headers.entries()),
						body: text.length > 0 ? text : null,
					};
				} else rendered = render(isResult(out) ? out : out === undefined ? noContent() : ok(out), requestId, pathname);
			} catch (error) {
				if (isProblem(error)) rendered = render(error, requestId, pathname);
				else if (isKitError(error, 'database_not_connected'))
					rendered = render(problem('database_not_connected'), requestId, pathname);
				else {
					log.error('route handler failed', { error, route: r.id });
					rendered = render(problem('internal_error'), requestId, pathname);
				}
			}
			if (duplicateKey && rendered.status >= 500) await store.forget(duplicateKey).catch(() => {});
			return finish(rendered);
		} catch (error) {
			log.error('request failed', { error, ...(route ? { route: route.id } : {}) });
			return fail(problem('internal_error'));
		}
	};
};
