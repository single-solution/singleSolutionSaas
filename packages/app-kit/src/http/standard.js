/**
 * Standard resources every product exposes (Part E §5, §7) plus the well-known protocol endpoints, as route
 * definitions to pass to `createRequestHandler` together with the product's own routes.
 * @module
 */
import { eventGlobMatches, eventNamespace } from '@ss/contracts';
import { guardCollection } from '../data.js';
import { checkEvent } from '../events.js';
import { config as configOf, featuresOf, can } from '../entitlements.js';
import { isObject } from '../util.js';
import { ok, problem } from './results.js';
import { defineRoute } from './routes.js';

/** @typedef {import('./routes.js').RouteDefinition} RouteDefinition */

const MAX_EVENTS = 100;

/**
 * Resolve strings for a language with fallback `pt-BR → pt → default`.
 * @param {Record<string, Record<string, string>> | ((lang: string) => Promise<Record<string, string> | null> | Record<string, string> | null) | undefined} source
 * @param {string} lang
 * @param {string} fallback
 * @returns {Promise<{ lang: string, strings: Record<string, string> }>}
 */
export const resolveStrings = async (source, lang, fallback = 'en') => {
	const chain = [...new Set([lang, lang.split('-')[0] ?? lang, fallback])];
	for (const candidate of chain) {
		const found =
			typeof source === 'function'
				? await source(candidate)
				: source && Object.hasOwn(source, candidate)
					? source[candidate]
					: undefined;
		if (found) return { lang: candidate, strings: found };
	}
	return { lang: fallback, strings: {} };
};

/**
 * @param {{ response: (request: { headers: Headers, body: string }) => Promise<{ status: number, body: unknown }> }} input
 * @returns {(ctx: any) => Promise<Response>}
 */
const passthrough =
	({ response }) =>
	async (ctx) => {
		const result = await response({ headers: ctx.headers, body: ctx.rawBody });
		return new Response(JSON.stringify(result.body), {
			status: result.status,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	};

/**
 * Standard route definitions.
 * @param {any} product the object returned by `createProduct`
 * @param {{ wellKnown?: boolean, sso?: boolean }} [options] `wellKnown` (default true) adds the protocol endpoints,
 *   `sso` (default true) adds `GET /sso?launch=` which exchanges a launch for a session cookie and redirects
 * @returns {RouteDefinition[]}
 */
export const standardRoutes = (product, { wellKnown = true, sso = true } = {}) => {
	const ctxKit = product.context;
	const manifest = ctxKit.manifest;
	const namespace = eventNamespace(manifest.product.slug);
	const consumes = /** @type {string[]} */ (manifest.events?.consumes ?? []);
	const elementKeys = new Set(manifest.elements.map((/** @type {{ key: string }} */ e) => e.key));

	/** @param {string} type */
	const acceptsEvent = (type) => type.startsWith(`${namespace}.`) || consumes.some((pattern) => eventGlobMatches(pattern, type));

	/** @type {RouteDefinition[]} */
	const routes = [
		defineRoute({
			method: 'GET',
			path: '/v1/entitlement',
			auth: 'website',
			handler: (ctx) => {
				const { doc, stale, version } = ctx.entitlement;
				return ok({
					websiteId: doc.websiteId,
					productSlug: doc.productSlug,
					version,
					stale,
					env: doc.env,
					planCode: doc.planCode ?? null,
					runtime: doc.runtime,
					elements: doc.elements,
					features: Object.fromEntries(Object.entries(doc.features).map(([key, entry]) => [key, entry.value])),
					experiments: doc.experiments,
					validUntil: doc.validUntil,
				});
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/config',
			auth: 'website',
			handler: (ctx) => {
				const { doc, stale, version } = ctx.entitlement;
				const requested = (ctx.query.element ?? '')
					.split(',')
					.map((/** @type {string} */ key) => key.trim())
					.filter(Boolean);
				for (const key of requested) {
					if (!elementKeys.has(key)) return problem('not_found', `Unknown element '${key}'.`);
					if (!can(doc, key)) return problem('element_disabled', `Element '${key}' is not enabled for this website.`);
				}
				const keys = requested.length > 0 ? requested : [...elementKeys].filter((key) => can(doc, key));
				/** @type {Record<string, unknown>} */
				const elements = {};
				for (const key of keys) {
					const variant = doc.experiments.find((/** @type {{ element: string }} */ e) => e.element === key)?.variant ?? null;
					elements[key] = { config: configOf(doc, key), features: featuresOf(doc, key), variant };
				}
				return ok({ version, stale, elements }, { headers: { 'cache-control': 'private, max-age=60' } });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/events',
			auth: 'website',
			idempotent: false,
			rateLimit: { limit: 600, windowMs: 60_000 },
			handler: async (ctx) => {
				const body = ctx.body;
				const list = Array.isArray(body?.events) ? body.events : isObject(body) && !('events' in body) ? [body] : null;
				if (!list || list.length === 0) return problem('bad_request', 'Send an event or { events: [...] }.');
				if (list.length > MAX_EVENTS) return problem('payload_too_large', `At most ${MAX_EVENTS} events per request.`);
				/** @type {Array<{ path: string, message: string }>} */
				const errors = [];
				const events = list.map((/** @type {unknown} */ raw, /** @type {number} */ index) => {
					if (!isObject(raw)) {
						errors.push({ path: `/events/${index}`, message: 'must be an object' });
						return null;
					}
					if (raw.websiteId !== undefined && raw.websiteId !== ctx.website.websiteId) {
						errors.push({ path: `/events/${index}/websiteId`, message: 'does not match the website key' });
						return null;
					}
					if (raw.env !== undefined && raw.env !== ctx.website.env) {
						errors.push({ path: `/events/${index}/env`, message: 'does not match the website key' });
						return null;
					}
					const event = { ...raw, websiteId: ctx.website.websiteId, env: ctx.website.env };
					const checked = checkEvent(event);
					if (!checked.ok) {
						for (const e of checked.errors) errors.push({ path: `/events/${index}${e.path}`, message: e.message });
						return null;
					}
					if (!acceptsEvent(checked.event.type)) {
						errors.push({
							path: `/events/${index}/type`,
							message: `this product does not consume '${checked.event.type}'`,
						});
						return null;
					}
					return checked.event;
				});
				if (errors.length > 0) return problem('invalid_event', 'One or more events are invalid.', { errors });
				let duplicates = 0;
				for (const event of events) {
					const { duplicate } = await product.events.dispatch(event, { source: 'site', website: ctx.website });
					if (duplicate) duplicates += 1;
				}
				return ok({ accepted: events.length - duplicates, duplicates }, { status: 202 });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/strings',
			auth: 'none',
			cors: true,
			handler: async (ctx) => {
				const lang = ctx.query.lang ?? ctxKit.defaultLang;
				if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return problem('bad_request', 'lang must be a BCP 47 tag.');
				const resolved = await resolveStrings(ctxKit.strings, lang, ctxKit.defaultLang);
				return ok(resolved, { headers: { 'cache-control': 'public, max-age=300' } });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/data:export',
			auth: 'portal',
			idempotent: false,
			handler: async (ctx) => {
				const input = privacyInput(ctx.body);
				if (!input) return problem('bad_request', 'Send { websiteId, subject? }.');
				const result = await ctxKit.privacy.export(input);
				return ok(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/data:anonymize',
			auth: 'portal',
			idempotent: false,
			handler: async (ctx) => {
				const input = privacyInput(ctx.body);
				if (!input || !input.subject) return problem('bad_request', 'Send { websiteId, subject }.');
				const result = await ctxKit.privacy.anonymize(input);
				return ok(result);
			},
		}),
	];

	if (wellKnown) {
		routes.push(
			defineRoute({
				method: 'GET',
				path: '/.well-known/ss-app.json',
				auth: 'none',
				connected: false,
				handler: async () => {
					const { status, body, headers } = await product.manifestRoute();
					return ok(body, { status, headers });
				},
			}),
			defineRoute({
				method: 'POST',
				path: '/.well-known/ss-connect',
				auth: 'none',
				connected: false,
				rawBody: true,
				idempotent: false,
				maxBodyBytes: 65_536,
				rateLimit: { limit: 20, windowMs: 60_000 },
				handler: async (ctx) => {
					const result = await product.handleConnect({ headers: ctx.headers, rawBody: ctx.rawBody });
					return new Response(result.body, {
						status: result.status,
						headers: { ...result.headers, 'cache-control': 'no-store' },
					});
				},
			}),
			defineRoute({
				method: 'POST',
				path: '/.well-known/ss-events',
				auth: 'none',
				rawBody: true,
				idempotent: false,
				handler: passthrough({ response: ({ headers, body }) => product.events.handle({ headers, rawBody: body }) }),
			}),
		);
	}
	if (ctxKit.devProbes) {
		routes.push(
			defineRoute({
				method: 'GET',
				path: '/v1/ss-probe/data-guard',
				auth: 'website',
				entitlement: false,
				handler: async (ctx) => ok(await probeDataGuard(product, ctx.website.websiteId)),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/ss-probe/events/:id',
				auth: 'website',
				entitlement: false,
				handler: (ctx) => ok({ id: ctx.params.id, effects: product.events.effects(ctx.website.websiteId, ctx.params.id) }),
			}),
		);
	}
	if (sso) {
		routes.push(
			defineRoute({
				method: 'GET',
				path: '/sso',
				auth: 'none',
				handler: async (ctx) => {
					const token = ctx.query.launch;
					if (!token) return problem('unauthorized', 'A launch token is required.');
					const result = await product.launch.exchange(token);
					if (!result.ok) return problem('invalid_credentials', 'The launch is invalid, expired or already used.');
					const maxAge = Math.max(1, Math.floor((result.session.expiresAt - ctxKit.now()) / 1000));
					const target = manifest.endpoints?.dashboard ?? '/';
					return new Response(null, {
						status: 303,
						headers: {
							location: target,
							'cache-control': 'no-store',
							'set-cookie': `${ctxKit.sessionCookie}=${result.session.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
						},
					});
				},
			}),
		);
	}
	return routes;
};

/**
 * Development probe: run a query WITHOUT websiteId through the tenant guard and report what happened. Uses the
 * website's real database when it resolves, otherwise the same guard over a collection stub that never runs a query.
 * @param {any} product
 * @param {string} websiteId
 * @returns {Promise<{ rejected: boolean, code: string | null }>}
 */
const probeDataGuard = async (product, websiteId) => {
	/** @type {{ find: (filter: Record<string, unknown>) => { toArray: () => Promise<unknown[]> } }} */
	let collection;
	try {
		collection = (await product.data.forWebsite(websiteId)).collection('ss_probe');
	} catch {
		const stub = /** @type {any} */ ({ collectionName: 'ss_probe', find: () => ({ toArray: async () => [] }) });
		collection = guardCollection(stub, { websiteId, now: Date.now, schemaVersion: () => 1, stamp: {} });
	}
	try {
		await collection.find({}).toArray();
		return { rejected: false, code: null };
	} catch (error) {
		return { rejected: true, code: /** @type {{ code?: string }} */ (error)?.code ?? 'rejected' };
	}
};

/**
 * @param {unknown} body
 * @returns {{ websiteId: string, subject?: Record<string, string>, requestId?: string } | null}
 */
const privacyInput = (body) => {
	if (!isObject(body) || typeof body.websiteId !== 'string' || body.websiteId === '') return null;
	/** @type {{ websiteId: string, subject?: Record<string, string>, requestId?: string }} */
	const out = { websiteId: body.websiteId };
	if (body.subject !== undefined) {
		if (!isObject(body.subject)) return null;
		const subject = Object.fromEntries(Object.entries(body.subject).filter(([, v]) => typeof v === 'string' && v.length > 0));
		if (Object.keys(subject).length === 0) return null;
		out.subject = /** @type {Record<string, string>} */ (subject);
	}
	if (typeof body.requestId === 'string') out.requestId = body.requestId;
	return out;
};
