/**
 * The settings API for the merchant's server (PLAN 0.8.10 K1) and the activity reads (K9): kit routes, server token,
 * with the rights of a merchant dashboard session (settings only of switched-on features; never feature switches,
 * prices or global defaults). Kit routes have no feature of their own: whatever they read or write stays gated by its
 * own feature.
 *
 * **The server token alone changes no configuration.** Reads of settings, texts, theme, Format, lists and features are
 * runtime (the website's server renders pages from them). Every write, and the connections and the activity log,
 * needs the verified Accounts sign-in of a staff member (`SS-Sign-In` next to the server token, `staff.js`) whose role
 * grants `settings.manage`, `connections.manage` or `audit.read`; a bare server token is 403 `needs_signed_in_staff`.
 * The change is recorded with that person. The dashboard twin takes the human's session instead.
 *
 * - `GET /v1/features` → `{ features: [{ key, name, description, on, millicreditsPerHour }] }`.
 * - `GET /v1/settings` → `{ features: [{ key, name, on, schema, values }] }`; `values` (`{ <setting>: { value, source } }`)
 *   only of switched-on features, null for the others. `PUT /v1/settings/<feature>.<key>` with `{ value }` answers
 *   `{ key, value, source }`, 422 `validation_failed` with `errors`, or 403 `feature_off`; `DELETE` resets it.
 * - `GET /v1/texts`, `PUT|DELETE /v1/texts/:key`; `GET /v1/theme`; `GET /v1/format` (K7). The theme and the Format are the
 *   Portal's (Website settings): `PUT /v1/theme` and `PUT /v1/format` answer 409 `managed_by_portal`, naming the Portal.
 * - `GET|PUT /v1/lists/:list` with `{ value }`: the whole list, checked by the product's own list check (422), only
 *   while one of its features is on (403 `feature_off`). Its dashboard twin, `GET|PUT
 *   /v1/dashboard/websites/:websiteId/lists/:list` (dashboard session), follows the same rules, except that Owner and
 *   Support may prepare the list of a switched-off feature (as the dashboard's settings).
 * - `GET /v1/connections` → `{ connections: [{ name, label, kind, neededBy, set, state, message, testedAt }] }`;
 *   `PUT /v1/connections/:name` with `{ value }` (checked and tested live), `DELETE`, `POST …/test`. Secrets never
 *   come back, not even their last characters: only `set` (true or false).
 * - `GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor=&limit=` (newest first) and its counts.
 *
 * Every write is a Recent change by the acting user (the verified staff member, K2; on the dashboard twin: the session's
 * merchant or admin); a setting, text or list save is also an activity-log entry (`settings.changed`) and raises
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
import { KIT_LINK_SCOPES } from './kit-routes.js';
import { allows } from './staff.js';
import { noContent, ok, paginate, problem } from './http/results.js';

/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {import('./recent.js').Who} Who */
/**
 * A list setting a product keeps (Chat's tools and flows, Ecommerce's order flow …).
 * @typedef {object} ListDefinition
 * @property {string | string[]} feature the feature it belongs to (any of them, for a list)
 * @property {string} title its name on screens and in Recent changes
 * @property {(websiteId: string) => Promise<unknown>} get the saved list, else its default
 * @property {(websiteId: string, value: unknown) => Promise<{ ok: true, value: unknown } | { ok: false, errors: Array<string | { path?: string, message: string, code?: string }> }>} save
 *   checks and saves the whole list; an error may carry a `code` the dashboard acts on (it is answered as given)
 * @property {Record<string, string>} [fieldPermissions] a field of the list's entries that needs one more permission (the
 *   product's own key) to change, on top of `settings.manage`, for a field that runs code: `{ scripts: 'scripts.manage' }`.
 *   A save that adds, edits or removes a value of the field (their order, case of the entries and every other field are
 *   free) without it is 403 `forbidden` and nothing is saved; it is read like `allows` for a ticket and a verified staff
 *   sign-in, a dashboard session of the merchant or of an Owner admin has it, a Support admin has not. The list's read on
 *   the dashboard says `locked` (the fields the caller may not change), and the activity log names the changed fields.
 * @property {string} [unique] the field no two entries share; with `fieldPermissions`, a value of a guarded field is kept by
 *   the entry it is in, so moving it to another entry is a change too (the entries' order and other fields stay free)
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
const DASHBOARD_LIST_WRITE_LIMIT = Object.freeze({ ...SETTINGS_WRITE_LIMIT, bucket: 'kit-dashboard-list-writes' });
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

/**
 * The values an entry field holds across a list, trimmed, empty ones left out, in a fixed order (so only an added, edited
 * or removed value is a change). With the list's `unique` field each value is kept by the entry it is in
 * (`<unique value>\n<value>`), so moving a value to another entry is a change too.
 * @param {unknown} list
 * @param {string} field
 * @param {string} [unique] the field no two entries share
 */
const valuesOf = (list, field, unique) =>
	(Array.isArray(list) ? list : [])
		.map((entry) => {
			if (!isObject(entry) || typeof entry[field] !== 'string') return '';
			const value = entry[field].trim();
			if (value === '' || !unique) return value;
			const owner = typeof entry[unique] === 'string' ? entry[unique].trim() : '';
			return `${owner}\n${value}`;
		})
		.filter((text) => text !== '')
		.sort();

/**
 * Whether the caller may change a field that needs one more permission: a ticket or a verified staff sign-in by what the
 * role grants (`allows`); a dashboard session of the merchant or an Owner admin always (they own the website or the
 * platform), a Support admin never.
 * @param {RequestContext} ctx
 * @param {string} permission
 */
const mayChange = (ctx, permission) =>
	ctx.session ? ctx.session.kind === 'merchant' || ctx.session.role === 'portal_owner' : allows(ctx, permission);

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
	 * Who changed it: on the dashboard, the session's merchant or admin; else the verified staff member, else the server.
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

	/**
	 * A list, whole (`{ value }`); on the dashboard, with fields that need one more permission, also the `locked` ones: those
	 * the caller may not change.
	 * @param {RequestContext} ctx
	 */
	const readList = async (ctx) => {
		const { definition } = listOf(ctx);
		const value = await definition.get(website(ctx));
		if (!ctx.session || !definition.fieldPermissions) return { value };
		const locked = Object.entries(definition.fieldPermissions)
			.filter(([, permission]) => !mayChange(ctx, permission))
			.map(([field]) => field);
		return { value, locked };
	};

	/**
	 * The guarded fields (`fieldPermissions`) a save changes; one the caller may not change is 403 `forbidden`, before
	 * anything is saved.
	 * @param {RequestContext} ctx
	 * @param {ListDefinition} definition
	 * @param {unknown} sent the list as sent
	 * @returns {Promise<string[]>}
	 */
	const guardedChanges = async (ctx, definition, sent) => {
		const guarded = Object.entries(definition.fieldPermissions ?? {});
		if (guarded.length === 0) return [];
		const before = await definition.get(website(ctx));
		const changed = guarded.filter(
			([field]) =>
				JSON.stringify(valuesOf(before, field, definition.unique)) !==
				JSON.stringify(valuesOf(sent, field, definition.unique)),
		);
		const refused = changed.find(([, permission]) => !mayChange(ctx, permission));
		if (refused)
			throw problem('forbidden', `Changing ${refused[0]} in ${definition.title} needs the permission ${refused[1]}.`);
		return changed.map(([field]) => field);
	};

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
		const sent = valueOf(ctx);
		const changedFields = await guardedChanges(ctx, definition, sent);
		const list = await definition.save(website(ctx), sent);
		if (!list.ok) {
			const errors = list.errors.map((error) =>
				typeof error === 'string'
					? { path: '/value', message: error }
					: { path: error.path ?? '/value', message: error.message, ...(error.code ? { code: error.code } : {}) },
			);
			throw problem('validation_failed', errors[0]?.message ?? 'The list is not valid.', { errors });
		}
		const who = whoOf(ctx);
		const detail = changedFields.length > 0 ? `changed (${changedFields.join(', ')})` : 'changed';
		await kit.recent.record({ websiteId: website(ctx), who, what: 'settings', detail: `${definition.title}: ${detail}` });
		await kit.settingsChanged(ctx, { what: 'list', key: name, who, label: definition.title, detail });
		return { value: list.value };
	};

	/** @param {import('./connections.js').ConnectionView} view */
	const connectionView = (view) => ({
		name: view.name,
		label: view.label,
		kind: view.kind,
		neededBy: view.neededBy,
		managed: view.managed,
		set: view.set,
		state: view.status,
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
			runtime: true,
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
			runtime: true,
			// Ecommerce reads Growth's tag ids through a link (Growth offers `settings.read`)
			...(kit.manifest.links?.offers?.some(
				(/** @type {{ scope: string }} */ offer) => offer.scope === KIT_LINK_SCOPES.settingsRead,
			)
				? { scope: KIT_LINK_SCOPES.settingsRead }
				: {}),
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
		route({ method: 'PUT', path: '/v1/settings/:key', permission: 'settings.manage', rateLimit: writes, handler: setting }),
		route({ method: 'DELETE', path: '/v1/settings/:key', permission: 'settings.manage', rateLimit: writes, handler: setting }),
		route({
			method: 'GET',
			path: '/v1/texts',
			runtime: true,
			handler: async (ctx) => ({ texts: await kit.settings.textsOf(website(ctx)) }),
		}),
		route({ method: 'PUT', path: '/v1/texts/:key', permission: 'settings.manage', rateLimit: writes, handler: text }),
		route({ method: 'DELETE', path: '/v1/texts/:key', permission: 'settings.manage', rateLimit: writes, handler: text }),
		route({ method: 'GET', path: '/v1/theme', runtime: true, handler: async (ctx) => kit.settings.themeOf(website(ctx)) }),
		route({
			method: 'PUT',
			path: '/v1/theme',
			permission: 'settings.manage',
			rateLimit: writes,
			handler: async (ctx) => {
				// the theme is the Portal's (Website settings › Brand and look): always 409 `managed_by_portal`
				await saved(ctx, { what: 'theme' }, kit.settings.refuseTheme());
				return kit.settings.themeOf(website(ctx));
			},
		}),
		route({ method: 'GET', path: '/v1/format', runtime: true, handler: async (ctx) => kit.settings.formatOf(website(ctx)) }),
		route({
			method: 'PUT',
			path: '/v1/format',
			permission: 'settings.manage',
			rateLimit: writes,
			handler: async (ctx) => {
				// the Format is the Portal's (Website settings › Region and format): always 409 `managed_by_portal`
				await saved(ctx, { what: 'format' }, kit.settings.refuseFormat());
				return kit.settings.formatOf(website(ctx));
			},
		}),
		route({ method: 'GET', path: '/v1/lists/:list', runtime: true, handler: readList }),
		route({ method: 'PUT', path: '/v1/lists/:list', permission: 'settings.manage', rateLimit: writes, handler: saveList }),
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
			permission: 'connections.manage',
			handler: async (ctx) => ({ connections: (await kit.connections.list(website(ctx))).map(connectionView) }),
		}),
		route({
			method: 'PUT',
			path: '/v1/connections/:name',
			permission: 'connections.manage',
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
			permission: 'connections.manage',
			rateLimit: writes,
			handler: async (ctx) => {
				orThrow(await kit.connections.remove({ websiteId: website(ctx), name: String(ctx.params.name), who: whoOf(ctx) }));
				return noContent();
			},
		}),
		route({
			method: 'POST',
			path: '/v1/connections/:name/test',
			permission: 'connections.manage',
			rateLimit: writes,
			handler: async (ctx) => {
				const result = await kit.connections.test({ websiteId: website(ctx), name: String(ctx.params.name) });
				if (!result.ok) throw result.problem;
				if (result.tested) {
					const tested = result.tested;
					ctx.after(() => kit.portalConnections.reportTest(website(ctx), tested.name, tested));
				}
				return connectionView(result.connection);
			},
		}),
		route({
			method: 'GET',
			path: '/v1/activity',
			permission: 'audit.read',
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
		route({
			method: 'GET',
			path: '/v1/activity/count',
			permission: 'audit.read',
			database: true,
			handler: activityCounts.count,
		}),
		route({
			method: 'GET',
			path: '/v1/activity/counts',
			permission: 'audit.read',
			database: true,
			handler: activityCounts.counts,
		}),
	];
};
