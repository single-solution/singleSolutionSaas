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
 * - `GET|PUT /v1/lists/:list` with `{ value }`: the whole list, checked by the product's own list check (422), only
 *   while one of its features is on (403 `feature_off`). Its dashboard twin, `GET|PUT
 *   /v1/dashboard/websites/:websiteId/lists/:list` (dashboard session), follows the same rules, except that Owner and
 *   Support may prepare the list of a switched-off feature (as the dashboard's settings).
 * - `GET /v1/connections` → `{ connections: [{ name, label, kind, neededBy, state, last4, message, testedAt }] }`;
 *   `PUT /v1/connections/:name` with `{ value }` (checked and tested live), `DELETE`, `POST …/test`. Secrets never
 *   come back.
 * - `GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor=&limit=` (newest first) and its counts.
 *
 * Every write is a Recent change by the acting user (K2), else `Server` (on the dashboard twin: the session's merchant
 * or admin); a setting, text, theme, Format or list save is also an activity-log entry (`settings.changed`) and raises
 * the `settings.changed` event. At most 60 writes per minute per website (the dashboard's list saves in a window of
 * their own), and 3,000 reads per minute per route per website (the window of SEO reads, SG-31: a storefront rendered
 * on the merchant's server reads its settings on every page).
 * @module
 */
import { isObject } from '@ss/contracts/util';
import { currentFeatures } from './connection.js';
import { activityFilter, activityPage, activityView } from './activity.js';
import { countHandlers } from './counts.js';
import { defineRoute } from './http/routes.js';
import { noContent, ok, paginate, problem } from './http/results.js';

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
/** List saves in the product dashboard per website (code constant; a window of their own, so the merchant's server
 * cannot use up the dashboard's). */
export const DASHBOARD_LIST_WRITE_LIMIT = Object.freeze({ ...SETTINGS_WRITE_LIMIT, bucket: 'kit-dashboard-list-writes' });
/** Reads of the merchant's server per route per website (code constant; the window SEO reads have, SG-31). */
export const SETTINGS_READ_LIMIT = Object.freeze({ limit: 3000, windowSeconds: 60, per: /** @type {const} */ ('website') });

/**
 * A list filter with a page's keyset: both may hold `$or` (the search and the cursor), so they are joined with `$and`.
 * @param {Record<string, unknown>} filter pins `websiteId`
 * @param {Record<string, unknown>} keyset
 */
const withPage = (filter, keyset) =>
	Object.keys(keyset).length === 0 ? filter : { websiteId: filter.websiteId, $and: [filter, keyset] };

/** The merchant's server as the one who changed something. @type {Who} */
const SERVER = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/** The dashboard twin of `/v1/lists/:list`. */
const DASHBOARD_LIST_PATH = '/v1/dashboard/websites/:websiteId/lists/:list';

/**
 * @param {import('./product.js').Kit} kit
 * @param {Record<string, ListDefinition>} lists
 */
export const createServerApi = (kit, lists) => {
	const { manifest } = kit;
	const writes = [SETTINGS_WRITE_LIMIT];

	/** @param {RequestContext} ctx */
	const website = (ctx) => /** @type {string} */ (ctx.websiteId);
	/**
	 * Who changed it: on the dashboard, the session's merchant or admin; else the acting user, else the server.
	 * @param {RequestContext} ctx
	 * @returns {Who}
	 */
	const whoOf = (ctx) => {
		const { session, actor } = ctx;
		if (session)
			return { kind: session.kind, id: session.subject, name: session.name, ...(session.role ? { role: session.role } : {}) };
		return actor ? { kind: 'user', id: actor.id, name: actor.name, ...(actor.role ? { role: actor.role } : {}) } : SERVER;
	};
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
	/**
	 * A settings save: refused, thrown; saved, an activity-log entry and `settings.changed`.
	 * @param {RequestContext} ctx
	 * @param {{ what: import('./product.js').SettingsChange['what'], key?: string }} change
	 * @param {import('./settings.js').Change} result
	 */
	const saved = async (ctx, change, result) => {
		if (!result.ok) throw result.problem;
		await kit.settingsChanged(ctx, { ...change, who: whoOf(ctx), label: result.label, detail: result.detail });
	};
	/** @param {string} key */
	const splitKey = (key) => {
		const dot = key.indexOf('.');
		return dot > 0 ? { feature: key.slice(0, dot), key: key.slice(dot + 1) } : { feature: '', key };
	};
	/** @param {RequestContext} ctx @param {string} feature */
	const requireOn = async (ctx, feature) => {
		if (!kit.settings.sectionOn(feature, (await kit.reports.switches(website(ctx))).on))
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
		await saved(
			ctx,
			{ what: 'settings', key: full },
			await kit.settings.setSetting({ websiteId: website(ctx), feature, key, value, who: whoOf(ctx) }),
		);
		const current = (await kit.settings.settingsOf(website(ctx), feature))[key];
		return { key: full, value: current?.value, source: current?.source };
	};

	/** @param {RequestContext} ctx */
	const text = async (ctx) => {
		const key = String(ctx.params.key ?? '');
		const value = ctx.method === 'PUT' ? valueOf(ctx) : undefined;
		await saved(
			ctx,
			{ what: 'texts', key },
			await kit.settings.setText({ websiteId: website(ctx), key, value, who: whoOf(ctx) }),
		);
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

	/** A list, whole (`{ value }`). @param {RequestContext} ctx */
	const readList = async (ctx) => ({ value: await listOf(ctx).definition.get(website(ctx)) });

	/**
	 * Save a list whole: only while one of its features is on (Owner and Support on the dashboard may prepare it), checked
	 * by the product (422 `validation_failed` with every error, the first as the detail), then a Recent change, an
	 * activity-log entry and the `settings.changed` event.
	 * @param {RequestContext} ctx
	 */
	const saveList = async (ctx) => {
		const { name, definition } = listOf(ctx);
		const features = [definition.feature].flat();
		const preparing = ctx.session?.kind === 'admin';
		const { on } = await kit.reports.switches(website(ctx));
		if (!preparing && !features.some((key) => on.includes(key)))
			throw problem('feature_off', `The feature ${features.join(' or ')} is off: its lists cannot be changed.`);
		const list = await definition.save(website(ctx), valueOf(ctx));
		if (!list.ok) {
			const errors = list.errors.map((error) =>
				typeof error === 'string'
					? { path: '/value', message: error }
					: { path: error.path ?? '/value', message: error.message },
			);
			throw problem('validation_failed', errors[0]?.message ?? 'The list is not valid.', { errors });
		}
		const who = whoOf(ctx);
		await kit.recent.record({ websiteId: website(ctx), who, what: 'settings', detail: `${definition.title}: changed` });
		await kit.settingsChanged(ctx, { what: 'list', key: name, who, label: definition.title, detail: 'changed' });
		return { value: list.value };
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
		const built = activityFilter(ctx.query, business.timeZone ?? 'UTC');
		if (!built.ok)
			throw problem('validation_failed', built.message, { errors: [{ path: `/${built.field}`, message: built.message }] });
		return { collection: (await ctx.data()).collection('activity'), filter: { websiteId: website(ctx), ...built.filter } };
	};
	const activityCounts = countHandlers({
		source: activitySource,
		by: { action: 'action', actor: 'actor.id', kind: 'actor.kind' },
	});

	/** A server-token route; a read gets the read window. @param {Omit<import('./http/routes.js').RouteDefinition, 'auth'>} definition */
	const route = (definition) =>
		defineRoute({
			database: false,
			...(definition.method === 'GET' ? { rateLimit: SETTINGS_READ_LIMIT } : {}),
			...definition,
			auth: 'server',
		});

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
						kit.settings.sections.map((f) => f.key),
					),
				]);
				return {
					features: kit.settings.sections.map((f) => ({
						key: f.key,
						name: f.name,
						on: kit.settings.sectionOn(f.key, on),
						schema: f.settings,
						values: kit.settings.sectionOn(f.key, on) ? (values[f.key] ?? {}) : null,
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
				await saved(
					ctx,
					{ what: 'theme' },
					await kit.settings.setTheme({ websiteId: website(ctx), theme: objectBody(ctx.body), who: whoOf(ctx) }),
				);
				return kit.settings.themeOf(website(ctx));
			},
		}),
		route({ method: 'GET', path: '/v1/format', handler: async (ctx) => kit.settings.formatOf(website(ctx)) }),
		route({
			method: 'PUT',
			path: '/v1/format',
			rateLimit: writes,
			handler: async (ctx) => {
				await saved(
					ctx,
					{ what: 'format' },
					await kit.settings.setFormat({ websiteId: website(ctx), format: objectBody(ctx.body), who: whoOf(ctx) }),
				);
				return kit.settings.formatOf(website(ctx));
			},
		}),
		route({ method: 'GET', path: '/v1/lists/:list', handler: readList }),
		route({ method: 'PUT', path: '/v1/lists/:list', rateLimit: writes, handler: saveList }),
		defineRoute({ method: 'GET', path: DASHBOARD_LIST_PATH, auth: 'dashboard', handler: readList }),
		defineRoute({
			method: 'PUT',
			path: DASHBOARD_LIST_PATH,
			auth: 'dashboard',
			rateLimit: DASHBOARD_LIST_WRITE_LIMIT,
			handler: saveList,
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
					.find(withPage(filter, activityPage(page.after)), { sort: { at: -1, _id: -1 }, limit: page.fetchLimit })
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
