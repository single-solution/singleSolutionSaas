/**
 * Framework-agnostic request handling for the Portal API: `(Request) → Promise<Response>` over WHATWG Fetch types,
 * so the same handler runs under Next.js route handlers (`toNextRoute`), plain Node servers and tests.
 *
 * Pipeline per request:
 *
 *   request id → route match (404 / 405, CORS preflight) → body read with a byte cap (413) → authentication
 *   (`staff` | `merchant` session cookie, `websiteKey`, `product` client assertion, `public`) → CSRF for
 *   cookie-authenticated mutations (403) → RBAC permission (403) → rate limit (429 + `RateLimit-*`) → JSON body
 *   (415 / 400) → `Idempotency-Key` on POST (428 / 409 / replay) → handler → RFC 9457 problems for every error.
 *
 * Every request runs in a request scope (`request-scope.js`): work deferred with `ctx.defer` or `afterResponse()`
 * runs right after the response, and only then (no timers, PLAN F.19).
 *
 * The result helpers (`ok`, `created`, `problem`, `paginate`, …) mirror `@ss/app-kit`'s so products and the Portal
 * share one wire behaviour (problem documents, cursor pages `{ items, nextCursor, hasMore }` + `Link`, idempotent
 * replays with `Idempotent-Replayed: true`).
 * @module
 */
import { createId } from '@ss/contracts';
import { checkCsrf } from './auth.js';
import { requestOrigin, runInRequestScope } from './request-scope.js';
import { hmacHex, isObject, sha256Hex } from './util.js';

/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./rbac.js').Actor} Actor */
/** @typedef {import('./rbac.js').Resource} Resource */
/** @typedef {import('./stores.js').StoredResponse} StoredResponse */
/** @typedef {import('./stores.js').IdempotencyStore} IdempotencyStore */
/** @typedef {import('./stores.js').RateLimitStore} RateLimitStore */
/** @typedef {import('@ss/contracts').ProblemFactory} ProblemFactory */

/** @typedef {'staff' | 'merchant' | 'websiteKey' | 'product' | 'public'} AuthMode */
/** @typedef {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} Method */

export const AUTH_MODES = Object.freeze(/** @type {AuthMode[]} */ (['staff', 'merchant', 'websiteKey', 'product', 'public']));
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const CORS_HEADERS = 'authorization, content-type, idempotency-key, x-request-id';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/**
 * Problem codes the infra layer adds to `@ss/contracts`' set (registered by the composition root).
 *
 * `idempotency_replay_no_body` (409): the request was already completed under this `Idempotency-Key` on a route
 * whose response is never stored (`idempotent: 'no-store'`, e.g. responses carrying secrets). The original status
 * is named in `detail`; retry with a new key to perform the operation again.
 */
export const INFRA_PROBLEMS = Object.freeze({
	idempotency_replay_no_body: Object.freeze({ status: 409, title: 'Idempotent replay without a stored response' }),
});

// ---------------------------------------------------------------------------------------------------------------
// Results

const BRAND = Symbol.for('ss.platform.result');

/**
 * @typedef {{ [BRAND]: 'response', status: number, body: unknown, headers: Record<string, string>, cookies: string[] }} ResponseResult
 * @typedef {{ path: string, message: string, keyword?: string, code?: string }} FieldError
 * @typedef {{ [BRAND]: 'problem', code: string, status?: number, detail?: string, errors?: FieldError[], headers: Record<string, string> }} ProblemResult
 * @typedef {ResponseResult | ProblemResult} RouteResult
 */

/**
 * JSON response (default 200). `cookies` are full `Set-Cookie` values.
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string>, cookies?: string[] }} [init]
 * @returns {ResponseResult}
 */
export const ok = (body, { status = 200, headers = {}, cookies = [] } = {}) => ({
	[BRAND]: 'response',
	status,
	body,
	headers,
	cookies,
});

/**
 * 201 Created with optional `Location`.
 * @param {unknown} body
 * @param {{ location?: string, headers?: Record<string, string>, cookies?: string[] }} [init]
 */
export const created = (body, { location, headers = {}, cookies = [] } = {}) =>
	ok(body, { status: 201, headers: { ...headers, ...(location ? { location } : {}) }, cookies });

/**
 * 202 Accepted.
 * @param {unknown} body
 */
export const accepted = (body) => ok(body, { status: 202 });

/**
 * 204 No Content.
 * @param {{ cookies?: string[] }} [init]
 */
export const noContent = ({ cookies = [] } = {}) => ok(undefined, { status: 204, cookies });

/**
 * RFC 9457 problem for a registered code (`@ss/contracts` `PROBLEM_CODES` or a module's own codes). Return or throw.
 * @param {string} code
 * @param {string} [detail]
 * @param {{ errors?: FieldError[], headers?: Record<string, string>, status?: number }} [extra]
 * @returns {ProblemResult}
 */
export const problem = (code, detail, { errors, headers = {}, status } = {}) => ({
	[BRAND]: 'problem',
	code,
	...(status === undefined ? {} : { status }),
	...(detail === undefined ? {} : { detail }),
	...(errors === undefined ? {} : { errors }),
	headers,
});

/** @param {unknown} value */
const brandOf = (value) =>
	typeof value === 'object' && value !== null ? /** @type {Record<symbol, unknown>} */ (value)[BRAND] : undefined;

/**
 * @param {unknown} value
 * @returns {value is RouteResult}
 */
export const isResult = (value) => brandOf(value) === 'response' || brandOf(value) === 'problem';

/**
 * @param {unknown} value
 * @returns {value is ProblemResult}
 */
export const isProblem = (value) => brandOf(value) === 'problem';

// ---------------------------------------------------------------------------------------------------------------
// Pagination

/** @typedef {string | number | Array<string | number>} CursorKey */

/** @param {CursorKey} value */
const encodeCursor = (value) => Buffer.from(JSON.stringify({ k: value })).toString('base64url');

/**
 * @param {string} cursor
 * @returns {CursorKey}
 */
const decodeCursor = (cursor) => {
	if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw problem('bad_request', 'cursor is invalid');
	/** @param {unknown} v */
	const scalar = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
	try {
		const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		const key = isObject(parsed) ? parsed.k : undefined;
		if (scalar(key) || (Array.isArray(key) && key.length > 0 && key.length <= 4 && key.every(scalar)))
			return /** @type {CursorKey} */ (key);
	} catch {
		// fall through
	}
	throw problem('bad_request', 'cursor is invalid');
};

/**
 * Cursor pagination (Part E §5). Fetch `fetchLimit` (= limit + 1) items in key order after `after`, then `respond`.
 * @param {{ cursor?: string | null, limit?: string | number | null, url?: string | URL }} [input]
 * @param {{ defaultLimit?: number, maxLimit?: number }} [options]
 * @throws {ProblemResult} `bad_request` for an invalid cursor or limit
 */
export const paginate = ({ cursor, limit, url } = {}, { defaultLimit = 20, maxLimit = 100 } = {}) => {
	let n = defaultLimit;
	if (limit !== undefined && limit !== null && limit !== '') {
		n = typeof limit === 'number' ? limit : /^\d{1,6}$/.test(limit) ? Number(limit) : Number.NaN;
		if (!Number.isInteger(n) || n < 1 || n > maxLimit) throw problem('bad_request', `limit must be 1..${maxLimit}`);
	}
	const after = cursor ? decodeCursor(cursor) : null;
	/**
	 * @template T
	 * @param {T[]} items
	 * @param {(item: T) => CursorKey} keyOf
	 */
	const page = (items, keyOf) => {
		const hasMore = items.length > n;
		const slice = hasMore ? items.slice(0, n) : items;
		const last = slice[slice.length - 1];
		return { items: slice, nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null, hasMore };
	};
	return Object.freeze({
		limit: n,
		after,
		fetchLimit: n + 1,
		page,
		/**
		 * 200 `{ items, nextCursor, hasMore }` with `Link: <…>; rel="next"`.
		 * @template T
		 * @param {T[]} items
		 * @param {(item: T) => CursorKey} keyOf
		 * @param {(item: T) => unknown} [map] presentation of each item
		 */
		respond: (items, keyOf, map) => {
			const body = page(items, keyOf);
			/** @type {Record<string, string>} */
			const headers = {};
			if (body.nextCursor && url) {
				const next = new URL(url);
				next.searchParams.set('cursor', body.nextCursor);
				next.searchParams.set('limit', String(n));
				headers.link = `<${next.pathname}${next.search}>; rel="next"`;
			}
			return ok({ ...body, items: map ? body.items.map(map) : body.items }, { headers });
		},
	});
};

// ---------------------------------------------------------------------------------------------------------------
// Routes

/**
 * @typedef {object} RouteDefinition
 * @property {Method} method
 * @property {string} path `/v1/...`; `:name` segments capture parameters, anything else is literal
 * @property {AuthMode | AuthMode[]} auth one mode, or several tried in order (first credential present decides)
 * @property {string} [permission] RBAC permission checked against `resource(ctx)`
 * @property {(ctx: RequestContext) => Resource} [resource] default `{ merchantId: params.merchantId ?? actor.merchantId, websiteId: params.websiteId }`
 * @property {boolean} [mfa] staff sessions must have completed MFA (default true; false only for the MFA step itself)
 * @property {'pk' | 'sk'} [keyKind] websiteKey: restrict to one key kind
 * @property {string[]} [scopes] websiteKey: scopes the key must grant
 * @property {boolean | 'optional' | 'no-store'} [idempotent] POST: true = Idempotency-Key required (default),
 *   'optional', false, or 'no-store' — the key is optional and only the status and fingerprint are kept, so a replay
 *   answers 409 `idempotency_replay_no_body` instead of re-sending the response (use for responses with secrets)
 * @property {{ limit: number, windowMs: number, key?: (ctx: RequestContext) => string }} [rateLimit]
 * @property {number} [maxBodyBytes]
 * @property {boolean} [rawBody] do not parse JSON (handler reads `ctx.rawBody`)
 * @property {boolean} [cors] allow cross-origin browser calls (pk_ origins are reflected)
 * @property {(ctx: RequestContext) => unknown} handler
 */

/** @typedef {Readonly<RouteDefinition> & { modes: AuthMode[], segments: string[], id: string }} CompiledRoute */

/**
 * Validate and freeze a route definition.
 * @param {RouteDefinition} definition
 * @returns {Readonly<RouteDefinition>}
 */
export const defineRoute = (definition) => {
	const { method, path, auth, handler, rateLimit } = definition;
	if (!METHODS.has(method)) throw new TypeError(`route method must be one of ${[...METHODS].join(', ')}`);
	if (typeof path !== 'string' || !path.startsWith('/') || /\s/.test(path))
		throw new TypeError(`route path must start with /: ${path}`);
	const modes = Array.isArray(auth) ? auth : [auth];
	if (modes.length === 0 || modes.some((mode) => !AUTH_MODES.includes(mode))) {
		throw new TypeError(`route auth must be ${AUTH_MODES.join(', ')} (${method} ${path})`);
	}
	if (modes.includes('public') && modes.length > 1)
		throw new TypeError(`public cannot be combined with other modes (${method} ${path})`);
	if (definition.permission !== undefined && modes.includes('public')) {
		throw new TypeError(`permission needs an authenticated actor (${method} ${path})`);
	}
	if (typeof handler !== 'function') throw new TypeError(`route ${method} ${path} needs a handler`);
	if (
		rateLimit &&
		(!Number.isInteger(rateLimit.limit) ||
			rateLimit.limit < 1 ||
			!Number.isInteger(rateLimit.windowMs) ||
			rateLimit.windowMs < 1)
	) {
		throw new TypeError(`rateLimit needs integer limit and windowMs (${method} ${path})`);
	}
	return Object.freeze({ ...definition });
};

/** @param {string} path */
const splitPath = (path) => path.split('/').filter((segment) => segment.length > 0);

/**
 * Compile routes; duplicate method + path shapes (from any module) are a boot error.
 * @param {ReadonlyArray<RouteDefinition>} routes
 * @returns {CompiledRoute[]}
 */
export const compileRoutes = (routes) => {
	const seen = new Set();
	return routes.map((route) => {
		const r = defineRoute(route);
		const segments = splitPath(r.path);
		const id = `${r.method} /${segments.map((s) => (s.startsWith(':') ? ':' : s)).join('/')}`;
		if (seen.has(id)) throw new TypeError(`duplicate route ${id}`);
		seen.add(id);
		return Object.freeze({ ...r, modes: Array.isArray(r.auth) ? [...r.auth] : [r.auth], segments, id });
	});
};

/**
 * @param {CompiledRoute} route
 * @param {string[]} parts
 * @returns {Record<string, string> | null}
 */
const matchPath = (route, parts) => {
	if (route.segments.length !== parts.length) return null;
	/** @type {Record<string, string>} */
	const params = {};
	for (let i = 0; i < parts.length; i += 1) {
		const segment = /** @type {string} */ (route.segments[i]);
		const part = /** @type {string} */ (parts[i]);
		if (segment.startsWith(':')) {
			try {
				params[segment.slice(1)] = decodeURIComponent(part);
			} catch {
				return null;
			}
		} else if (segment !== part) return null;
	}
	return params;
};

/**
 * Find the route for a method and path; literal segments win over parameters.
 * @param {CompiledRoute[]} routes
 * @param {string} method
 * @param {string} pathname
 * @returns {{ route: CompiledRoute, params: Record<string, string> } | { route: null, allow: string[] }}
 */
export const matchRoute = (routes, method, pathname) => {
	const parts = splitPath(pathname);
	/** @type {Array<{ route: CompiledRoute, params: Record<string, string> }>} */
	const candidates = [];
	for (const route of routes) {
		const params = matchPath(route, parts);
		if (params) candidates.push({ route, params });
	}
	const score = (/** @type {CompiledRoute} */ r) => r.segments.filter((s) => !s.startsWith(':')).length;
	candidates.sort((a, b) => score(b.route) - score(a.route));
	const wanted = method === 'HEAD' ? 'GET' : method;
	const hit = candidates.find((c) => c.route.method === wanted);
	if (hit) return hit;
	return { route: null, allow: [...new Set(candidates.map((c) => c.route.method))] };
};

// ---------------------------------------------------------------------------------------------------------------
// Handler

/**
 * @typedef {object} AuthOutcome
 * @property {true} ok
 * @property {Actor | null} actor
 * @property {AuthMode} mode
 * @property {boolean} [cookie] authenticated by a cookie (CSRF applies)
 * @property {import('./auth.js').Session} [session]
 * @property {import('@ss/protocol').WebsiteKeyClaims & { kid: string }} [website]
 * @property {{ appId: string }} [app]
 * @property {Record<string, string>} [headers] extra response headers (e.g. CORS for pk_)
 */

/**
 * An authenticator returns `null` when its credential is absent, a problem when present but invalid, or an outcome.
 * @typedef {(request: Request, route: CompiledRoute) => Promise<AuthOutcome | ProblemResult | null>} Authenticator
 */

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
 * @property {unknown} body parsed JSON (undefined when empty or for `rawBody` routes)
 * @property {string} rawBody
 * @property {Uint8Array} rawBytes the body bytes (`rawBody` is their UTF-8 decoding), e.g. binary uploads
 * @property {string | null} ip client IP (only when proxy headers are trusted)
 * @property {AuthMode | null} authMode
 * @property {Actor | null} actor
 * @property {import('./auth.js').Session | null} session
 * @property {(import('@ss/protocol').WebsiteKeyClaims & { kid: string }) | null} website
 * @property {{ appId: string } | null} app
 * @property {string | undefined} idempotencyKey
 * @property {(permission: string, resource?: Resource) => void} authorize throws a 403 problem unless allowed
 * @property {(task: () => Promise<unknown>) => void} defer run `task` after the response (Next.js `after()` when the
 *   adapter provided it); failures are logged, never seen by the client
 * @property {Logger} log
 */

/** @typedef {(task: () => Promise<unknown>) => void} AfterScheduler */

/**
 * What the handler hands to `afterResponse` once the response is built: the tasks deferred during the request (a
 * live list: tasks deferred while they run are appended), the framework's scheduler for this request (null outside
 * Next.js) and the product that called (`product` auth), so its own pending work can follow the request.
 * @typedef {{ deferred: Array<() => Promise<unknown>>, schedule: AfterScheduler | null, log: Logger,
 *   app: { appId: string } | null }} AfterResponse
 */

/** Per-request `after()` schedulers registered by `toNextRoute(handler, { after })`. */
const SCHEDULERS = new WeakMap();

/**
 * @param {Request} request
 * @param {number} max
 * @returns {Promise<{ ok: true, text: string, bytes: Uint8Array } | { ok: false }>}
 */
const readBody = async (request, max) => {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > max) return { ok: false };
	if (!request.body) return { ok: true, text: '', bytes: new Uint8Array(0) };
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
	const bytes = Buffer.concat(chunks);
	return { ok: true, text: bytes.toString('utf8'), bytes };
};

/**
 * Create the API handler.
 * @param {{
 *   routes: ReadonlyArray<RouteDefinition>,
 *   problems: ProblemFactory,
 *   logger: Logger,
 *   authenticators: Partial<Record<AuthMode, Authenticator>>,
 *   can: (actor: Actor | null, permission: string, resource?: Resource) => boolean,
 *   idempotency: IdempotencyStore,
 *   idempotencySecret?: Uint8Array,
 *   rateLimits: RateLimitStore,
 *   now?: () => number,
 *   randomBytes?: (n: number) => Uint8Array,
 *   maxBodyBytes?: number,
 *   basePath?: string,
 *   afterResponse?: (input: AfterResponse) => void,
 * }} options `afterResponse` schedules the deferred tasks and any background work after each response
 * @returns {(request: Request) => Promise<Response>}
 */
export const createApiHandler = ({
	routes,
	problems,
	logger,
	authenticators,
	can,
	idempotency,
	idempotencySecret,
	rateLimits,
	now = Date.now,
	randomBytes,
	maxBodyBytes = 1024 * 1024,
	basePath = '/api',
	afterResponse,
}) => {
	if (!idempotencySecret || idempotencySecret.length < 32)
		throw new TypeError('idempotencySecret (at least 32 bytes) is required for request fingerprints');
	const fingerprintKey = Buffer.from(idempotencySecret);
	const compiled = compileRoutes(routes);
	for (const route of compiled) {
		for (const mode of route.modes) {
			if (mode !== 'public' && !authenticators[mode]) throw new TypeError(`no authenticator for ${mode} (${route.id})`);
		}
	}

	/**
	 * @param {RouteResult} result
	 * @param {string} requestId
	 * @param {string} instance
	 * @returns {StoredResponse & { cookies: string[] }}
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
			} catch {
				doc = problems.create('internal_error', { requestId, instance });
			}
			return {
				status: doc.status,
				headers: [...Object.entries(result.headers), ['content-type', 'application/problem+json']],
				body: JSON.stringify(doc),
				cookies: [],
			};
		}
		const hasBody = result.body !== undefined && result.status !== 204 && result.status !== 304;
		return {
			status: result.status,
			headers: [
				...(hasBody ? [/** @type {[string, string]} */ (['content-type', 'application/json'])] : []),
				...Object.entries(result.headers),
			],
			body: hasBody ? JSON.stringify(result.body) : '',
			cookies: result.cookies,
		};
	};

	/**
	 * @param {Request} request
	 * @param {Array<() => Promise<unknown>>} deferred the request scope's deferred tasks
	 */
	const serve = async (request, deferred) => {
		const started = now();
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const presented = request.headers.get('x-request-id');
		const requestId = presented && REQUEST_ID.test(presented) ? presented : createId('req', randomBytes ? { randomBytes } : {});
		const log = logger.child({ requestId });
		let pathname = url.pathname;
		if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`)))
			pathname = pathname.slice(basePath.length) || '/';
		// the client IP as the first hop (the proxy in front of us) saw it: the last X-Forwarded-For entry
		const ip = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || null;
		const origin = request.headers.get('origin');
		/** @type {Record<string, string>} */
		const extra = { 'x-request-id': requestId };
		/** @type {Actor | null} */
		let actor = null;
		/** @type {{ appId: string } | null} */
		let app = null;

		/** @param {StoredResponse & { cookies?: string[] }} rendered */
		const finish = (rendered) => {
			if (afterResponse) {
				try {
					afterResponse({ deferred, schedule: SCHEDULERS.get(request) ?? null, log, app });
				} catch (error) {
					log.warn('after-response scheduling failed', { error });
				}
			}
			const headers = new Headers();
			for (const [name, value] of rendered.headers) headers.set(name, value);
			for (const [name, value] of Object.entries(extra)) headers.set(name, value);
			if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
			for (const cookie of rendered.cookies ?? []) headers.append('set-cookie', cookie);
			log.info('request', {
				method,
				path: pathname,
				status: rendered.status,
				ms: now() - started,
				...(actor ? { actor: `${actor.type}:${actor.id}` } : {}),
			});
			const empty = method === 'HEAD' || rendered.body === '' || rendered.status === 204 || rendered.status === 304;
			return new Response(empty ? null : rendered.body, { status: rendered.status, headers });
		};
		/** @param {ProblemResult} p */
		const fail = (p) => finish(render(p, requestId, pathname));

		try {
			if (method === 'OPTIONS') {
				const parts = splitPath(pathname);
				const matching = compiled.filter((r) => matchPath(r, parts) !== null);
				const methods = [...new Set(matching.map((r) => r.method))];
				if (methods.length === 0) return fail(problem('not_found', 'No such resource.'));
				if (origin && matching.some((r) => r.cors === true)) {
					extra['access-control-allow-origin'] = origin;
					extra['access-control-allow-methods'] = methods.join(', ');
					extra['access-control-allow-headers'] = CORS_HEADERS;
					extra['access-control-max-age'] = '600';
					extra.vary = 'Origin';
				}
				extra.allow = [...methods, 'OPTIONS'].join(', ');
				return finish({ status: 204, headers: [], body: '' });
			}

			const matched = matchRoute(compiled, method, pathname);
			if (!matched.route) {
				const allow = /** @type {{ allow: string[] }} */ (matched).allow;
				if (allow.length === 0) return fail(problem('not_found', 'No such resource.'));
				extra.allow = allow.join(', ');
				return fail(problem('method_not_allowed'));
			}
			const route = matched.route;

			// body (before auth; signatures and fingerprints cover the raw bytes)
			let rawBody = '';
			/** @type {Uint8Array} */
			let rawBytes = new Uint8Array(0);
			if (BODY_METHODS.has(method)) {
				const cap = route.maxBodyBytes ?? maxBodyBytes;
				const read = await readBody(request, cap);
				if (!read.ok) return fail(problem('payload_too_large', `The body exceeds ${cap} bytes.`));
				rawBody = read.text;
				rawBytes = read.bytes;
			}

			// authentication
			/** @type {AuthOutcome | null} */
			let auth = null;
			if (route.modes.includes('public')) auth = { ok: true, actor: null, mode: 'public' };
			else {
				for (const mode of route.modes) {
					const outcome = await /** @type {Authenticator} */ (authenticators[mode])(request, route);
					if (outcome === null) continue;
					if (isProblem(outcome)) {
						Object.assign(extra, outcome.headers);
						return fail(outcome);
					}
					auth = outcome;
					break;
				}
				if (!auth) return fail(problem('unauthorized', 'Authentication is required.'));
			}
			actor = auth.actor;
			app = auth.app ?? null;
			Object.assign(extra, auth.headers ?? {});

			// CSRF (cookie sessions only)
			if (auth.cookie) {
				const csrf = checkCsrf({ method, headers: request.headers, allowedOrigin: requestOrigin(request) });
				if (!csrf.ok) return fail(problem('forbidden', 'Cross-site request refused.'));
			}

			/** @type {RequestContext} */
			const ctx = {
				request,
				requestId,
				method,
				path: pathname,
				params: matched.params,
				query: Object.fromEntries(
					[...url.searchParams.keys()].map((key) => [key, /** @type {string} */ (url.searchParams.get(key))]),
				),
				searchParams: url.searchParams,
				headers: request.headers,
				body: undefined,
				rawBody,
				rawBytes,
				ip,
				authMode: auth.mode,
				actor,
				session: auth.session ?? null,
				website: auth.website ?? null,
				app: auth.app ?? null,
				idempotencyKey: undefined,
				authorize: (permission, resource) => {
					if (!can(actor, permission, resource)) throw problem('forbidden', `Missing permission ${permission}.`);
				},
				defer: (task) => {
					deferred.push(task);
				},
				log,
			};

			// RBAC
			if (route.permission) {
				const resource = route.resource
					? route.resource(ctx)
					: { merchantId: ctx.params.merchantId ?? actor?.merchantId ?? null, websiteId: ctx.params.websiteId ?? null };
				if (!can(actor, route.permission, resource))
					return fail(problem('forbidden', `Missing permission ${route.permission}.`));
			}

			// rate limit
			if (route.rateLimit) {
				const subject = route.rateLimit.key
					? route.rateLimit.key(ctx)
					: actor
						? `${actor.type}:${actor.id}`
						: `ip:${ip ?? 'unknown'}`;
				try {
					const { count, resetAt } = await rateLimits.hit(`${route.id}|${subject}`, route.rateLimit.windowMs, now());
					const reset = Math.max(0, Math.ceil((resetAt - now()) / 1000));
					extra['ratelimit-limit'] = String(route.rateLimit.limit);
					extra['ratelimit-remaining'] = String(Math.max(0, route.rateLimit.limit - count));
					extra['ratelimit-reset'] = String(reset);
					if (count > route.rateLimit.limit) {
						extra['retry-after'] = String(Math.max(1, reset));
						return fail(problem('rate_limited', 'Too many requests.'));
					}
				} catch (error) {
					log.warn('rate limit store failed; allowing request', { error });
				}
			}

			// JSON body
			if (!route.rawBody && rawBody.length > 0) {
				const type = (request.headers.get('content-type') ?? '').toLowerCase();
				if (!/^application\/([a-z0-9.+-]+\+)?json(\s*;|$)/.test(type))
					return fail(problem('unsupported_media_type', 'Send application/json.'));
				try {
					ctx.body = JSON.parse(rawBody);
				} catch {
					return fail(problem('bad_request', 'The body is not valid JSON.'));
				}
			}

			// idempotency
			/** @type {string | null} */
			let record = null;
			const idempotent = method === 'POST' ? (route.idempotent ?? true) : false;
			const noStore = idempotent === 'no-store';
			if (idempotent) {
				const key = request.headers.get('idempotency-key');
				if (key === null) {
					if (idempotent === true) return fail(problem('idempotency_key_required', 'Send an Idempotency-Key header.'));
				} else {
					if (!IDEMPOTENCY_KEY.test(key)) return fail(problem('bad_request', 'The Idempotency-Key is invalid.'));
					ctx.idempotencyKey = key;
					const principal = actor ? `${actor.type}:${actor.id}` : `anon:${ip ?? 'unknown'}`;
					record = sha256Hex(`${principal}\n${route.id}\n${pathname}\n${key}`);
					// keyed: bodies may hold passwords or credentials, a plain hash could be brute-forced offline
					const fingerprint = hmacHex(fingerprintKey, `ss-idem.v1\n${method}\n${pathname}\n${url.search}\n${rawBody}`);
					const begun = await idempotency.begin(record, fingerprint, now() + IDEMPOTENCY_TTL_MS);
					if (begun.state === 'mismatch')
						return fail(problem('idempotency_conflict', 'This Idempotency-Key was used with a different request.'));
					if (begun.state === 'pending') {
						extra['retry-after'] = '1';
						return fail(problem('conflict', 'A request with this Idempotency-Key is still in progress.'));
					}
					if (begun.state === 'done') {
						extra['idempotent-replayed'] = 'true';
						if (begun.response.body === null) {
							return fail(
								problem(
									'idempotency_replay_no_body',
									`This request already completed with status ${begun.response.status}; its response is not stored. Use a new Idempotency-Key to repeat it.`,
								),
							);
						}
						return finish(/** @type {StoredResponse} */ (begun.response));
					}
				}
			}

			// handler
			/** @type {StoredResponse & { cookies: string[] }} */
			let rendered;
			try {
				const out = await route.handler(ctx);
				if (out instanceof Response) {
					// bytes pass through unchanged (binary assets); a stored idempotent response keeps its text
					const text = record ? await out.text() : /** @type {any} */ (new Uint8Array(await out.arrayBuffer()));
					rendered = {
						status: out.status,
						headers: [...out.headers.entries()].filter(([name]) => name !== 'set-cookie'),
						body: text,
						cookies: out.headers.getSetCookie(),
					};
				} else if (isResult(out)) rendered = render(out, requestId, pathname);
				else rendered = render(out === undefined ? noContent() : ok(out), requestId, pathname);
			} catch (error) {
				if (isProblem(error)) rendered = render(error, requestId, pathname);
				else {
					log.error('route handler failed', { error, route: route.id });
					rendered = render(problem('internal_error'), requestId, pathname);
				}
			}
			if (record) {
				// cookies are never stored: a replay does not re-issue a session
				if (rendered.status >= 500) await idempotency.release(record);
				else if (noStore) await idempotency.complete(record, { status: rendered.status, headers: [], body: null });
				else await idempotency.complete(record, { status: rendered.status, headers: rendered.headers, body: rendered.body });
			}
			return finish(rendered);
		} catch (error) {
			log.error('request failed', { error });
			return fail(problem('internal_error'));
		}
	};

	return (/** @type {Request} */ request) => {
		/** @type {Array<() => Promise<unknown>>} */
		const deferred = [];
		return runInRequestScope({ defer: (task) => void deferred.push(task) }, () => serve(request, deferred));
	};
};

/**
 * Next.js App Router adapter: `export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute(handler)`.
 * The handler strips its own `basePath` (`/api`), so routes are declared as `/v1/...` whether they are reached at
 * `/api/v1/...` or through the `/v1/:path*` rewrite. Pass Next's `after` (`import { after } from 'next/server.js'`)
 * so deferred work (the request's own jobs, deliveries, settlement) runs after the response on serverless hosts.
 * @param {(request: Request) => Promise<Response>} handler
 * @param {{ after?: AfterScheduler }} [options]
 * @returns {Readonly<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS', (request: Request) => Promise<Response>>>}
 */
export const toNextRoute = (handler, { after } = {}) => {
	/** @param {Request} request */
	const route = (request) => {
		if (typeof after === 'function') SCHEDULERS.set(request, after);
		return handler(request);
	};
	return Object.freeze({ GET: route, POST: route, PUT: route, PATCH: route, DELETE: route, HEAD: route, OPTIONS: route });
};
