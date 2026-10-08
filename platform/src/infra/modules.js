/**
 * Module definitions and their isolation boundary. A module is a plain object (see `modules/README.md`):
 *
 *   defineModule({ name, collections, problems, service, routes, ports })
 *
 * Every factory receives a {@link ModuleContext}. A module reaches **only its own collections** through
 * `ctx.collection(name)`; another module's data is reached through that module's public `service` via
 * `ctx.service(name)` (a module's own routes use `ctx.service(<own name>)` too; built lazily, so module order does not
 * matter; cycles are a boot error). Routes, problem codes and ports are global and collisions are boot errors. Nothing
 * runs on a schedule (PLAN F.19): work runs inside, or right after, the request that caused it.
 * @module
 */
import { platformError } from './errors.js';

/** @typedef {import('./db.js').CollectionDefinition} CollectionDefinition */
/** @typedef {import('./http.js').RouteDefinition} RouteDefinition */
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
 * @property {import('./crypto.js').Envelope} secretBox seal/open the Portal's stored secrets with `ENCRYPTION_KEY`
 *   (SMTP password, two-step secrets, server tokens; PLAN 0.4.8)
 * @property {import('./audit.js').Audit} audit
 * @property {import('./db.js').Locks} locks
 * @property {import('./db.js').WithTransaction} withTransaction run `fn(session)` in a retried multi-document
 *   transaction; pass `{ session }` to every repository call inside it
 * @property {import('./mailer.js').Mailer} mailer platform mailer (setup links, invites, resets, e-mail changes, two-step notices)
 * @property {import('./auth.js').Sessions} sessions
 * @property {import('./auth.js').LoginThrottle} loginThrottle
 * @property {import('@ss/protocol').ReplayStore} replayStore
 * @property {{ name: (kind: 'admin' | 'merchant') => string, set: (kind: 'admin' | 'merchant', token: string, maxAgeSeconds: number) => string, clear: (kind: 'admin' | 'merchant') => string }} cookies
 * @property {{ can: typeof import('./rbac.js').can, websitesVisible: typeof import('./rbac.js').websitesVisible }} rbac
 * @property {import('./system.js').SystemStore | null} system generated secrets and recorded settings (admin settings,
 *   key rotation); null when the Portal was built without one (tests)
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
 * @property {string} name lower-case identifier; collections are `<name>_*`
 * @property {ReadonlyArray<Readonly<CollectionDefinition>>} [collections]
 * @property {Readonly<Record<string, { status: number, title: string }>>} [problems] extra RFC 9457 codes
 * @property {(ctx: ModuleContext) => object} [service] public API for other modules
 * @property {(ctx: ModuleContext) => RouteDefinition[]} [routes]
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
	for (const key of ['service', 'routes', 'ports']) {
		const value = /** @type {Record<string, unknown>} */ (definition)[key];
		if (value !== undefined && typeof value !== 'function')
			throw new TypeError(`module ${name}: ${key} must be a factory function`);
	}
	return Object.freeze({ ...definition });
};

/**
 * Wire modules over the shared context: per-module contexts, lazy services, then routes and ports.
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
	/** @type {AuthPorts & Record<string, unknown>} */
	const ports = {};
	/** @type {Record<string, string>} */
	const portOwners = {};

	for (const m of byName.values()) {
		const ctx = contextOf(m.name);
		if (m.routes) routes.push(...m.routes(ctx));
		for (const [port, impl] of Object.entries(m.ports?.(ctx) ?? {})) {
			if (Object.hasOwn(ports, port)) throw new TypeError(`port ${port} is provided by ${portOwners[port]} and ${m.name}`);
			ports[port] = impl;
			portOwners[port] = m.name;
		}
	}

	return Object.freeze({
		names: () => [...byName.keys()],
		routes,
		/** @type {AuthPorts} */
		ports,
		service: serviceOf,
		context: contextOf,
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
