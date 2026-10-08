/**
 * Route definitions and matching. Paths are `/`-separated; a segment `:name` captures a parameter; anything else is
 * literal (so `/v1/items:search` is a literal segment). Literal segments win over parameters.
 * @module
 */

/** @typedef {'browser' | 'server' | 'ticket' | 'dashboard' | 'none'} AuthMode */
/** @typedef {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} Method */
/** @typedef {'merchant' | 'owner' | 'support'} DashboardRole */
/**
 * A fixed-window rate limit (a code constant): `per: 'website'` counts per website (the default when the request names
 * one), `per: 'visitor'` per client IP.
 * @typedef {{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }} RateLimit
 */

/**
 * @typedef {object} RouteDefinition
 * @property {Method} method
 * @property {string} path
 * @property {AuthMode} auth `browser`: browser token + allowed Origin (visitor routes, CORS for that origin);
 *   `server`: server token, refused with an Origin header; `ticket`: ticket + its Origin (CORS for it); `dashboard`:
 *   product dashboard session; `none`: public
 * @property {string | string[]} [feature] browser, server and ticket routes: answers 403 `feature_off` while the feature
 *   is off (a list: while all of them are off); ticket routes default to the feature of their `permission`
 * @property {string} [permission] ticket routes: the ticket must carry this permission
 * @property {boolean} [database] browser, server and ticket routes: false skips the 403 `database_not_connected` check
 * @property {boolean} [idempotent] a repeated `Idempotency-Key` (same website, same route, within 24 h) answers 409
 *   `duplicate_request`; requests without the header run normally
 * @property {RateLimit | RateLimit[]} [rateLimit]
 * @property {boolean} [rawBody] do not parse JSON (the handler reads `ctx.rawBody`)
 * @property {number} [maxBodyBytes] default 1 MiB
 * @property {DashboardRole[]} [roles] dashboard routes: who may call it (default everyone with a session)
 * @property {(ctx: any) => unknown} handler
 */

/** @typedef {RouteDefinition & { segments: string[], id: string }} CompiledRoute */

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH = new Set(['browser', 'server', 'ticket', 'dashboard', 'none']);
const WEBSITE_AUTH = new Set(['browser', 'server', 'ticket']);
const ROLES = new Set(['merchant', 'owner', 'support']);

/**
 * Validate and freeze a route definition.
 * @param {RouteDefinition} definition
 * @returns {Readonly<RouteDefinition>}
 */
export const defineRoute = (definition) => {
	const { method, path, auth, handler } = definition;
	const where = `(${method} ${path})`;
	if (!METHODS.has(method)) throw new TypeError(`route method must be one of ${[...METHODS].join(', ')}`);
	if (typeof path !== 'string' || !path.startsWith('/') || /\s/.test(path))
		throw new TypeError(`route path must start with /: ${path}`);
	if (!AUTH.has(auth)) throw new TypeError(`route auth must be browser, server, ticket, dashboard or none ${where}`);
	if (typeof handler !== 'function') throw new TypeError(`route needs a handler ${where}`);
	if ((definition.feature !== undefined || definition.database !== undefined) && !WEBSITE_AUTH.has(auth))
		throw new TypeError(`feature and database need browser, server or ticket auth ${where}`);
	if (
		definition.feature !== undefined &&
		!(typeof definition.feature === 'string' || (Array.isArray(definition.feature) && definition.feature.length > 0))
	)
		throw new TypeError(`feature is a feature key or a non-empty list of them ${where}`);
	if (definition.permission !== undefined && auth !== 'ticket') throw new TypeError(`permission needs ticket auth ${where}`);
	if (
		definition.roles !== undefined &&
		(auth !== 'dashboard' || !Array.isArray(definition.roles) || definition.roles.some((role) => !ROLES.has(role)))
	)
		throw new TypeError(`roles are merchant, owner or support on dashboard routes ${where}`);
	const limits = definition.rateLimit === undefined ? [] : [definition.rateLimit].flat();
	for (const limit of limits) {
		if (
			!Number.isInteger(limit?.limit) ||
			limit.limit < 1 ||
			!Number.isInteger(limit.windowSeconds) ||
			limit.windowSeconds < 1 ||
			(limit.per !== undefined && limit.per !== 'website' && limit.per !== 'visitor')
		)
			throw new TypeError(`rateLimit needs integer limit and windowSeconds, per website or visitor ${where}`);
	}
	return Object.freeze({ ...definition });
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
 * Find the route for a method and path.
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
