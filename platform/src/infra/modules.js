/**
 * Module definitions and their isolation boundary. A module is a plain object (see `modules/README.md`):
 *
 *   defineModule({ name, collections, migrations, problems, service, routes, jobs, crons, ports })
 *
 * Every factory receives a {@link ModuleContext}. A module reaches **only its own collections** through
 * `ctx.collection(name)`; another module's data is reached through that module's public `service` via
 * `ctx.service(name)` (a module's own routes use `ctx.service(<own name>)` too) (built lazily, so module order does not matter; cycles are a boot error). Job names are
 * namespaced `<module>.<job>`; cron names, routes, problem codes and ports are global and collisions are boot errors.
 * @module
 */
import { platformError } from './errors.js';

/** @typedef {import('./db.js').CollectionDefinition} CollectionDefinition */
/** @typedef {import('./db.js').Migration} Migration */
/** @typedef {import('./http.js').RouteDefinition} RouteDefinition */
/** @typedef {import('./jobs.js').JobHandler} JobHandler */
/** @typedef {import('./jobs.js').CronHandler} CronHandler */
/** @typedef {import('./authenticators.js').AuthPorts} AuthPorts */
/** @typedef {import('./logger.js').Logger} Logger */

/**
 * Shared services every module may use (built once by the composition root).
 * @typedef {object} SharedContext
 * @property {Readonly<import('./config.js').PortalConfig>} config
 * @property {Logger} logger
 * @property {() => number} now
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {import('@ss/contracts').ProblemFactory} problems
 * @property {import('./crypto.js').PortalKeys} keys Portal signer(s), JWKS, resolver over our own keys
 * @property {import('./crypto.js').Envelope} envelope seal/open client credentials
 * @property {ReturnType<typeof import('./crypto.js').createSecretHasher>} secretHasher website secret keys at rest
 * @property {import('./audit.js').Audit} audit
 * @property {import('./jobs.js').Jobs} jobs
 * @property {import('./jobs.js').CronRuns} cronRuns last run of every registered cron (read only, health pages)
 * @property {import('./db.js').Locks} locks
 * @property {import('./db.js').WithTransaction} withTransaction run `fn(session)` in a retried multi-document
 *   transaction; pass `{ session }` to every repository call inside it
 * @property {import('./authenticators.js').WebsiteKeyVerifier} verifyWebsiteKey the `websiteKey` authenticator's
 *   verification, for keys carried outside the `Authorization` header (throws infra problems)
 * @property {import('./mailer.js').Mailer} mailer platform mailer (verify e-mail, password reset, invite, staff setup)
 * @property {import('./auth.js').Sessions} sessions
 * @property {import('./auth.js').LoginThrottle} loginThrottle
 * @property {import('@ss/protocol').ReplayStore} replayStore
 * @property {{ name: (kind: 'staff' | 'merchant') => string, set: (kind: 'staff' | 'merchant', token: string, maxAgeSeconds: number) => string, clear: (kind: 'staff' | 'merchant') => string }} cookies
 * @property {{ can: typeof import('./rbac.js').can, websitesVisible: typeof import('./rbac.js').websitesVisible }} rbac
 */

/**
 * @typedef {SharedContext & {
 *   module: string,
 *   collection: (name: string) => any,
 *   service: (name: string) => any,
 *   moduleNames: () => string[],
 * }} ModuleContext
 */

/**
 * @typedef {object} ModuleDefinition
 * @property {string} name lower-case identifier; collections are `<name>_*`, jobs `<name>.*`
 * @property {ReadonlyArray<Readonly<CollectionDefinition>>} [collections]
 * @property {ReadonlyArray<Migration>} [migrations]
 * @property {Readonly<Record<string, { status: number, title: string }>>} [problems] extra RFC 9457 codes
 * @property {(ctx: ModuleContext) => object} [service] public API for other modules
 * @property {(ctx: ModuleContext) => RouteDefinition[]} [routes]
 * @property {(ctx: ModuleContext) => Record<string, JobHandler>} [jobs]
 * @property {(ctx: ModuleContext) => Record<string, CronHandler>} [crons]
 * @property {(ctx: ModuleContext) => AuthPorts} [ports] implementations of infra ports (one provider per port)
 */

const NAME = /^[a-z][a-z0-9]*$/;
const RESERVED = new Set(['platform']);

/**
 * Validate and freeze a module definition.
 * @param {ModuleDefinition} definition
 * @returns {Readonly<ModuleDefinition>}
 */
export const defineModule = (definition) => {
	const { name } = definition;
	if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) throw new TypeError(`invalid module name: ${name}`);
	for (const collection of definition.collections ?? []) {
		if (collection.module !== name)
			throw new TypeError(`module ${name} declares collection ${collection.name} of module ${collection.module}`);
	}
	for (const migration of definition.migrations ?? []) {
		if (!String(migration.id).includes(`-${name}-`))
			throw new TypeError(`migration ${migration.id} must be named YYYYMMDDHHMM-${name}-<slug>`);
	}
	for (const key of ['service', 'routes', 'jobs', 'crons', 'ports']) {
		const value = /** @type {Record<string, unknown>} */ (definition)[key];
		if (value !== undefined && typeof value !== 'function')
			throw new TypeError(`module ${name}: ${key} must be a factory function`);
	}
	return Object.freeze({ ...definition });
};

/**
 * Wire modules over the shared context: per-module contexts, lazy services, then routes, jobs, crons and ports.
 * @param {ReadonlyArray<Readonly<ModuleDefinition>>} modules
 * @param {{ shared: SharedContext, collection: (module: string, name: string) => any }} options
 */
export const composeModules = (modules, { shared, collection }) => {
	/** @type {Map<string, Readonly<ModuleDefinition>>} */
	const byName = new Map();
	for (const m of modules) {
		const checked = defineModule(m);
		if (byName.has(checked.name)) throw new TypeError(`module ${checked.name} is registered twice`);
		byName.set(checked.name, checked);
	}
	/** @type {Map<string, object>} */
	const services = new Map();
	/** @type {Set<string>} */
	const building = new Set();

	/**
	 * @param {string} name
	 * @returns {object}
	 */
	const serviceOf = (name) => {
		const built = services.get(name);
		if (built) return built;
		const m = byName.get(name);
		if (!m) throw platformError('unknown_module', `module ${name} is not registered`);
		if (!m.service) throw platformError('no_service', `module ${name} exposes no service`);
		if (building.has(name)) throw platformError('service_cycle', `service dependency cycle through ${name}`);
		building.add(name);
		try {
			const service = Object.freeze(m.service(contextOf(name)));
			services.set(name, service);
			return service;
		} finally {
			building.delete(name);
		}
	};

	/** @type {Map<string, ModuleContext>} */
	const contexts = new Map();
	/**
	 * @param {string} name
	 * @returns {ModuleContext}
	 */
	const contextOf = (name) => {
		const existing = contexts.get(name);
		if (existing) return existing;
		/** @type {ModuleContext} */
		const ctx = Object.freeze({
			...shared,
			module: name,
			logger: shared.logger.child({ module: name }),
			collection: (/** @type {string} */ collectionName) => collection(name, collectionName),
			service: (/** @type {string} */ other) => serviceOf(other),
			moduleNames: () => [...byName.keys()],
		});
		contexts.set(name, ctx);
		return ctx;
	};

	/** @type {RouteDefinition[]} */
	const routes = [];
	/** @type {Record<string, JobHandler>} */
	const jobs = {};
	/** @type {Record<string, CronHandler>} */
	const crons = {};
	/** @type {AuthPorts & Record<string, unknown>} */
	const ports = {};
	/** @type {Record<string, string>} */
	const portOwners = {};

	for (const m of byName.values()) {
		const ctx = contextOf(m.name);
		if (m.routes) routes.push(...m.routes(ctx));
		for (const [jobName, handler] of Object.entries(m.jobs?.(ctx) ?? {})) {
			if (!jobName.startsWith(`${m.name}.`))
				throw new TypeError(`job ${jobName} of module ${m.name} must be named ${m.name}.<job>`);
			jobs[jobName] = handler;
		}
		for (const [cronName, handler] of Object.entries(m.crons?.(ctx) ?? {})) {
			if (Object.hasOwn(crons, cronName)) throw new TypeError(`cron ${cronName} is registered twice`);
			crons[cronName] = handler;
		}
		for (const [port, impl] of Object.entries(m.ports?.(ctx) ?? {})) {
			if (Object.hasOwn(ports, port)) throw new TypeError(`port ${port} is provided by ${portOwners[port]} and ${m.name}`);
			ports[port] = impl;
			portOwners[port] = m.name;
		}
	}

	return Object.freeze({
		names: () => [...byName.keys()],
		routes,
		jobs,
		crons,
		/** @type {AuthPorts} */
		ports,
		service: serviceOf,
		context: contextOf,
		migrations: () => [...byName.values()].flatMap((m) => m.migrations ?? []),
	});
};

/**
 * Extra problem codes of all modules (duplicates are a boot error).
 * @param {ReadonlyArray<Readonly<ModuleDefinition>>} modules
 * @returns {Record<string, { status: number, title: string }>}
 */
export const moduleProblems = (modules) => {
	/** @type {Record<string, { status: number, title: string }>} */
	const out = {};
	for (const m of modules) {
		for (const [code, definition] of Object.entries(m.problems ?? {})) {
			if (Object.hasOwn(out, code)) throw new TypeError(`problem code ${code} is declared twice`);
			out[code] = definition;
		}
	}
	return out;
};
