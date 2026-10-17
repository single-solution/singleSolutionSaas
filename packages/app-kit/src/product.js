/**
 * `createProduct` wires the kit for one product: the Portal connection, tokens and tickets, the status cache, notices,
 * price and feature reports, settings, widget texts, theme and Format, encrypted connections, the merchant database,
 * business.json, data rights, the activity log and its reads, Recent changes, the product dashboard API, the settings
 * API for the merchant's server, events, staff alerts, imports (PLAN 0.8.10 K1–K10), the default templates of the
 * messages the product sends (parity P1) and the product's part of each website's Setup sheet (`GET /v1/blueprint`,
 * with what the website builds per feature, and the advisor's Switch on). Every side effect is injected (fetch, clock,
 * randomness, logger, store, outbound calls).
 * @module
 */
import { BUILD_TEXT_MAX, checkSettingsSchema, createProblemFactory, validateManifest } from '@ss/contracts';
import { formatDate, formatMoney } from '@ss/contracts/format';
import { allowHostsFor, createOutboundPolicy, safeFetch } from '@ss/net';
import { MongoClient } from 'mongodb';
import { isObject } from '@ss/contracts/util';
import { ACTIVITY_INDEXES, createActivity } from './activity.js';
import { createBlueprint } from './blueprint.js';
import { createBusiness } from './business.js';
import { createConnection } from './connection.js';
import { checkConnectionDefinitions, createConnections } from './connections.js';
import { createDashboard } from './dashboard.js';
import { PRODUCT_DATABASE_OPTIONS, createData } from './data.js';
import { EVENT_INDEXES, createEvents } from './events.js';
import { IMPORT_FEATURE, createImports } from './imports.js';
import { createMessages } from './messages.js';
import { createRequestHandler } from './http/handler.js';
import { defineRoute } from './http/routes.js';
import { createAccountsSignIns } from './identity.js';
import { createKitRoutes } from './kit-routes.js';
import { noopLogger } from './logger.js';
import { createRecentChanges } from './recent.js';
import { createReports } from './reports.js';
import { createReseal } from './reseal.js';
import { createSealer } from './sealing.js';
import { createServerApi } from './server-api.js';
import { createSettings } from './settings.js';
import { createStaffAlerts } from './staff-alerts.js';
import { createStatus } from './status.js';
import { createMemoryStore } from './stores/memory.js';
import { createMongoStore } from './stores/mongo.js';
import { createTickets } from './tickets.js';
import { defaultRandomBytes, isKitError, kitError } from './util.js';
import { verifyToken } from '@ss/protocol';

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('./connections.js').ConnectionDefinition} ConnectionDefinition */
/** @typedef {import('./connections.js').OutboundSend} OutboundSend */
/**
 * A website's settings change in words: what (`settings`, `texts`, `theme`, `format` or `list`), which one (`key`: the
 * setting `<feature>.<setting>`, the text or the list), who changed it, and the change as Recent changes shows it
 * (`label`, for example `Checkout › Payment methods`, and `detail`, for example `changed`).
 * @typedef {{ what: 'settings' | 'texts' | 'theme' | 'format' | 'list', key?: string,
 *   who: import('./recent.js').Who, label: string, detail: string }} SettingsChange
 */

/**
 * @typedef {object} ProductOptions
 * @property {Manifest} manifest the product's `manifest.json`
 * @property {Record<string, string>} [strings] English widget texts (`strings/en.json`)
 * @property {import('./config.js').ProductConfig} [config] from `configFromEnv`
 * @property {string[]} [problems] from `configFromEnv`: when any, every route answers 503 naming them
 * @property {import('./stores/types.js').Store} [store] default: MongoDB on `config.mongodbUri`, else in memory
 * @property {typeof globalThis.fetch} [fetch] Portal calls
 * @property {() => number} [now]
 * @property {(length: number) => Uint8Array} [randomBytes]
 * @property {import('./logger.js').Logger} [logger]
 * @property {string} [nodeEnv] default `process.env.NODE_ENV`
 * @property {import('@ss/net').OutboundPolicyOptions} [outbound] policy of calls to addresses merchants enter
 *   (`allowHostsFor`: this machine too under `next dev`; `allowHosts` is ignored in production)
 * @property {OutboundSend} [outboundSend] replaces `@ss/net` `safeFetch` for those calls (tests)
 * @property {Record<string, { status: number, title: string }>} [problemCodes] the product's own problem codes
 * @property {import('./kit-routes.js').ProductHooks} [hooks]
 * @property {Record<string, ConnectionDefinition>} [connections] the product's Connections (a `database` connection is
 *   always there)
 * @property {{ indexes?: import('./data.js').IndexDefinition[], createClient?: (uri: string, options: import('mongodb').MongoClientOptions) => MongoClient }} [data]
 *   merchant database indexes (created on a website's first use per instance) and a client factory (tests)
 * @property {Record<string, import('./settings.js').SharedSettings>} [sharedSettings] settings several features use
 *   (PLAN 0.8.10 A2, A11): `{ <group>: { name, features, settings } }`, stored once as `<group>.<setting>`, read with
 *   `product.settings.values(websiteId, '<group>')` and shown while any of `features` is on
 * @property {Record<string, import('./server-api.js').ListDefinition>} [lists] the product's list settings, which the
 *   settings API serves at `GET|PUT /v1/lists/:list` (K1) and the dashboard at `GET|PUT
 *   /v1/dashboard/websites/:websiteId/lists/:list`
 * @property {boolean} [events] the product publishes events (K5): `product.events.emit`, forwarded through
 *   Notifications right after the request
 * @property {(input: { websiteId: string, token: string, ctx?: any }) => Promise<import('./identity.js').AccountsSignInResult>} [ownSignIns]
 *   Accounts only: it issues the sign-ins, so it verifies its own (with its signing key, the open session and the live
 *   role) instead of fetching keys from Accounts with a pasted token
 * @property {import('./imports.js').ImportOptions} [imports] what the product's `import` feature takes (K10): the kit
 *   serves the import routes (`/v1/import/…`, server token, feature `import`, which the manifest must have)
 * @property {unknown} [messages] the messages the product sends through Notifications with their default words (its
 *   `schemas/messages.json`, `{ messages: [...] }`; parity P1): attached to every send to Notifications and served at
 *   `GET /v1/message-defaults`
 * @property {unknown} [openapi] the product's OpenAPI document (its generated `openapi.json`): served publicly at
 *   `GET /openapi.json` and named in the Setup sheet (`docs.openapi`)
 * @property {Record<string, string>} [build] what the merchant's website builds for each feature (its guide's "What your
 *   website builds", `docs/guide.json` `build`): pages, routes, script tags and server calls, plain text of at most
 *   1,000 characters per feature of the manifest; the Setup sheet lists them for the features that are on
 */

/**
 * The internal parts `createProduct` wires (shared by the handler, the kit routes and the dashboard).
 * @typedef {object} Kit
 * @property {Manifest} manifest
 * @property {import('./stores/types.js').Store} store
 * @property {import('./logger.js').Logger} logger
 * @property {() => number} now
 * @property {(length: number) => Uint8Array} randomBytes
 * @property {import('@ss/contracts').ProblemFactory} problems
 * @property {ReadonlyArray<string>} configProblems
 * @property {ReturnType<typeof createConnection>} connection
 * @property {import('./recent.js').RecentChanges} recent
 * @property {import('./status.js').StatusCache} status
 * @property {import('./reports.js').Reports} reports
 * @property {import('./settings.js').Settings} settings
 * @property {import('./connections.js').Connections} connections
 * @property {import('./data.js').Data} data
 * @property {import('./business.js').Business} business
 * @property {import('./activity.js').Activity} activity
 * @property {import('./events.js').Events} events
 * @property {(ctx: { websiteId: string | null, merchantId: string | null, after: (task: () => Promise<unknown>) => void },
 *   change: SettingsChange) => Promise<void>} settingsChanged a website's settings change: activity-log entry and event
 * @property {import('./staff-alerts.js').StaffAlerts} staffAlerts
 * @property {import('./messages.js').Messages} messages
 * @property {ReturnType<typeof createAccountsSignIns>} accounts
 * @property {ReturnType<typeof createTickets>} tickets
 * @property {() => Promise<import('./reseal.js').ResealResult>} reseal the Owner's Re-seal of stored secrets (RT-14)
 * @property {ReturnType<typeof createDashboard>} dashboard
 */

/** Problem codes the kit answers with besides `@ss/contracts`'. */
const KIT_PROBLEM_CODES = Object.freeze({
	duplicate_request: Object.freeze({ status: 409, title: 'Duplicate request' }),
	in_progress: Object.freeze({ status: 409, title: 'Request in progress' }),
	needs_signed_in_staff: Object.freeze({ status: 403, title: 'A signed-in staff member is needed' }),
	invalid_sign_in: Object.freeze({ status: 401, title: 'The sign-in is not valid' }),
	accounts_unavailable: Object.freeze({ status: 503, title: 'Accounts cannot be reached' }),
	visitor_ip_required: Object.freeze({ status: 400, title: "The visitor's IP address is required" }),
	count_timeout: Object.freeze({ status: 503, title: 'Counting took too long' }),
	database_unavailable: Object.freeze({ status: 503, title: 'Database unavailable' }),
});

/**
 * The start-up pieces of a product, built from its options as `createProduct` builds them, for the product's own
 * adapters before it calls `createProduct` (list settings in the product database, AI, gateway or provider calls to
 * addresses merchants enter):
 *
 * - `store`: `options.store`, else MongoDB on `config.mongodbUri` with the kit's pool and deadlines
 *   (`PRODUCT_DATABASE_OPTIONS`, so a database that cannot be reached answers 503 `database_unavailable`), else in
 *   memory (development only: a warning is logged). Only a healthy configuration (no `problems`) opens MongoDB.
 * - `policy`: the `@ss/net` outbound policy of `options.outbound`, its hosts by `allowHostsFor`: under `next dev`
 *   this machine too (the other products and a local MongoDB on localhost), in production none (`allowHosts` is
 *   ignored).
 * - `send`: `options.outboundSend`, else `safeFetch` on that policy.
 *
 * Pass `store` on to `createProduct` (with the same `outbound` and `outboundSend`), so the kit and the product share it.
 * @param {Pick<ProductOptions, 'config' | 'problems' | 'store' | 'now' | 'logger' | 'nodeEnv' | 'outbound' | 'outboundSend'>} options
 * @returns {{ store: import('./stores/types.js').Store, policy: import('@ss/net').OutboundPolicy, send: OutboundSend }}
 */
export const createProductBase = (options) => {
	const { now = Date.now, logger = noopLogger } = options;
	const uri = (options.problems ?? []).length === 0 ? options.config?.mongodbUri : undefined;
	const store =
		options.store ??
		(uri
			? createMongoStore({ db: new MongoClient(uri, { ...PRODUCT_DATABASE_OPTIONS }).db(), now })
			: createMemoryStore({ now }));
	if (!options.store && !uri) logger.warn('using the in-memory store: development only');
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	const policy = createOutboundPolicy({
		...outboundRest,
		allowHosts: allowHostsFor(options.nodeEnv ?? process.env.NODE_ENV, allowHosts),
	});
	/** @type {OutboundSend} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
	return { store, policy, send };
};

/**
 * @param {ProductOptions} options
 */
export const createProduct = (options) => {
	const { manifest, now = Date.now, randomBytes = defaultRandomBytes, logger = noopLogger, fetch = globalThis.fetch } = options;
	const checked = validateManifest(manifest);
	if (!checked.ok)
		throw kitError(
			'invalid_manifest',
			`manifest is invalid: ${checked.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`,
		);
	const strings = options.strings ?? {};
	if (!isObject(strings) || Object.values(strings).some((text) => typeof text !== 'string'))
		throw kitError('invalid_config', 'strings must map text keys to English texts');
	const configProblems = Object.freeze([...(options.problems ?? [])]);
	if (configProblems.length > 0) logger.error('product is misconfigured: every route answers 503', { problems: configProblems });
	const healthy = configProblems.length === 0;
	const config = options.config;
	if (healthy && (!config || typeof config.connectSecret !== 'string' || typeof config.encryptionKey !== 'string'))
		throw kitError('invalid_config', 'config is required (configFromEnv)');
	const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;

	const { store, policy, send } = createProductBase(options);
	const problems = createProblemFactory({
		baseUri: `${manifest.endpoints.base.replace(/\/+$/, '')}/problems/`,
		codes: { ...KIT_PROBLEM_CODES, ...(options.problemCodes ?? {}) },
	});

	const sealer = createSealer({
		encryptionKey: healthy ? /** @type {string} */ (config?.encryptionKey) : Buffer.from(randomBytes(32)).toString('hex'),
		previousKey: healthy ? (config?.previousEncryptionKey ?? null) : null,
		randomBytes,
	});
	const connection = createConnection({
		store,
		manifest,
		connectSecret: config?.connectSecret ?? '',
		sealer,
		fetch,
		now,
		randomBytes,
		nodeEnv,
		logger,
	});
	const recent = createRecentChanges({ store, now, randomBytes });
	const status = createStatus({ store, client: () => connection.active().client, now, logger });
	const reports = createReports({ store, manifest, connection, status, recent, now, logger });
	const shared = options.sharedSettings ?? {};
	for (const [key, group] of Object.entries(shared)) {
		if (
			!/^[a-z][a-z0-9_]{0,40}$/.test(key) ||
			manifest.features.some((/** @type {{ key: string }} */ f) => f.key === key) ||
			group.features.length === 0 ||
			group.features.some((feature) => !manifest.features.some((/** @type {{ key: string }} */ f) => f.key === feature)) ||
			group.settings?.type !== 'object'
		)
			throw kitError('invalid_config', `shared settings ${key} must name features of the manifest and have a key of its own`);
		// the same rules as a feature's own settings (the contract), so a shared setting can never be a shape the
		// dashboards, the API or the Portal do not handle
		const problems = checkSettingsSchema(group.settings);
		if (problems.length > 0)
			throw kitError(
				'invalid_config',
				`shared settings ${key} are not a valid settings schema: ${problems.map((p) => `${p.path || '/'} ${p.message}`).join('; ')}`,
			);
	}
	const settings = createSettings({ store, manifest, strings, recent, now, shared });
	const messages = createMessages({ productId: manifest.id, declaration: options.messages });
	/** @type {ReturnType<typeof createData> | null} */
	let data = null;
	const connections = createConnections({
		store,
		productId: manifest.id,
		definitions: checkConnectionDefinitions(options.connections, manifest),
		sealer,
		recent,
		send,
		policy,
		testDatabase: (uri) => /** @type {ReturnType<typeof createData>} */ (data).testUri(uri),
		verifyServerToken: async (token, productId) => {
			const { portalUrl, portalKeys } = connection.active();
			try {
				return await verifyToken({
					token,
					keyResolver: portalKeys,
					issuer: portalUrl,
					productId,
					kind: 'server',
					isRevoked: status.isRevoked,
					now,
				});
			} catch {
				return null;
			}
		},
		directory: (id) => connection.active().client.directory(id),
		directoryList: () => connection.active().client.directoryList(),
		now,
		logger,
		attach: messages.attach,
	});
	data = createData({
		productId: manifest.id,
		uriOf: async (websiteId) => {
			const uri = await connections.value(websiteId, 'database');
			return typeof uri === 'string' ? uri : null;
		},
		now,
		logger,
		policy,
		...(options.data?.createClient ? { createClient: options.data.createClient } : {}),
		indexes: [...ACTIVITY_INDEXES, ...(options.events ? EVENT_INDEXES : []), ...(options.data?.indexes ?? [])],
	});
	const business = createBusiness({ store, send, now, logger });
	/**
	 * The normalized business.json copy of a website (defaults: name = domain, time zone UTC).
	 * @param {string} websiteId
	 */
	const businessOf = async (websiteId) => {
		const found = await status.lookup(websiteId);
		if (!found.ok) throw kitError(found.code, `status of ${websiteId} is not available`);
		return (await business.get(websiteId, found.status.domain)).business;
	};
	const activity = createActivity({ productId: manifest.id, data, connections, now, logger });
	const events = createEvents({ productId: manifest.id, enabled: options.events === true, data, connections, now, logger });
	/**
	 * A website's settings change (a setting, text, theme, Format or list, from the dashboard or the settings API): an
	 * activity-log entry by who changed it (`settings.changed`, the change in words), so the Activity screen and the
	 * activity copies show it like any other change (parity), and the `settings.changed` event (K5, SG-14). Only with the
	 * merchant database connected; it never fails the change.
	 * @type {Kit['settingsChanged']}
	 */
	const settingsChanged = async (ctx, { what, key, who, label, detail }) => {
		if (!ctx.websiteId) return;
		try {
			await activity.record(
				{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
				{
					actor: { kind: who.kind, id: who.id, name: who.name, ...(who.role ? { role: who.role } : {}) },
					action: 'settings.changed',
					target: key === undefined ? what : `${what}.${key}`,
					label,
					detail,
				},
			);
		} catch (error) {
			if (!isKitError(error, 'database_not_connected'))
				logger.warn('settings change not written to the activity log', { websiteId: ctx.websiteId, error });
		}
		await events.settingsChanged(ctx, { what, ...(key === undefined ? {} : { key }) });
	};
	const staffAlerts = createStaffAlerts({ productId: manifest.id, settings, connections, data, now, logger });
	if (options.imports !== undefined && !manifest.features.some((/** @type {{ key: string }} */ f) => f.key === IMPORT_FEATURE))
		throw kitError(
			'invalid_config',
			`imports need the feature ${IMPORT_FEATURE} in the manifest (the import routes belong to it)`,
		);
	const imports = createImports({
		options: options.imports,
		now,
		record: activity.record,
		business: (websiteId) => businessOf(websiteId),
	});
	const lists = options.lists ?? {};
	for (const [name, list] of Object.entries(lists))
		if (
			!/^[a-z][a-z0-9_]{0,40}$/.test(name) ||
			[list.feature].flat().some((key) => !manifest.features.some((/** @type {{ key: string }} */ f) => f.key === key))
		)
			throw kitError('invalid_config', `list ${name} must name features of the manifest`);
	const tickets = createTickets({ store, productId: manifest.id, sealer, now, randomBytes });
	const accounts = createAccountsSignIns({ connections, now, ...(options.ownSignIns ? { own: options.ownSignIns } : {}) });
	const hooks = options.hooks ?? {};
	const reseal = createReseal({
		sealer,
		parts: [
			{ part: 'connections', reseal: connections.reseal },
			{ part: 'keys', reseal: connection.resealKey },
			{ part: 'keys', reseal: tickets.resealKey },
		],
		hooks,
		websites: connections.websitesWithDatabase,
		data,
		logger,
	});

	const parts = {
		manifest,
		store,
		logger,
		now,
		randomBytes,
		problems,
		configProblems,
		connection,
		recent,
		status,
		reports,
		settings,
		connections,
		data,
		business,
		activity,
		events,
		settingsChanged,
		staffAlerts,
		messages,
		accounts,
		tickets,
		reseal,
	};
	/** @type {Kit} */
	const kit = { ...parts, dashboard: createDashboard(parts) };
	if (options.openapi !== undefined && !isObject(options.openapi))
		throw kitError('invalid_config', 'openapi must be the OpenAPI document (a JSON object)');
	const openapi = options.openapi === undefined ? null : JSON.stringify(options.openapi);
	const build = options.build ?? {};
	if (
		!isObject(build) ||
		Object.entries(build).some(
			([key, text]) =>
				!manifest.features.some((/** @type {{ key: string }} */ f) => f.key === key) ||
				typeof text !== 'string' ||
				text.trim().length === 0 ||
				text.length > BUILD_TEXT_MAX,
		)
	)
		throw kitError(
			'invalid_config',
			`build must map features of the manifest to texts of 1 to ${BUILD_TEXT_MAX} characters (what the website builds)`,
		);
	const blueprint = createBlueprint({
		kit,
		lists,
		hooks,
		events: options.events === true,
		openapi: openapi !== null,
		build: Object.freeze({ ...build }),
	});
	const kitRoutes = [
		...createKitRoutes(kit, hooks),
		...kit.dashboard.routes,
		...createServerApi(kit, lists),
		...(options.imports === undefined ? [] : imports.routes),
		...blueprint.routes,
		// the product's OpenAPI document: public, the same for every website
		...(openapi === null
			? []
			: [
					defineRoute({
						method: 'GET',
						path: '/openapi.json',
						auth: 'none',
						handler: () =>
							new Response(openapi, {
								headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
							}),
					}),
				]),
	];

	/**
	 * A website's Format and business time zone, with `money` and `date` for text the server makes (messages, invoices,
	 * hosted pages, chat answers; PLAN 0.8.10 K7, K8).
	 * @param {string} websiteId
	 */
	const formatOf = async (websiteId) => {
		const [{ format }, info] = await Promise.all([settings.formatOf(websiteId), businessOf(websiteId)]);
		const timeZone = info.timeZone ?? 'UTC';
		return Object.freeze({
			format,
			timeZone,
			/** @param {number} amount minor units @param {string} currency */
			money: (amount, currency) => formatMoney(amount, currency, format),
			/** @param {Date | number | string | null | undefined} value @param {import('@ss/contracts').DateStyle} [style] */
			date: (value, style = 'datetime') => formatDate(value, format, { timeZone, style }),
		});
	};

	return Object.freeze({
		manifest,
		/** Configuration problems; when any, every route answers 503 naming them. */
		problems: configProblems,
		/**
		 * The request handler for every kit route and the product's own routes.
		 * @param {ReadonlyArray<import('./http/routes.js').RouteDefinition>} routes
		 * @param {{ after?: (task: () => Promise<unknown>) => void }} [handlerOptions]
		 */
		handler: (routes, handlerOptions) => {
			return createRequestHandler(kit, [...kitRoutes, ...routes], handlerOptions);
		},
		/** Whether the product serves a website now (status checks). */
		serving: status.serving,
		/** @param {string} websiteId @returns {Promise<string[]>} switched-on feature keys */
		featuresOn: async (websiteId) => (await reports.switches(websiteId)).on,
		settings: Object.freeze({
			values: settings.values,
			texts: settings.texts,
			theme: async (/** @type {string} */ websiteId) => (await settings.themeOf(websiteId)).theme,
		}),
		connections: Object.freeze({ value: connections.value, storage: connections.storage }),
		callProduct: connections.callProduct,
		/** Another product's address (the Portal's directory, cached 5 minutes); throws when it cannot be found. */
		addressOf: connections.addressOf,
		/**
		 * Every connected product with its name and address, by id (the Portal's directory list, cached 5 minutes; the
		 * last good copy while the Portal cannot answer; throws when it was never read).
		 */
		products: connections.products,
		data: Object.freeze({ forWebsite: data.forWebsite }),
		business: businessOf,
		format: formatOf,
		activity: Object.freeze({ record: activity.record }),
		/**
		 * A settings change the product saves through its own routes (a list on its dashboard …), with who changed it and
		 * the change in words: an activity-log entry and the `settings.changed` event, as the kit writes for its own
		 * settings routes (never fails the change).
		 */
		settingsChanged,
		events: Object.freeze({
			emit: events.emit,
			list: events.list,
			count: events.count,
			counts: events.counts,
			/** Forward due events of a website after a public request (token requests do it by themselves). */
			drain: events.drain,
		}),
		staffAlerts: Object.freeze({ send: staffAlerts.send, prepare: staffAlerts.prepare, forget: staffAlerts.forget }),
		recentChanges: Object.freeze({ record: recent.record, list: recent.list }),
		/** Accounts sign-ins of a website, verified offline with its pasted Accounts token (PLAN 0.4.6). */
		accounts,
		/** This product's own address (the base URL it was connected with), or null before the first connect. */
		address: () => (kit.connection.connected() ? kit.connection.active().baseUrl : null),
		/** Close pooled merchant database connections (tests, shutdown). */
		close: () => data.closeAll(),
	});
};
