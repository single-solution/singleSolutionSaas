/**
 * The request handler: `(Request) → Promise<Response>` (WHATWG Fetch API). Pipeline per request:
 *
 *   configuration problems (503) → request id → CORS preflight → route match (404/405) → Portal connection (503 before
 *   connect, except `none` routes) → body with a byte cap (413) → auth (for the `browser`, `server` and `ticket` routes the
 *   token is checked first and the body read after it, so a call with no or a bad token never has its body read) → status
 *   of the product on the website (403
 *   `product_unavailable`, 503 `portal_unreachable`) → feature (403 `feature_off`) → merchant database (403
 *   `database_not_connected`) → JSON (415/400) → rate limits (429) → `Idempotency-Key` (the first answer again, or 409)
 *   → handler → RFC 9457 problems for every error.
 *
 * Auth: `browser` (browser token from `Authorization: Bearer`; the Origin must be `https://<exact domain>` or local,
 * CORS only for it; without an Origin, the server token: a visitor call from the merchant's server, PLAN 0.8.10 K3),
 * `server` (server token; refused when an Origin header is present; no CORS), `ticket` (ticket bound to the request's
 * Origin; CORS only for it), `dashboard` (session cookie; writes only from the product's own address; never framed),
 * `portal` (a call signed by the pinned Portal keys for this product, method, path, query and body, used once; its
 * website is `?websiteId=`; 401 `unauthorized` otherwise; no CORS) and `none`. Every token or ticket failure is the
 * same 401 `invalid_token`.
 *
 * A server-token route says who may call it (`staff.js`): `runtime` (the server token alone: shop reads, sends, imports
 * while the feature is on, calls between products), `permission` (the call must also carry the verified Accounts
 * sign-in of a staff member whose role grants it) or `staff` (any verified staff member). The acting person is the one
 * that verified sign-in names (`ctx.actor`); no header the caller wrote is ever taken as a person. A bare server token on
 * a staff route is 403 `needs_signed_in_staff`, a sign-in of another website, an expired or a forged one 401
 * `invalid_sign_in`, a role without the permission 403 `forbidden`. A visitor call from the merchant's server names its visitor with `SS-Visitor-IP`
 * (required on writes, else 400 `visitor_ip_required`), counts in its own window of 3,000 requests per minute per
 * route per website instead of the browser one, keeps the per-visitor limits (by that address) and never counts as
 * widget installed.
 *
 * Right after the response (Next.js `after`, through `toNextRoute`): a pending price report,
 * unsent activity copies, events and staff alerts, the staff named in a ticket or by a verified sign-in, the widget last-seen time,
 * the route's own work, and last a status copy older than 5 minutes and the revocation list, fetched again (K-19).
 * @module
 */
import { isIP } from 'node:net';
import {
	canonicalOrigin,
	isLocalOrigin,
	isProtocolError,
	originAllowed,
	sha256Hex,
	verifyPortalCall,
	verifyToken,
} from '@ss/protocol';
import { createId } from '@ss/contracts';
import { clientIpOf, createLocalWindows } from '@ss/net';
import { KIT_PERMISSIONS, SIGN_IN_DETAIL, checkStaff } from '../staff.js';
import { isDatabaseUnavailable } from '../data.js';
import { requestSignIn, requestStaffSignIn } from '../identity.js';
import { isKitError } from '../util.js';
import { isProblem, isResult, noContent, ok, problem } from './results.js';
import { compileRoutes, matchPath, matchRoute, splitPath } from './routes.js';

/** @typedef {import('./routes.js').RouteDefinition} RouteDefinition */
/** @typedef {import('./routes.js').CompiledRoute} CompiledRoute */
/** @typedef {import('./results.js').ProblemResult} ProblemResult */
/** @typedef {import('./results.js').RouteResult} RouteResult */
/**
 * An answer before it is sent: JSON and problems as text, a route's own `Response` as its exact bytes (a CSV keeps its
 * byte order mark, a file its binary content).
 * @typedef {{ status: number, headers: Record<string, string>, body: string | Uint8Array | null }} Rendered
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
 * @property {string | undefined} idempotencyKey
 * @property {unknown} body parsed JSON (undefined when empty or for `rawBody` routes)
 * @property {string} rawBody
 * @property {string | null} origin the canonical Origin header, if any
 * @property {string | null} websiteId
 * @property {string | null} merchantId
 * @property {import('@ss/contracts').StatusResponse | null} status the status response of the website
 * @property {import('@ss/protocol').TokenClaims | null} token browser or server token claims
 * @property {import('@ss/protocol').TicketClaims | null} ticket
 * @property {import('../actor.js').ActingUser | null} actor the member of the merchant's staff whose verified
 *   `SS-Sign-In` a staff route of the server token was called with (never a header the caller wrote), else null
 * @property {{ can: (permission: string) => boolean } | null} staff the verified staff member of a staff route of the
 *   server token: `can(key)` says whether their role grants the product's permission `key`; null on any other call. Guards
 *   inside handlers ask `allows(ctx, key)` (staff.js), which reads the ticket's permissions or this
 * @property {() => Promise<import('../identity.js').RequestSignIn | null>} signIn the visitor's Accounts sign-in from
 *   `SS-Sign-In`, verified once per request for the website of the request's own token (`{ ok: true, token, user, claims }`,
 *   `{ ok: false, code }`, or null without the header). On a browser route the merchant's server called for a visitor
 *   (`visitor.server`), a sign-in that is not valid never reaches the route: 401 `invalid_sign_in` (`cause`: the failure,
 *   for example `audience`, `expired`, `signature`), or 503 `accounts_unavailable`. A browser call keeps a wrong or
 *   expired sign-in as none.
 * @property {() => Promise<import('../identity.js').RequestSignIn | null>} staffSignIn the sign-in of a staff member from
 *   `SS-Sign-In`, verified once for the request's website by the product's own way (`staff.js`): the keys of the website's
 *   Accounts, fetched through the link, or Accounts' own keys, session and live role. The staff routes of the server token use it; null
 *   without the header
 * @property {{ server: boolean, ip: string | null }} visitor on browser routes: `server` when the merchant's server
 *   called with the server token for one visitor (K3), `ip` that visitor's `SS-Visitor-IP` (null when not sent)
 * @property {string} clientIp the visitor's address for per-visitor limits and risk checks: `SS-Visitor-IP` on a
 *   server-token visitor call, else the address the hosting layer saw (`X-Real-IP`, else the last `X-Forwarded-For` hop;
 *   `unknown` when there is none)
 * @property {import('../dashboard.js').Session | null} session dashboard session
 * @property {(task: () => Promise<unknown>) => void} after run work right after the response
 * @property {() => Promise<import('@ss/contracts').WebsiteSettings>} website the website's settings from the Portal
 *   (business facts, brand and theme, region and Format, pages, team), frozen; an empty document at version 0 while the
 *   Portal holds none (then the product uses its own values). Memory, then the product database: never the Portal on the
 *   hot path. Needs a website request
 * @property {() => Promise<import('../data.js').WebsiteData>} data the website's merchant database (tenant guard)
 * @property {import('@ss/net').Logger} log
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
/** A website id a Portal call names (`?websiteId=`). */
const WEBSITE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** How long the answer of an idempotent request is given again for a repeat of its `Idempotency-Key` (K-14). */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60_000;
/** A request still running holds its `Idempotency-Key` at most this long (the longest a serverless function runs). */
const IN_PROGRESS_MS = 5 * 60_000;
/** Largest answer body kept for a repeat; a repeat of a larger one is answered 409 `duplicate_request`. */
const REPLAY_MAX_CHARS = 64 * 1024;
/** Answer headers a repeat does not get again. */
const NOT_REPLAYED = new Set(['set-cookie']);
// `ss-sign-in`: a visitor's Accounts sign-in next to the browser token (signed-in visitor routes);
// `ss-guest`: a Chat guest's device key (Chat's guest visitor routes); `ss-order-key`: a guest order's key (Ecommerce)
const CORS_HEADERS = 'authorization, content-type, idempotency-key, ss-guest, ss-order-key, ss-sign-in, x-request-id';
/** Visitor calls from the merchant's server: their own window per route per website (PLAN 0.8.10 K3, code constant). */
export const SERVER_VISITOR_LIMIT = Object.freeze({ limit: 3000, windowSeconds: 60 });
const VISITOR_IP_HEADER = 'ss-visitor-ip';
const LAST_SEEN_EVERY_MS = 60 * 60_000;
const STAFF_EVERY_MS = 10 * 60_000;
const NO_FRAMES = Object.freeze({ 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
/** The answer while a merchant or product database cannot be reached or does not answer in time (K-16). */
const DATABASE_UNAVAILABLE = () =>
	problem('database_unavailable', 'The database cannot be reached right now. Try again shortly.', {
		headers: { 'retry-after': '5' },
	});

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
 * The kind a token says it is, read without checking anything: it only chooses which strict check the token then goes
 * through (a link key or the website's server token); that check still verifies the signature, issuer, product, website
 * and revocation.
 * @param {string} token
 * @returns {string | null}
 */
const kindClaimed = (token) => {
	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
		return typeof payload?.kind === 'string' ? payload.kind : null;
	} catch {
		return null;
	}
};

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
	const kitPermissions = new Set(KIT_PERMISSIONS.map((permission) => permission.key));
	/** @type {Map<string, string>} */
	const featureOfPermission = new Map(
		manifest.permissions.map((/** @type {{ key: string, feature: string }} */ p) => [p.key, p.feature]),
	);
	for (const route of compiled) {
		for (const key of route.feature === undefined ? [] : [route.feature].flat())
			if (!featureKeys.includes(key)) throw new TypeError(`route ${route.id}: unknown feature ${key}`);
		if (route.permission !== undefined && !featureOfPermission.has(route.permission) && !kitPermissions.has(route.permission))
			throw new TypeError(`route ${route.id}: unknown permission ${route.permission}`);
	}
	// the links: a route takes link keys only for a scope the manifest offers (the Portal grants only offered scopes)
	const offered = new Set((manifest.links?.offers ?? []).map((/** @type {{ scope: string }} */ offer) => offer.scope));
	for (const route of compiled)
		if (route.scope !== undefined && !offered.has(route.scope))
			throw new TypeError(`route ${route.id}: scope ${route.scope} is not offered in the manifest (links.offers)`);

	/** @type {Map<string, number>} */
	const lastWrites = new Map();
	// the limits' counters of this instance, used only while the shared rate store fails (SR-1-2)
	const localWindows = createLocalWindows();

	/**
	 * The website's database, asking the Portal for it once when this product holds none yet (a website just connected, or
	 * a product just added).
	 * @param {string} websiteId
	 */
	const databaseOf = async (websiteId) => {
		const held = await kit.connections.databaseOf(websiteId);
		if (held !== null) return held;
		await kit.portalConnections.ensure(websiteId);
		return kit.connections.databaseOf(websiteId);
	};

	/**
	 * @param {RouteResult} result
	 * @param {string} requestId
	 * @param {string} instance
	 * @returns {Rendered}
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
	 * Browser or server token of a request. A browser route without an Origin takes the server token: a visitor call
	 * from the merchant's server (PLAN 0.8.10 K3).
	 * @param {CompiledRoute} r
	 * @param {Request} request
	 * @param {string | null} rawOrigin
	 * @returns {Promise<import('@ss/protocol').TokenClaims | null>}
	 */
	const verifyWebsiteToken = async (r, request, rawOrigin) => {
		const kind = r.auth === 'browser' && rawOrigin !== null ? 'browser' : 'server';
		if (kind === 'server' && rawOrigin !== null) return null;
		const token = bearerOf(request.headers.get('authorization'));
		if (!token) return null;
		const { portalUrl, portalKeys } = kit.connection.active();
		// a route that names a scope also takes a link key; every other route takes the server token alone
		const link = kind === 'server' && r.scope !== undefined && kindClaimed(token) === 'link';
		try {
			const claims = await verifyToken({
				token,
				keyResolver: portalKeys,
				issuer: portalUrl,
				productId: manifest.id,
				kind: link ? 'link' : kind,
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
		const tasks = [
			async () => {
				if (r.database !== false) await kit.activity.retry(websiteId, ctx.merchantId);
			},
			async () => {
				// widget installed: a visitor-widget request from the real domain (never a local origin, never the server)
				if (r.auth !== 'browser' || ctx.visitor.server || ctx.origin === null || isLocalOrigin(ctx.origin)) return;
				if (now() - (lastWrites.get(`seen|${websiteId}`) ?? -Infinity) < LAST_SEEN_EVERY_MS) return;
				lastWrites.set(`seen|${websiteId}`, now());
				await store.put('widget', websiteId, { websiteId, lastSeenAt: now() });
			},
			async () => {
				// the merchant's staff named in a ticket, or by the verified sign-in of a staff route called with the server token
				const ticketUser = ctx.ticket?.user;
				const actor = ctx.actor;
				const user = ticketUser ? { id: ticketUser.id, name: ticketUser.name, email: ticketUser.email } : actor;
				if (!user) return;
				if (r.database === false && (await kit.connections.value(websiteId, 'database')) === null) return;
				const key = `staff|${websiteId}|${user.id}`;
				if (now() - (lastWrites.get(key) ?? -Infinity) < STAFF_EVERY_MS) return;
				lastWrites.set(key, now());
				const db = await ctx.data();
				await db.collection('staff').updateOne(
					{ websiteId, id: user.id },
					{
						$set: {
							name: user.name,
							...(user.email ? { email: user.email } : {}),
							...(actor?.role ? { role: actor.role } : {}),
							lastSeenAt: new Date(now()),
						},
					},
					{ upsert: true },
				);
			},
			async () => {
				if (r.database !== false) await kit.events.drain(websiteId, ctx.merchantId);
			},
			async () => {
				// staff alerts Notifications did not take (K-17, D7)
				if (r.database !== false) await kit.staffAlerts.retry(websiteId, ctx.merchantId);
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
		/** Portal fetches the request did not wait for (K-19), run after every other task. @type {Array<() => Promise<unknown>>} */
		const portalTasks = [];
		/** @type {CompiledRoute | null} */
		let route = null;
		/** @type {string | null} */
		let websiteId = null;

		/** @param {Rendered} rendered */
		const finish = (rendered) => {
			/** @type {(task: () => Promise<unknown>) => void} */
			const scheduler = SCHEDULERS.get(request) ?? options.after ?? ((task) => void task());
			if (kit.connection.connected()) afterTasks.unshift(() => kit.reports.syncManifest());
			if (afterTasks.length + portalTasks.length > 0)
				scheduler(async () => {
					/** @param {() => Promise<unknown>} task */
					const run = (task) => task().catch((error) => log.warn('work after the request failed', { error }));
					// read as they run: work that after-work adds with `ctx.after` runs too, before the Portal fetches
					for (const task of afterTasks) await run(task);
					for (const task of portalTasks) await run(task);
				});
			log.info('request', {
				method,
				path: pathname,
				status: rendered.status,
				ms: now() - started,
				...(websiteId ? { websiteId } : {}),
			});
			return new Response(method === 'HEAD' ? null : /** @type {BodyInit | null} */ (rendered.body), {
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
				actor: null,
				staff: null,
				visitor: { server: false, ip: null },
				signIn: async () => null,
				staffSignIn: async () => null,
				clientIp: clientIpOf(request.headers) ?? 'unknown',
				session: null,
				after: (task) => {
					afterTasks.push(task);
				},
				website: () => {
					if (!ctx.websiteId) throw problem('bad_request', 'This request names no website.');
					return kit.website.document(ctx.websiteId, { after: ctx.after });
				},
				data: () => {
					if (!ctx.websiteId) throw problem('bad_request', 'This request names no website.');
					return kit.data.forWebsite(ctx.websiteId, ctx.merchantId ? { merchantId: ctx.merchantId } : {});
				},
				log,
			};

			// a token route is read after its token is checked: a call with no or a bad token never has its body read (SR-1-3);
			// a Portal call is signed over its body, so that body is read first
			const tokenRoute = r.auth === 'browser' || r.auth === 'server' || r.auth === 'ticket';
			/** @returns {Promise<ProblemResult | null>} */
			const readRouteBody = async () => {
				if (!BODY_METHODS.has(method)) return null;
				const max = r.maxBodyBytes ?? 1024 * 1024;
				const text = await readBody(request, max);
				if (text === null) return problem('payload_too_large', `The body exceeds ${max} bytes.`);
				ctx.rawBody = text;
				return null;
			};
			if (!tokenRoute) {
				const refused = await readRouteBody();
				if (refused) return fail(refused);
			}

			// auth
			if (r.auth === 'browser' || r.auth === 'server') {
				const claims = await verifyWebsiteToken(r, request, rawOrigin);
				if (!claims) return fail(problem('invalid_token', 'The token is not valid.'));
				// a link key proves who calls; this product lets it do only what the Portal granted it on this website
				if (
					claims.kind === 'link' &&
					!(await kit.portalConnections.allows({
						websiteId: claims.websiteId,
						caller: /** @type {string} */ (claims.caller),
						scope: /** @type {string} */ (r.scope),
					}))
				)
					return fail(problem('scope_denied', 'This link does not allow that.'));
				ctx.token = claims;
				ctx.websiteId = claims.websiteId;
				if (r.auth === 'browser' && ctx.origin)
					Object.assign(extra, { 'access-control-allow-origin': ctx.origin, vary: 'Origin' });
				if (r.auth === 'browser' && claims.kind === 'server') {
					// a visitor call from the merchant's server (K3): its visitor's address names the visitor
					const ip = (request.headers.get(VISITOR_IP_HEADER) ?? '').trim();
					const known = isIP(ip) !== 0 ? ip : null;
					ctx.visitor = { server: true, ip: known };
					ctx.clientIp = known ?? 'unknown';
					if (method !== 'GET' && method !== 'HEAD' && known === null)
						return fail(problem('visitor_ip_required', `Send the visitor's IP address in SS-Visitor-IP.`));
				}
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
			} else if (r.auth === 'portal') {
				const { portalKeys } = kit.connection.active();
				try {
					await verifyPortalCall({
						headers: request.headers,
						audience: manifest.id,
						method,
						target: `${url.pathname}${url.search}`,
						rawBody: ctx.rawBody,
						keyResolver: portalKeys,
						replayStore: { seen: store.seen },
						now,
					});
				} catch (error) {
					if (!isProtocolError(error)) throw error;
					return fail(problem('unauthorized', 'The call is not signed by the Portal.'));
				}
				const named = ctx.query.websiteId;
				ctx.websiteId = named !== undefined && WEBSITE_ID.test(named) ? named : null;
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
			if (tokenRoute) {
				const refused = await readRouteBody();
				if (refused) return fail(refused);
			}
			websiteId = ctx.websiteId;
			ctx.signIn = requestSignIn({ accounts: kit.accounts, websiteId: ctx.websiteId, headers: request.headers });
			ctx.staffSignIn = requestStaffSignIn({
				accounts: kit.accounts,
				websiteId: ctx.websiteId,
				headers: request.headers,
				ctx,
			});

			if (r.auth === 'browser' || r.auth === 'server' || r.auth === 'ticket') {
				const id = /** @type {string} */ (ctx.websiteId);
				// never waits for the Portal while a status copy within the offline grace exists: an old copy is fetched
				// again, with the revocation list, after the response (K-19)
				const serving = await kit.status.serving(id, { after: (task) => portalTasks.push(task) });
				if (!serving.ok) return fail(serving.problem);
				ctx.status = serving.status;
				ctx.merchantId = serving.status.merchantId;
				const feature = r.feature ?? (r.permission === undefined ? undefined : featureOfPermission.get(r.permission));
				// a list: the route works while any of its features is on
				const keys = feature === undefined ? [] : [feature].flat();
				if (keys.length > 0 && !(await kit.reports.switches(id)).on.some((key) => keys.includes(key)))
					return fail(problem('feature_off', `The feature ${keys.join(' or ')} is off.`));
				if (r.database !== false && (await databaseOf(id)) === null)
					return fail(
						problem(
							'database_not_connected',
							'The database is not connected: enter it once in the Portal, under Website settings, Data and files.',
						),
					);
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

			const declared = r.rateLimit === undefined ? [] : [r.rateLimit].flat();
			// a visitor call from the merchant's server: its own window per route per website instead of the browser
			// one, plus the per-visitor limits by the visitor's address when it is sent (K3)
			const limits = ctx.visitor.server
				? [
						{ ...SERVER_VISITOR_LIMIT, per: /** @type {const} */ ('website'), bucket: `server|${r.id}` },
						...(ctx.visitor.ip ? declared.filter((limit) => limit.per === 'visitor') : []),
					]
				: declared;
			/** @param {import('./routes.js').RateLimit} limit */
			const perOf = (limit) => limit.per ?? (ctx.websiteId ? 'website' : 'visitor');
			// the per-visitor limits first: a website-wide window counts only requests that passed them, so one address
			// cannot use it up for every visitor (SE-2)
			const ordered = [
				...limits.filter((limit) => perOf(limit) === 'visitor'),
				...limits.filter((limit) => perOf(limit) !== 'visitor'),
			];
			for (const limit of ordered) {
				const per = perOf(limit);
				const subject = per === 'website' && ctx.websiteId ? `w:${ctx.websiteId}` : `ip:${ctx.clientIp}`;
				const windowMs = limit.windowSeconds * 1000;
				const key = `${limit.bucket ?? r.id}|${per}|${subject}`;
				/** @type {{ count: number, resetAt: number }} */
				let window;
				try {
					window = await store.hit(key, windowMs, now());
				} catch (error) {
					// never allow without counting: the same limit, counted by this instance alone
					log.warn('rate limit store failed; counting on this instance', { error });
					window = localWindows.hit(key, windowMs, now());
				}
				if (window.count > limit.limit) {
					extra['retry-after'] = String(Math.max(1, Math.ceil((window.resetAt - now()) / 1000)));
					return fail(problem('rate_limited', 'Too many requests.'));
				}
			}

			// the merchant's server called for a signed-in visitor: the sign-in is the visitor, so a wrong, expired or foreign one
			// is refused here and never becomes "no sign-in" (a browser call keeps that); a user id alone is never taken
			if (ctx.visitor.server) {
				const found = await ctx.signIn();
				if (found !== null && !found.ok) {
					if (found.code === 'accounts_unavailable') {
						extra['retry-after'] = '5';
						return fail(problem('accounts_unavailable', 'The sign-in cannot be checked right now. Try again shortly.'));
					}
					return fail(
						problem('invalid_sign_in', SIGN_IN_DETAIL[found.code] ?? SIGN_IN_DETAIL.malformed, {
							extensions: { cause: found.code },
						}),
					);
				}
			}

			// a staff route of the server token: the verified Accounts sign-in of a staff member whose role grants the route's
			// permission; the server token alone changes nothing (staff.js)
			if (r.auth === 'server' && (r.permission !== undefined || r.staff === true)) {
				const refused = await checkStaff(ctx, {
					productId: manifest.id,
					...(r.permission === undefined ? {} : { permission: r.permission }),
					headers: extra,
				});
				if (refused) return fail(refused);
			}

			// a repeated Idempotency-Key (same website, route, address, body and visitor, signed-in shopper or staff member) gets the first
			// answer again; another request under the key 409 duplicate_request; one still running 409 in_progress (K-14)
			/** @type {string | null} */
			let duplicateKey = null;
			let fingerprint = '';
			const claimedAt = now();
			if (r.idempotent === true && ctx.idempotencyKey) {
				const principal = ctx.websiteId ?? ctx.session?.subject ?? 'anonymous';
				duplicateKey = `idem:${sha256Hex(`${principal}\n${r.id}\n${ctx.idempotencyKey}`)}`;
				// a server call for a verified shopper counts by who they are, so a retry with a renewed sign-in is the same request
				const verified = ctx.visitor.server ? await ctx.signIn() : null;
				const signedIn = verified?.ok ? `user:${verified.user.id}` : (request.headers.get('ss-sign-in') ?? '');
				// an anonymous visitor (no ticket, staff member, session, sign-in or visitor key of its own) is named by the address
				// too, so two of them who send the same key and body never share a stored answer (SR-1-8); a trusted server or the
				// Portal is not, and a visitor key keeps a retry from a new address (a phone changing networks) a replay
				const anonymous =
					(r.auth === 'browser' || r.auth === 'none') &&
					!ctx.ticket &&
					!ctx.actor &&
					!ctx.session &&
					signedIn === '' &&
					!request.headers.get('ss-guest') &&
					!request.headers.get('ss-order-key');
				fingerprint = sha256Hex(
					[
						method,
						`${pathname}${url.search}`,
						ctx.ticket?.user?.id ?? '',
						ctx.actor?.id ?? '',
						request.headers.get('ss-guest') ?? '',
						request.headers.get('ss-order-key') ?? '',
						signedIn,
						anonymous ? `ip:${ctx.clientIp}` : '',
						ctx.rawBody,
					].join('\n'),
				);
				const running = { fingerprint, state: 'running', expiresAt: claimedAt + IN_PROGRESS_MS };
				if (!(await store.insert('idempotency', duplicateKey, running))) {
					const earlier = await store.get('idempotency', duplicateKey);
					if (earlier !== null && earlier.fingerprint === fingerprint && earlier.answer)
						return finish({
							status: earlier.answer.status,
							headers: { ...earlier.answer.headers, 'idempotent-replayed': 'true' },
							body:
								typeof earlier.answer.bytes === 'string'
									? Buffer.from(earlier.answer.bytes, 'base64')
									: earlier.answer.body,
						});
					if (earlier === null || (earlier.fingerprint === fingerprint && earlier.state === 'running')) {
						extra['retry-after'] = '1';
						return fail(problem('in_progress', 'A request with this Idempotency-Key is still running. Try again.'));
					}
					return fail(problem('duplicate_request', 'A request with this Idempotency-Key was already processed.'));
				}
			}

			/** @type {Rendered} */
			let rendered;
			try {
				const out = await r.handler(ctx);
				if (out instanceof Response) {
					// the exact bytes: decoding them as text would drop a CSV's byte order mark and garble binary bodies
					const bytes = new Uint8Array(await out.arrayBuffer());
					rendered = {
						status: out.status,
						headers: Object.fromEntries(out.headers.entries()),
						body: bytes.byteLength > 0 ? bytes : null,
					};
				} else rendered = render(isResult(out) ? out : out === undefined ? noContent() : ok(out), requestId, pathname);
			} catch (error) {
				if (isProblem(error)) rendered = render(error, requestId, pathname);
				else if (isKitError(error, 'database_not_connected'))
					rendered = render(problem('database_not_connected'), requestId, pathname);
				else if (isDatabaseUnavailable(error)) {
					log.warn('database unavailable', { error, route: r.id });
					rendered = render(DATABASE_UNAVAILABLE(), requestId, pathname);
				} else {
					log.error('route handler failed', { error, route: r.id });
					rendered = render(problem('internal_error'), requestId, pathname);
				}
			}
			if (duplicateKey) {
				// a failure (5xx) frees the key for a retry; any other answer is kept for repeats of the key
				const id = duplicateKey;
				const headers = Object.fromEntries(
					Object.entries(rendered.headers).filter(([name]) => !NOT_REPLAYED.has(name.toLowerCase())),
				);
				const body = rendered.body;
				const kept = (body instanceof Uint8Array ? body.byteLength : (body ?? '').length) <= REPLAY_MAX_CHARS;
				await (
					rendered.status >= 500
						? store.delete('idempotency', id)
						: store.put('idempotency', id, {
								fingerprint,
								state: 'done',
								...(kept
									? {
											// bytes kept as base64, so every store keeps them as they were
											answer:
												body instanceof Uint8Array
													? {
															status: rendered.status,
															headers,
															body: null,
															bytes: Buffer.from(body).toString('base64'),
														}
													: { status: rendered.status, headers, body },
										}
									: {}),
								expiresAt: claimedAt + DUPLICATE_WINDOW_MS,
							})
				).catch((error) => log.warn('the answer of an idempotent request was not kept', { error }));
			}
			return finish(rendered);
		} catch (error) {
			if (isDatabaseUnavailable(error)) {
				log.warn('database unavailable', { error, ...(route ? { route: route.id } : {}) });
				return fail(DATABASE_UNAVAILABLE());
			}
			log.error('request failed', { error, ...(route ? { route: route.id } : {}) });
			return fail(problem('internal_error'));
		}
	};
};
