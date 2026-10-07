/**
 * Route definitions and matching. Paths are `/`-separated; a segment `:name` captures a parameter; anything else is
 * literal (so `/v1/items:search` is a literal segment).
 * @module
 */

/** @typedef {'website' | 'launch' | 'none'} AuthMode */
/** @typedef {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} Method */

/**
 * @typedef {object} RouteDefinition
 * @property {Method} method
 * @property {string} path
 * @property {AuthMode} auth
 * @property {string[]} [scopes] website-key scopes required
 * @property {'pk' | 'sk'} [keyKind] restrict to one key kind
 * @property {string[]} [roles] launch-session roles allowed (default any)
 * @property {string} [element] element that must be enabled in the entitlement document
 * @property {boolean} [idempotent] true = a repeated `Idempotency-Key` (same website or session, same route, within
 *   24 h) answers 409 `duplicate_request`; requests without the header run normally. Default false: the header is ignored
 * @property {{ limit: number | ((ctx: any) => number | Promise<number>), windowMs?: number, windowSeconds?: number,
 *   key?: (ctx: any) => string | Promise<string>, bucket?: string }} [rateLimit]
 *   fixed window (`windowMs` or `windowSeconds`). `limit` may be a (sync or async) function of the request context,
 *   evaluated after auth, the entitlement, the JSON body and the customer identity (e.g.
 *   `(ctx) => feature(ctx.entitlement.doc, 'chat.messagesPerMinute')`), returning an integer ≥ 0 (0 refuses every
 *   request) or `Infinity` (no limit). `key(ctx)` is the subject (default: website, session or client IP); `bucket`
 *   shares one window between routes (default: the route id)
 * @property {boolean} [rawBody] do not parse JSON (handler reads `ctx.rawBody`)
 * @property {number} [maxBodyBytes]
 * @property {boolean} [entitlement] website auth: load the entitlement (default true)
 * @property {boolean} [cors] allow cross-origin browser calls (default: true for website auth)
 * @property {'required' | 'optional'} [identity] website auth: verify the customer's `SS-Identity` token against the
 *   website's identity issuer (entitlement document) into `ctx.identity`; `required` answers 401 without a valid one,
 *   `optional` leaves `ctx.identity` null (and `ctx.identityProblem` set) when it is absent or invalid
 * @property {boolean} [connected] the route needs the Portal connection (default true): before setup it answers 503
 * @property {(ctx: any) => unknown} handler
 */

/** @typedef {RouteDefinition & { segments: string[], id: string }} CompiledRoute */

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH = new Set(['website', 'launch', 'none']);

/**
 * Validate and freeze a route definition.
 * @param {RouteDefinition} definition
 * @returns {Readonly<RouteDefinition>}
 */
export const defineRoute = (definition) => {
	const { method, path, auth, handler } = definition;
	if (!METHODS.has(method)) throw new TypeError(`route method must be one of ${[...METHODS].join(', ')}`);
	if (typeof path !== 'string' || !path.startsWith('/') || /\s/.test(path))
		throw new TypeError(`route path must start with /: ${path}`);
	if (!AUTH.has(auth)) throw new TypeError(`route auth must be website, launch or none (${method} ${path})`);
	if (typeof handler !== 'function') throw new TypeError(`route ${method} ${path} needs a handler`);
	if (definition.element !== undefined && auth !== 'website' && auth !== 'launch') {
		throw new TypeError(`element gating needs website or launch auth (${method} ${path})`);
	}
	if (definition.identity !== undefined) {
		if (definition.identity !== 'required' && definition.identity !== 'optional')
			throw new TypeError(`route identity must be 'required' or 'optional' (${method} ${path})`);
		if (auth !== 'website' || definition.entitlement === false)
			throw new TypeError(`route identity needs website auth with the entitlement (${method} ${path})`);
	}
	/** @type {RouteDefinition['rateLimit']} */
	let rateLimit;
	if (definition.rateLimit) {
		const { limit, windowMs, windowSeconds, key, bucket } = definition.rateLimit;
		const ms = windowMs ?? (Number.isInteger(windowSeconds) ? /** @type {number} */ (windowSeconds) * 1000 : undefined);
		const limitOk = typeof limit === 'function' || (Number.isInteger(limit) && limit >= 1);
		if (!limitOk || !Number.isInteger(ms) || /** @type {number} */ (ms) < 1) {
			throw new TypeError(`rateLimit needs an integer (or function) limit and windowMs or windowSeconds (${method} ${path})`);
		}
		if (key !== undefined && typeof key !== 'function')
			throw new TypeError(`rateLimit.key must be a function (${method} ${path})`);
		if (bucket !== undefined && (typeof bucket !== 'string' || !/^[\w.:-]{1,64}$/.test(bucket)))
			throw new TypeError(`rateLimit.bucket must be 1..64 word characters (${method} ${path})`);
		rateLimit = { limit, windowMs: /** @type {number} */ (ms), ...(key ? { key } : {}), ...(bucket ? { bucket } : {}) };
	}
	return Object.freeze({ ...definition, ...(rateLimit ? { rateLimit } : {}) });
};

/**
 * @param {string} path
 * @returns {string[]}
 */
export const splitPath = (path) => path.split('/').filter((segment) => segment.length > 0);

/**
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
		return { ...r, segments, id };
	});
};

/**
 * @param {CompiledRoute} route
 * @param {string[]} parts
 * @returns {Record<string, string> | null}
 */
export const matchPath = (route, parts) => {
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
 * Find the route for a method and path. Literal segments win over parameters.
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
