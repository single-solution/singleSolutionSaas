/**
 * The settings API for the merchant's server (PLAN 0.8.10 K1) and the activity reads (K9): kit routes, server token
 * only, with the rights of a merchant dashboard session (settings only of switched-on features; never feature
 * switches, prices or global defaults). Kit routes have no feature of their own: whatever they read or write stays
 * gated by its own feature.
 *
 * - `GET /v1/features` → `{ features: [{ key, name, description, on, millicreditsPerHour }] }`.
 * - `GET /v1/settings` → `{ features: [{ key, name, on, schema, values }] }`; `values` (`{ <setting>: { value, source } }`)
 *   only of switched-on features, null for the others. `PUT /v1/settings/<feature>.<key>` with `{ value }` answers
 *   `{ key, value, source }`, 422 `validation_failed` with `errors`, or 403 `feature_off`; `DELETE` resets it.
 * - `GET /v1/texts`, `PUT|DELETE /v1/texts/:key`; `GET|PUT /v1/theme`; `GET|PUT /v1/format` (K7).
 * - `GET|PUT /v1/lists/:list` with `{ value }`: the whole list, checked by the product's own list check (422).
 * - `GET /v1/connections` → `{ connections: [{ name, label, kind, neededBy, state, last4, message, testedAt }] }`;
 *   `PUT /v1/connections/:name` with `{ value }` (checked and tested live), `DELETE`, `POST …/test`. Secrets never
 *   come back.
 * - `GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor=&limit=` (newest first) and its counts.
 *
 * Every write is a Recent change by the acting user (K2), else `Server`; at most 60 writes per minute per website.
 * @module
 */
import { currentFeatures } from './connection.js';
import { activityFilter, activityPage, activityView } from './activity.js';
import { countHandlers } from './counts.js';
import { defineRoute } from './http/routes.js';
import { noContent, ok, paginate, problem } from './http/results.js';
import { isObject } from './util.js';

/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {import('./recent.js').Who} Who */
/**
 * A list setting a product keeps (Chat's tools and flows, Ecommerce's order flow …).
 * @typedef {object} ListDefinition
 * @property {string | string[]} feature the feature it belongs to (any of them, for a list)
 * @property {string} title its name on screens and in Recent changes
 * @property {(websiteId: string) => Promise<unknown>} get the saved list, else its default
 * @property {(websiteId: string, value: unknown) => Promise<{ ok: true, value: unknown } | { ok: false, errors: Array<string | { path?: string, message: string }> }>} save
 *   checks and saves the whole list
 */

/** Settings writes of the merchant's server per website (code constant). */
export const SETTINGS_WRITE_LIMIT = Object.freeze({
	limit: 60,
	windowSeconds: 60,
	per: /** @type {const} */ ('website'),
	bucket: 'kit-settings-writes',
});

/** The merchant's server as the one who changed something. @type {Who} */
const SERVER = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/**
 * @param {import('./product.js').Kit} kit
 * @param {Record<string, ListDefinition>} lists
 */
export const createServerApi = (kit, lists) => {
	const { manifest } = kit;
	const writes = [SETTINGS_WRITE_LIMIT];

	/** @param {RequestContext} ctx */
	const website = (ctx) => /** @type {string} */ (ctx.websiteId);
	/** Who changed it: the acting user, else the server. @param {RequestContext} ctx @returns {Who} */
	const whoOf = (ctx) =>
		ctx.actor
			? { kind: 'user', id: ctx.actor.id, name: ctx.actor.name, ...(ctx.actor.role ? { role: ctx.actor.role } : {}) }
			: SERVER;
	/** @param {unknown} body @returns {Record<string, any>} */
	const objectBody = (body) => {
		if (!isObject(body)) throw problem('bad_request', 'Send a JSON object.');
		return body;
	};
	/** @param {RequestContext} ctx */
	const valueOf = (ctx) => {
		const body = objectBody(ctx.body);
		if (!('value' in body))
			throw problem('validation_failed', 'Send { value }.', { errors: [{ path: '/value', message: 'is required' }] });
		return body.value;
	};
	/** @param {{ ok: true } | { ok: false, problem: import('./http/results.js').ProblemResult }} result */
	const orThrow = (result) => {
		if (!result.ok) throw result.problem;
	};
	/** @param {string} key */
	const splitKey = (key) => {
		const dot = key.indexOf('.');
		return dot > 0 ? { feature: key.slice(0, dot), key: key.slice(dot + 1) } : { feature: '', key };
	};
	/** @param {RequestContext} ctx @param {string} feature */
	const requireOn = async (ctx, feature) => {
		if (!(await kit.reports.isOn(website(ctx), feature)))
			throw problem('feature_off', `The feature ${feature} is off: its settings cannot be changed.`);
	};

	/** @param {RequestContext} ctx */
	const setting = async (ctx) => {
		const full = String(ctx.params.key ?? '');
		const { feature, key } = splitKey(full);
		const node = kit.settings.featureOf(feature)?.settings.properties[key];
		if (!node) throw problem('not_found', 'No such setting.');
		await requireOn(ctx, feature);
		const value = ctx.method === 'PUT' ? valueOf(ctx) : undefined;
		if (ctx.method === 'PUT' && value === null)
			throw problem('validation_failed', 'Send a value, or DELETE to reset to the default.');
		orThrow(await kit.settings.setSetting({ websiteId: website(ctx), feature, key, value, who: whoOf(ctx) }));
		const saved = (await kit.settings.settingsOf(website(ctx), feature))[key];
		return { key: full, value: saved?.value, source: saved?.source };
	};

	/** @param {RequestContext} ctx */
	const text = async (ctx) => {
		const key = String(ctx.params.key ?? '');
		const value = ctx.method === 'PUT' ? valueOf(ctx) : undefined;
		orThrow(await kit.settings.setText({ websiteId: website(ctx), key, value, who: whoOf(ctx) }));
		const found = (await kit.settings.textsOf(website(ctx))).find((entry) => entry.key === key);
		return found ?? problem('not_found', 'No such text.');
	};

	/** @param {RequestContext} ctx */
	const listOf = (ctx) => {
		const name = String(ctx.params.list ?? '');
		const definition = Object.hasOwn(lists, name) ? lists[name] : undefined;
		if (!definition)
			throw problem('not_found', `No such list. This product's lists: ${Object.keys(lists).join(', ') || 'none'}.`);
		return { name, definition };
	};

	/** @param {import('./connections.js').ConnectionView} view */
	const connectionView = (view) => ({
		name: view.name,
		label: view.label,
		kind: view.kind,
		neededBy: view.neededBy,
		state: view.status,
		last4: view.last4,
		message: view.message ?? null,
		testedAt: view.testedAt,
	});

	/**
	 * The activity filter of a request (days in the business time zone).
	 * @param {RequestContext} ctx
	 */
	const activitySource = async (ctx) => {
		const status = /** @type {import('@ss/contracts').StatusResponse} */ (ctx.status);
		const { business } = await kit.business.get(website(ctx), status.domain);
		const built = activityFilter(website(ctx), ctx.query, business.timeZone ?? 'UTC');
		if (!built.ok)
			throw problem('validation_failed', built.message, { errors: [{ path: `/${built.field}`, message: built.message }] });
		return { collection: (await ctx.data()).collection('activity'), filter: built.filter };
	};
	const activityCounts = countHandlers({
		source: activitySource,
		by: { action: 'action', actor: 'actor.id', kind: 'actor.kind' },
	});

	/** @param {Omit<import('./http/routes.js').RouteDefinition, 'auth'>} definition */
	const route = (definition) => defineRoute({ database: false, ...definition, auth: 'server' });

	return [
		route({
			method: 'GET',
			path: '/v1/features',
			handler: async (ctx) => {
				const [{ on }, prices] = await Promise.all([kit.reports.switches(website(ctx)), kit.connection.acceptedPrices()]);
				return {
					features: currentFeatures(manifest, prices).map((f) => ({
						key: f.key,
						name: f.name,
						description: f.description,
						on: on.includes(f.key),
						millicreditsPerHour: f.millicreditsPerHour,
					})),
				};
			},
		}),
		route({
			method: 'GET',
			path: '/v1/settings',
			handler: async (ctx) => {
				const [{ on }, values] = await Promise.all([
					kit.reports.switches(website(ctx)),
					kit.settings.settingsOfFeatures(
						website(ctx),
						manifest.features.map((f) => f.key),
					),
				]);
				return {
					features: manifest.features.map((f) => ({
						key: f.key,
						name: f.name,
						on: on.includes(f.key),
						schema: f.settings,
						values: on.includes(f.key) ? (values[f.key] ?? {}) : null,
					})),
				};
			},
		}),
		route({ method: 'PUT', path: '/v1/settings/:key', rateLimit: writes, handler: setting }),
		route({ method: 'DELETE', path: '/v1/settings/:key', rateLimit: writes, handler: setting }),
		route({
			method: 'GET',
			path: '/v1/texts',
			handler: async (ctx) => ({ texts: await kit.settings.textsOf(website(ctx)) }),
		}),
		route({ method: 'PUT', path: '/v1/texts/:key', rateLimit: writes, handler: text }),
		route({ method: 'DELETE', path: '/v1/texts/:key', rateLimit: writes, handler: text }),
		route({ method: 'GET', path: '/v1/theme', handler: async (ctx) => kit.settings.themeOf(website(ctx)) }),
		route({
			method: 'PUT',
			path: '/v1/theme',
			rateLimit: writes,
			handler: async (ctx) => {
				orThrow(await kit.settings.setTheme({ websiteId: website(ctx), theme: objectBody(ctx.body), who: whoOf(ctx) }));
				return kit.settings.themeOf(website(ctx));
			},
		}),
		route({ method: 'GET', path: '/v1/format', handler: async (ctx) => kit.settings.formatOf(website(ctx)) }),
		route({
			method: 'PUT',
			path: '/v1/format',
			rateLimit: writes,
			handler: async (ctx) => {
				orThrow(await kit.settings.setFormat({ websiteId: website(ctx), format: objectBody(ctx.body), who: whoOf(ctx) }));
				return kit.settings.formatOf(website(ctx));
			},
		}),
		route({
			method: 'GET',
			path: '/v1/lists/:list',
			handler: async (ctx) => {
				const { definition } = listOf(ctx);
				return { value: await definition.get(website(ctx)) };
			},
		}),
		route({
			method: 'PUT',
			path: '/v1/lists/:list',
			rateLimit: writes,
			handler: async (ctx) => {
				const { definition } = listOf(ctx);
				const features = [definition.feature].flat();
				const { on } = await kit.reports.switches(website(ctx));
				if (!features.some((key) => on.includes(key)))
					throw problem('feature_off', `The feature ${features.join(' or ')} is off: its lists cannot be changed.`);
				const saved = await definition.save(website(ctx), valueOf(ctx));
				if (!saved.ok) {
					const errors = saved.errors.map((error) =>
						typeof error === 'string'
							? { path: '/value', message: error }
							: { path: error.path ?? '/value', message: error.message },
					);
					throw problem('validation_failed', errors[0]?.message ?? 'The list is not valid.', { errors });
				}
				await kit.recent.record({
					websiteId: website(ctx),
					who: whoOf(ctx),
					what: 'settings',
					detail: `${definition.title}: changed`,
				});
				return { value: saved.value };
			},
		}),
		route({
			method: 'GET',
			path: '/v1/connections',
			handler: async (ctx) => ({ connections: (await kit.connections.list(website(ctx))).map(connectionView) }),
		}),
		route({
			method: 'PUT',
			path: '/v1/connections/:name',
			rateLimit: writes,
			handler: async (ctx) => {
				const result = await kit.connections.save({
					websiteId: website(ctx),
					name: String(ctx.params.name),
					value: valueOf(ctx),
					who: whoOf(ctx),
				});
				if (!result.ok) throw result.problem;
				return connectionView(result.connection);
			},
		}),
		route({
			method: 'DELETE',
			path: '/v1/connections/:name',
			rateLimit: writes,
			handler: async (ctx) => {
				orThrow(await kit.connections.remove({ websiteId: website(ctx), name: String(ctx.params.name), who: whoOf(ctx) }));
				return noContent();
			},
		}),
		route({
			method: 'POST',
			path: '/v1/connections/:name/test',
			rateLimit: writes,
			handler: async (ctx) => {
				const result = await kit.connections.test({ websiteId: website(ctx), name: String(ctx.params.name) });
				if (!result.ok) throw result.problem;
				return connectionView(result.connection);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/activity',
			database: true,
			handler: async (ctx) => {
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 50 },
				);
				const { collection, filter } = await activitySource(ctx);
				const rows = await collection
					.find({ ...filter, ...activityPage(page.after) }, { sort: { at: -1, _id: -1 }, limit: page.fetchLimit })
					.toArray();
				const out = page.page(rows, (row) => [new Date(row.at).toISOString(), String(row._id)]);
				const link = page.link(out.nextCursor);
				return ok({ ...out, items: out.items.map(activityView) }, { headers: link ? { link } : {} });
			},
		}),
		route({ method: 'GET', path: '/v1/activity/count', database: true, handler: activityCounts.count }),
		route({ method: 'GET', path: '/v1/activity/counts', database: true, handler: activityCounts.counts }),
	];
};
