/**
 * Framework-agnostic request handler: `(Request) → Promise<Response>` (WHATWG Fetch API, so it runs on Node,
 * serverless and edge-style runtimes). Pipeline per request:
 *
 *   request id → route match (404/405, CORS preflight) → body read with a byte cap (413) → auth (website key /
 *   launch session / Portal signature / none) → entitlement + element gating → JSON parse (415/400) → customer
 *   identity → rate limit (429; limit and key may be functions of the context) → Idempotency-Key (428/409/replay) →
 *   handler → RFC 9457 problems for every error. After the response, the background flusher may run.
 * @module
 */
import { STOPPED_STATES, can } from '../entitlements.js';
import { createId } from '@ss/contracts';
import { isProblem, isResult, noContent, ok, problem } from './results.js';
import { replayHeaders } from './replay.js';
import { compileRoutes, matchPath, matchRoute, splitPath } from './routes.js';

/** @typedef {import('./routes.js').RouteDefinition} RouteDefinition */
/** @typedef {import('./routes.js').CompiledRoute} CompiledRoute */
/** @typedef {import('./results.js').RouteResult} RouteResult */
/** @typedef {import('../stores/types.js').StoredResponse} StoredResponse */

/**
 * @typedef {object} RequestContext
 * @property {Request} request
 * @property {string} requestId
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} params
 * @property {Record<string, string>} query query parameters (first value of each name)
 * @property {URLSearchParams} searchParams all query parameters
 * @property {string | undefined} idempotencyKey the request's valid `Idempotency-Key`, if any
 * @property {Headers} headers
 * @property {unknown} body parsed JSON (undefined when empty or `rawBody` routes)
 * @property {string} rawBody
 * @property {import('../keys.js').WebsiteBinding | null} website
 * @property {{ doc: import('@ss/contracts').EntitlementDocument, stale: boolean, version: number } | null} entitlement
 * @property {import('../launch.js').Session | null} session
 * @property {{ kid: string, timestamp: number } | null} portal
 * @property {string | null} websiteId website of the request (key binding, or the session's selected website)
 * @property {import('../identity.js').CustomerIdentity | null} identity the verified customer (routes with `identity`)
 * @property {import('../identity.js').IdentityFailure | null} identityProblem why `identity` is null (optional identity)
 * @property {any} product
 * @property {import('../logger.js').Logger} log
 */

/** Original request paths of requests rewritten by adapters (e.g. `toNextRoute` stripping `/api`). */
const ORIGINAL_PATHS = new WeakMap();

/**
 * Record the path (with query) the client addressed before an adapter rewrote the request URL.
 * @param {Request} request the rewritten request
 * @param {string} path
 */
export const rememberOriginalPath = (request, path) => {
	ORIGINAL_PATHS.set(request, path);
};

/**
 * @param {Request} request
 * @returns {string | undefined}
 */
const originalPathOf = (request) => ORIGINAL_PATHS.get(request);

/** Per-request `after()` schedulers registered by adapters (e.g. Next.js `after` through `toNextRoute`). */
const SCHEDULERS = new WeakMap();

/**
 * Register the framework's `after(fn)` for a request: the kit's background flush then runs after the response.
 * @param {Request} request
 * @param {(task: () => Promise<unknown>) => void} after
 */
export const rememberScheduler = (request, after) => {
	SCHEDULERS.set(request, after);
};

/**
 * @param {URLSearchParams} params
 * @returns {Record<string, string>} first value of each name
 */
const firstValues = (params) => {
	/** @type {Record<string, string>} */
	const out = {};
	for (const [name, value] of params) if (!Object.hasOwn(out, name)) out[name] = value;
	return out;
};

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CORS_HEADERS = 'authorization, content-type, idempotency-key, ss-identity, x-request-id, x-ss-website';

/**
 * Read at most `max` bytes of the request body.
 * @param {Request} request
 * @param {number} max
 * @returns {Promise<{ ok: true, text: string } | { ok: false }>}
 */
const readBody = async (request, max) => {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > max) return { ok: false };
	if (!request.body) return { ok: true, text: '' };
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
			return { ok: false };
		}
		chunks.push(value);
	}
	return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
};

/**
 * @param {string | null} cookieHeader
 * @param {string} name
 * @returns {string | undefined}
 */
const readCookie = (cookieHeader, name) => {
	for (const part of (cookieHeader ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return rest.join('=');
	}
	return undefined;
};

/**
 * Create the request handler.
 * @param {any} product the object returned by `createProduct`
 * @param {ReadonlyArray<RouteDefinition>} routes
 * @param {{ basePath?: string, maxBodyBytes?: number, requestIdHeader?: string, trustForwardedFor?: boolean }} [options]
 * @returns {(request: Request) => Promise<Response>}
 */
export const createRequestHandler = (product, routes, options = {}) => {
	const ctxKit = product.context;
	const { problems, logger, now, randomBytes, stores } = ctxKit;
	const compiled = compileRoutes(routes);
	const basePath = (options.basePath ?? '').replace(/\/+$/, '');
	const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
	const requestIdHeader = (options.requestIdHeader ?? ctxKit.requestIdHeader ?? 'x-request-id').toLowerCase();
	const trustForwardedFor = options.trustForwardedFor ?? true;

	/**
	 * @param {RouteResult | import('./results.js').ProblemResult} result
	 * @param {string} requestId
	 * @param {string} instance
	 * @returns {{ status: number, headers: Record<string, string>, body: string | null }}
	 */
	const render = (result, requestId, instance) => {
		if (isProblem(result)) {
			/** @type {import('@ss/contracts').Problem} */
			let doc;
			try {
				doc = problems.create(result.code, {
					...(result.status === undefined ? {} : { status: result.status }),
					...(result.detail === undefined ? {} : { detail: result.detail }),
					...(result.errors === undefined ? {} : { errors: result.errors }),
					requestId,
					instance,
				});
				// RFC 9457 extension members (names validated by `problem()`; standard members cannot be clobbered)
				if (result.extensions) doc = Object.freeze({ ...result.extensions, ...doc });
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
	 * @param {Request} request
	 * @returns {Promise<Response>}
	 */
	return async (request) => {
		const started = now();
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const presented = request.headers.get(requestIdHeader);
		const requestId = presented && REQUEST_ID.test(presented) ? presented : createId('req', { randomBytes });
		const log = logger.child({ requestId });
		let pathname = url.pathname;
		if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`)))
			pathname = pathname.slice(basePath.length) || '/';
		const origin = request.headers.get('origin');
		/** @type {Record<string, string>} */
		const extra = { 'x-request-id': requestId };
		/** @type {CompiledRoute | null} */
		let route = null;
		/** @type {string | null} */
		let websiteId = null;

		/**
		 * @param {{ status: number, headers: Record<string, string>, body: string | null }} rendered
		 */
		const finish = (rendered) => {
			const headers = new Headers({ ...rendered.headers, ...extra });
			try {
				ctxKit.background?.afterRequest(SCHEDULERS.get(request), { websiteId });
			} catch (error) {
				log.warn('background scheduling failed', { error });
			}
			log.info('request', {
				method,
				path: pathname,
				status: rendered.status,
				ms: now() - started,
				...(websiteId ? { websiteId } : {}),
				...(route?.element ? { element: route.element } : {}),
			});
			return new Response(method === 'HEAD' || rendered.body === '' ? null : rendered.body, {
				status: rendered.status,
				headers,
			});
		};
		/** @param {import('./results.js').ProblemResult} p */
		const fail = (p) => finish(render(p, requestId, pathname));

		try {
			if (method === 'OPTIONS') {
				const parts = splitPath(pathname);
				const matching = compiled.filter((r) => matchPath(r, parts) !== null);
				const methods = [...new Set(matching.map((r) => r.method))];
				if (methods.length === 0) return fail(problem('not_found'));
				const cors = matching.some((r) => r.cors ?? r.auth === 'website');
				if (cors && origin) {
					extra['access-control-allow-origin'] = origin;
					extra['access-control-allow-methods'] = methods.join(', ');
					extra['access-control-allow-headers'] = CORS_HEADERS;
					extra['access-control-max-age'] = '600';
					extra.vary = 'Origin';
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
			route = matched.route;
			const r = route;
			if (r.cors === true) extra['access-control-allow-origin'] = '*';

			/** @type {RequestContext} */
			const ctx = {
				request,
				requestId,
				method,
				path: pathname,
				params: matched.params,
				query: firstValues(url.searchParams),
				searchParams: url.searchParams,
				idempotencyKey: IDEMPOTENCY_KEY.test(request.headers.get('idempotency-key') ?? '')
					? /** @type {string} */ (request.headers.get('idempotency-key'))
					: undefined,
				headers: request.headers,
				body: undefined,
				rawBody: '',
				website: null,
				entitlement: null,
				session: null,
				portal: null,
				websiteId: null,
				identity: null,
				identityProblem: null,
				product,
				log,
			};

			// body (read before auth: Portal signatures cover the raw bytes)
			if (BODY_METHODS.has(method)) {
				const read = await readBody(request, r.maxBodyBytes ?? maxBodyBytes);
				if (!read.ok) return fail(problem('payload_too_large', `The body exceeds ${r.maxBodyBytes ?? maxBodyBytes} bytes.`));
				ctx.rawBody = read.text;
			}

			// auth
			if (r.auth === 'website') {
				const verified = await product.keys.verify(request.headers.get('authorization'), {
					origin,
					referer: request.headers.get('referer'),
					requiredScopes: r.scopes ?? [],
					...(r.keyKind ? { expectedKind: r.keyKind } : {}),
				});
				if (!verified.ok) {
					if (verified.code === 'unavailable') extra['retry-after'] = '30';
					return fail(problem(verified.code, verified.detail));
				}
				ctx.website = verified.website;
				ctx.websiteId = verified.website.websiteId;
				websiteId = ctx.websiteId;
				if ((r.cors ?? true) && origin && verified.website.kind === 'pk') {
					extra['access-control-allow-origin'] = origin;
					extra.vary = 'Origin';
				}
			} else if (r.auth === 'launch') {
				const bearer = /^Bearer\s+(ses_\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
				const id = bearer ?? readCookie(request.headers.get('cookie'), ctxKit.sessionCookie);
				const session = await product.launch.session(id);
				if (!session) return fail(problem('unauthorized', 'A dashboard session is required.'));
				if (r.roles && !r.roles.includes(session.role))
					return fail(problem('forbidden', 'This role cannot use this operation.'));
				ctx.session = session;
				const scope = session.scope ?? {};
				const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(Boolean);
				const selected = request.headers.get('x-ss-website') ?? (allowed.length === 1 ? allowed[0] : null);
				if (selected) {
					if (!allowed.includes(selected)) return fail(problem('forbidden', 'This session has no access to that website.'));
					ctx.websiteId = selected;
					websiteId = selected;
				}
			} else if (r.auth === 'portal') {
				// signature binds method, path + query (as addressed by the Portal), audience (appId) and body
				const verified = await ctxKit.verifyPortalRequest({
					method,
					path: originalPathOf(request) ?? `${url.pathname}${url.search}`,
					headers: request.headers,
					rawBody: ctx.rawBody,
				});
				if (!verified.ok) return fail(problem('invalid_credentials', 'The Portal signature is invalid.'));
				ctx.portal = { kid: verified.kid, timestamp: verified.timestamp };
			}

			// entitlement + element gating
			const needsEntitlement =
				(r.auth === 'website' && r.entitlement !== false) || (r.auth === 'launch' && r.element !== undefined);
			if (needsEntitlement) {
				if (!ctx.websiteId) return fail(problem('bad_request', 'Select a website with the X-SS-Website header.'));
				const result = await product.entitlements.forWebsite(ctx.websiteId);
				if (!result.ok) {
					if (result.reason === 'unavailable') {
						extra['retry-after'] = '30';
						return fail(problem('unavailable', 'Entitlements are temporarily unavailable.'));
					}
					return fail(problem('subscription_inactive', 'This website has no active subscription to this product.'));
				}
				const { doc } = result;
				if (ctx.website && (doc.env !== ctx.website.env || doc.merchantId !== ctx.website.merchantId)) {
					return fail(problem('forbidden', 'The key does not match this subscription.'));
				}
				ctx.entitlement = { doc, stale: result.stale, version: result.version };
				if (result.stale) extra['ss-entitlement-stale'] = 'true';
				if (r.element !== undefined && !can(doc, r.element)) {
					const state = doc.runtime.state;
					if (state === 'spend_cap') return fail(problem('spend_cap_reached', 'The spend cap for this website is reached.'));
					if (STOPPED_STATES.includes(state)) return fail(problem('subscription_inactive', `The subscription is ${state}.`));
					return fail(problem('element_disabled', `Element '${r.element}' is not enabled for this website.`));
				}
			}

			// JSON body
			if (!r.rawBody && ctx.rawBody.length > 0) {
				const type = (request.headers.get('content-type') ?? '').toLowerCase();
				if (!/^application\/([a-z0-9.+-]+\+)?json(\s*;|$)/.test(type)) {
					return fail(problem('unsupported_media_type', 'Send application/json.'));
				}
				try {
					ctx.body = JSON.parse(ctx.rawBody);
				} catch {
					return fail(problem('bad_request', 'The body is not valid JSON.'));
				}
			}

			// customer identity (bring-your-own identity: the website's issuer from the entitlement document)
			if (r.identity) {
				const verified = product.identity.verify(request, { doc: ctx.entitlement?.doc, body: ctx.body });
				if (verified.ok) ctx.identity = verified.identity;
				else {
					ctx.identityProblem = verified.code;
					if (r.identity === 'required') {
						return fail(
							verified.code === 'identity_missing'
								? problem('identity_required', 'Send the customer token in the SS-Identity header.')
								: verified.code === 'identity_not_configured'
									? problem('identity_required', 'This website has no identity issuer configured.')
									: problem('identity_invalid', `The customer token was refused (${verified.code}).`),
						);
					}
				}
			}

			// rate limit (the limit may depend on the request, e.g. a plan feature: `limit: (ctx) => number`)
			/** @type {number | null} */
			let limit = null;
			if (r.rateLimit) {
				try {
					const value = typeof r.rateLimit.limit === 'function' ? await r.rateLimit.limit(ctx) : r.rateLimit.limit;
					if (value === Number.POSITIVE_INFINITY || value === null) limit = null;
					else if (Number.isSafeInteger(value) && value >= 0) limit = value;
					else log.error('rate limit is not a non-negative integer; not limiting', { route: r.id });
				} catch (error) {
					log.error('rate limit function failed; not limiting', { route: r.id, error });
				}
			}
			if (r.rateLimit && limit !== null) {
				const forwarded = trustForwardedFor ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
				const subject = r.rateLimit.key
					? await r.rateLimit.key(ctx)
					: ctx.website
						? `w:${ctx.website.websiteId}`
						: ctx.session
							? `s:${ctx.session.subject}`
							: `ip:${forwarded ?? 'unknown'}`;
				try {
					const { count, resetAt } = await stores.rateLimits.hit(
						`${r.rateLimit.bucket ?? r.id}|${subject}`,
						/** @type {number} */ (r.rateLimit.windowMs),
						now(),
					);
					const reset = Math.max(0, Math.ceil((resetAt - now()) / 1000));
					extra['ratelimit-limit'] = String(limit);
					extra['ratelimit-remaining'] = String(Math.max(0, limit - count));
					extra['ratelimit-reset'] = String(reset);
					if (count > limit) {
						extra['retry-after'] = String(Math.max(1, reset));
						return fail(problem('rate_limited', 'Too many requests.'));
					}
				} catch (error) {
					log.warn('rate limit store failed; allowing request', { error });
				}
			}

			// idempotency
			/** @type {string | null} */
			let idempotencyRecord = null;
			const replayStamp = ctx.website
				? { merchantId: ctx.website.merchantId, env: ctx.website.env }
				: ctx.entitlement
					? { merchantId: ctx.entitlement.doc.merchantId, env: ctx.entitlement.doc.env }
					: {};
			const idempotent = method === 'POST' ? (r.idempotent ?? true) : false;
			if (idempotent) {
				const key = request.headers.get('idempotency-key');
				if (key === null) {
					if (idempotent === true) return fail(problem('idempotency_key_required', 'Send an Idempotency-Key header.'));
				} else {
					if (!IDEMPOTENCY_KEY.test(key)) return fail(problem('bad_request', 'The Idempotency-Key is invalid.'));
					const principal = ctx.website?.websiteId ?? ctx.session?.subject ?? (ctx.portal ? 'portal' : 'anonymous');
					idempotencyRecord = ctxKit.hmac(`key\n${principal}\n${r.id}\n${pathname}\n${key}`);
					const fingerprint = ctxKit.hmac(`fingerprint\n${method}\n${pathname}\n${url.search}\n${ctx.rawBody}`);
					const begun = await stores.idempotency.begin(idempotencyRecord, fingerprint, now() + 24 * 60 * 60_000);
					if (begun.state === 'mismatch')
						return fail(problem('idempotency_conflict', 'This Idempotency-Key was used with a different request.'));
					if (begun.state === 'pending') {
						extra['retry-after'] = '1';
						return fail(problem('conflict', 'A request with this Idempotency-Key is still in progress.'));
					}
					if (begun.state === 'done') {
						const stored = begun.response;
						const replay = stored.replay ?? 'none';
						/** @type {string | null} */
						let body = null;
						if (replay === 'website' && ctx.websiteId) {
							body = await ctxKit.replayBodies.get({
								websiteId: ctx.websiteId,
								stamp: replayStamp,
								key: idempotencyRecord,
							});
						}
						if (replay !== 'empty' && body === null) {
							return fail(
								problem(
									'idempotency_replay_no_body',
									'This request was already processed, but its response body is not available for replay.',
								),
							);
						}
						extra['idempotent-replayed'] = 'true';
						return finish({ status: stored.status, headers: stored.headers, body });
					}
				}
			}

			// handler
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
				} else if (isResult(out)) {
					rendered = render(out, requestId, pathname);
				} else {
					rendered = render(out === undefined ? noContent() : ok(out), requestId, pathname);
				}
			} catch (error) {
				if (isProblem(error)) rendered = render(error, requestId, pathname);
				else {
					log.error('route handler failed', { error, route: r.id });
					rendered = render(problem('internal_error'), requestId, pathname);
				}
			}
			if (idempotencyRecord) {
				if (rendered.status < 500) {
					const hasBody = rendered.body !== null && rendered.body !== '';
					/** @type {StoredResponse['replay']} */
					let replay = hasBody ? 'none' : 'empty';
					if (hasBody && ctx.websiteId) {
						const put = await ctxKit.replayBodies.put({
							websiteId: ctx.websiteId,
							stamp: replayStamp,
							key: idempotencyRecord,
							body: /** @type {string} */ (rendered.body),
						});
						if (put) replay = 'website';
					}
					/** @type {StoredResponse} */
					const stored = { status: rendered.status, headers: replayHeaders(rendered.headers), replay };
					await stores.idempotency.complete(idempotencyRecord, stored);
				} else await stores.idempotency.release(idempotencyRecord);
			}
			return finish(rendered);
		} catch (error) {
			log.error('request failed', { error });
			return fail(problem('internal_error'));
		}
	};
};
