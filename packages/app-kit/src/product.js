/**
 * `createProduct` wires the kit for one product: the Portal connection, tokens and tickets, the status cache, notices,
 * price and feature reports, settings, widget texts, theme and Format, encrypted connections, the merchant database,
 * business.json, data rights, the activity log and its reads, Recent changes, the product dashboard API, the settings
 * API for the merchant's server, events, staff alerts and imports (PLAN 0.8.10 K1–K10). Every side effect is injected
 * (fetch, clock, randomness, logger, store, outbound calls).
 * @module
 */
import { PROBLEM_CODES, createProblemFactory, formatDate, formatMoney, validateManifest } from '@ss/contracts';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import { MongoClient } from 'mongodb';
import { ACTIVITY_INDEXES, createActivity } from './activity.js';
import { createBusiness } from './business.js';
import { createConnection } from './connection.js';
import { checkConnectionDefinitions, createConnections } from './connections.js';
import { createDashboard } from './dashboard.js';
import { createData } from './data.js';
import { EVENT_INDEXES, createEvents } from './events.js';
import { createImports } from './imports.js';
import { createRequestHandler } from './http/handler.js';
import { createAccountsSignIns, createIdentity } from './identity.js';
import { createKitRoutes } from './kit-routes.js';
import { noopLogger } from './logger.js';
import { createRecentChanges } from './recent.js';
import { createReports } from './reports.js';
import { createSealer } from './sealing.js';
import { createServerApi } from './server-api.js';
import { createSettings } from './settings.js';
import { createStaffAlerts } from './staff-alerts.js';
import { createStatus } from './status.js';
import { createMemoryStore } from './stores/memory.js';
import { createMongoStore } from './stores/mongo.js';
import { createTickets } from './tickets.js';
import { defaultRandomBytes, isObject, kitError } from './util.js';
import { verifyToken } from '@ss/protocol';

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('./connections.js').ConnectionDefinition} ConnectionDefinition */
/** @typedef {import('./connections.js').OutboundSend} OutboundSend */

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
 *   (`allowHosts` is ignored in production)
 * @property {OutboundSend} [outboundSend] replaces `@ss/net` `safeFetch` for those calls (tests)
 * @property {Record<string, { status: number, title: string }>} [problemCodes] the product's own problem codes
 * @property {import('./kit-routes.js').ProductHooks} [hooks]
 * @property {Record<string, ConnectionDefinition>} [connections] the product's Connections (a `database` connection is
 *   always there)
 * @property {{ indexes?: import('./data.js').IndexDefinition[], createClient?: (uri: string, options: import('mongodb').MongoClientOptions) => MongoClient }} [data]
 *   merchant database indexes (created on a website's first use per instance) and a client factory (tests)
 * @property {Record<string, import('./server-api.js').ListDefinition>} [lists] the product's list settings, which the
 *   settings API serves at `GET|PUT /v1/lists/:list` (K1)
 * @property {boolean} [events] the product publishes events (K5): `product.events.emit`, forwarded through
 *   Notifications right after the request
 * @property {import('./imports.js').ImportOptions} [imports] what the product's `import` feature takes (K10)
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
 * @property {ReturnType<typeof createTickets>} tickets
 * @property {ReturnType<typeof createDashboard>} dashboard
 */

/** Problem codes the kit answers with besides `@ss/contracts`'. */
const KIT_PROBLEM_CODES = Object.freeze({
	duplicate_request: Object.freeze({ status: 409, title: 'Duplicate request' }),
	invalid_actor: Object.freeze({ status: 400, title: 'Invalid acting user' }),
	visitor_ip_required: Object.freeze({ status: 400, title: "The visitor's IP address is required" }),
	count_timeout: Object.freeze({ status: 503, title: 'Counting took too long' }),
});

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
	const production = nodeEnv === 'production';

	const store =
		options.store ??
		(healthy && config?.mongodbUri
			? createMongoStore({
					db: new MongoClient(config.mongodbUri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000 }).db(),
					now,
				})
			: createMemoryStore({ now }));
	if (!options.store && !(healthy && config?.mongodbUri)) logger.warn('using the in-memory store: development only');

	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	const policy = createOutboundPolicy({ ...outboundRest, allowHosts: production ? [] : allowHosts });
	/** @type {OutboundSend} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
	const problems = createProblemFactory({
		baseUri: `${manifest.endpoints.base.replace(/\/+$/, '')}/problems/`,
		codes: {
			...Object.fromEntries(Object.entries(KIT_PROBLEM_CODES).filter(([code]) => !Object.hasOwn(PROBLEM_CODES, code))),
			...(options.problemCodes ?? {}),
		},
	});

	const connection = createConnection({
		store,
		manifest,
		connectSecret: config?.connectSecret ?? '',
		fetch,
		now,
		randomBytes,
		nodeEnv,
		logger,
	});
	const recent = createRecentChanges({ store, now, randomBytes });
	const status = createStatus({ store, client: () => connection.active().client, now, logger });
	const reports = createReports({ store, manifest, connection, status, recent, now, logger });
	const settings = createSettings({ store, manifest, strings, recent, now });
	const sealer = createSealer(
		healthy ? /** @type {string} */ (config?.encryptionKey) : Buffer.from(randomBytes(32)).toString('hex'),
		randomBytes,
	);
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
		now,
		logger,
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
	const activity = createActivity({ productId: manifest.id, data, connections, now, logger });
	const events = createEvents({ productId: manifest.id, enabled: options.events === true, data, connections, now, logger });
	const staffAlerts = createStaffAlerts({ productId: manifest.id, settings, connections, now, logger });
	const imports = createImports({ options: options.imports, now, record: activity.record });
	const lists = options.lists ?? {};
	for (const [name, list] of Object.entries(lists))
		if (
			!/^[a-z][a-z0-9_]{0,40}$/.test(name) ||
			[list.feature].flat().some((key) => !manifest.features.some((/** @type {{ key: string }} */ f) => f.key === key))
		)
			throw kitError('invalid_config', `list ${name} must name features of the manifest`);
	const tickets = createTickets({ store, productId: manifest.id, now, randomBytes });
	const identity = createIdentity({ connections, send, now });
	const accounts = createAccountsSignIns({ connections, now });

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
		tickets,
	};
	/** @type {Kit} */
	const kit = { ...parts, dashboard: createDashboard(parts) };
	const kitRoutes = [...createKitRoutes(kit, options.hooks ?? {}), ...kit.dashboard.routes, ...createServerApi(kit, lists)];

	/**
	 * The normalised business.json copy of a website (defaults: name = domain, time zone UTC).
	 * @param {string} websiteId
	 */
	const businessOf = async (websiteId) => {
		const found = await status.lookup(websiteId);
		if (!found.ok) throw kitError(found.code, `status of ${websiteId} is not available`);
		return (await business.get(websiteId, found.status.domain)).business;
	};

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
		handler: (routes, handlerOptions) => createRequestHandler(kit, [...kitRoutes, ...routes], handlerOptions),
		/** Whether the product serves a website now (status checks). */
		serving: status.serving,
		/** @param {string} websiteId @returns {Promise<string[]>} switched-on feature keys */
		featuresOn: async (websiteId) => (await reports.switches(websiteId)).on,
		reportPrices: reports.reportPrices,
		reportFeatures: reports.reportFeatures,
		settings: Object.freeze({
			values: settings.values,
			texts: settings.texts,
			theme: async (/** @type {string} */ websiteId) => (await settings.themeOf(websiteId)).theme,
		}),
		connections: Object.freeze({ value: connections.value, storage: connections.storage }),
		callProduct: connections.callProduct,
		data: Object.freeze({ forWebsite: data.forWebsite }),
		business: businessOf,
		format: formatOf,
		activity: Object.freeze({ record: activity.record }),
		events: Object.freeze({
			emit: events.emit,
			list: events.list,
			count: events.count,
			counts: events.counts,
			/** Forward due events of a website after a public request (token requests do it by themselves). */
			drain: events.drain,
		}),
		staffAlerts: Object.freeze({ send: staffAlerts.send }),
		imports: Object.freeze({ upsert: imports.upsert, finish: imports.finish, status: imports.status }),
		recentChanges: Object.freeze({ record: recent.record, list: recent.list }),
		identity,
		/** Accounts sign-ins of a website, verified offline with its pasted Accounts token (PLAN 0.4.6). */
		accounts,
		/** This product's own address (the base URL it was connected with), or null before the first connect. */
		address: () => (kit.connection.connected() ? kit.connection.active().baseUrl : null),
		/** Close pooled merchant database connections (tests, shutdown). */
		close: () => data.closeAll(),
	});
};
