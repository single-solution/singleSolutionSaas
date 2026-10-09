/**
 * Composition root: builds the Portal from a validated config, a control-plane `Db` and the module list. Pure
 * wiring — no I/O happens here (the Mongo driver connects on first use), so building is cheap and testable.
 *
 * The returned object is what the Next.js adapters in `app/` call:
 * - `handle(request, options?)` — the Portal API (`/v1/*`); a console page render passes its memo
 * - `jwks()` — the published JWKS (Portal keys and token signing keys, distinct kids)
 * - `ensureIndexes()` — applies the declared indexes (on the first request after a deploy)
 * @module
 */
import { createProblemFactory } from '@ss/contracts';
import { createAudit } from './infra/audit.js';
import { createBackground } from './infra/background.js';
import { clearCookie, createLoginThrottle, createSessions, serializeCookie, sessionCookieName } from './infra/auth.js';
import { createAuthenticators } from './infra/authenticators.js';
import { createPortalKeys, createSecretBox } from './infra/crypto.js';
import { createLocks, createRegistry, createRepositories, createTransactionRunner, ensureIndexes } from './infra/db.js';
import { platformError } from './infra/errors.js';
import { INFRA_PROBLEMS, createApiHandler } from './infra/http.js';
import { createPlatformMailer } from './infra/mailer.js';
import { composeModules, moduleProblems } from './infra/modules.js';
import { can, websitesVisible } from './infra/rbac.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from './infra/schema.js';
import { createIdempotencyStore, createRateLimitStore, createReplayStore } from './infra/stores.js';
import { defaultRandomBytes } from './infra/util.js';

/** @typedef {import('./infra/config.js').PortalConfig} PortalConfig */

/** @typedef {import('./infra/modules.js').ModuleDefinition} ModuleDefinition */
/** @typedef {import('./infra/modules.js').SharedContext} SharedContext */
/** @typedef {import('./infra/logger.js').Logger} Logger */

/**
 * @param {{ config: Readonly<PortalConfig>, db: import('mongodb').Db, modules: ReadonlyArray<Readonly<ModuleDefinition>>,
 *   logger: Logger, now?: () => number, randomBytes?: (n: number) => Uint8Array,
 *   mailer?: import('./infra/mailer.js').Mailer, system?: import('./infra/system.js').SystemStore | null,
 *   background?: { mode?: 'on' | 'off', fallback?: import('./infra/http.js').AfterScheduler } }} options
 *   `background`: work after responses (default `off` when `config.env` is `test`); `fallback` runs it when the
 *   adapter gave no `after()` (default: in the background of the request)
 */
export const createPortal = ({
	config,
	db,
	modules,
	logger,
	now = Date.now,
	randomBytes = defaultRandomBytes,
	mailer,
	system = null,
	background: backgroundOptions = {},
}) => {
	const registry = createRegistry([...INFRA_COLLECTIONS, ...modules.flatMap((m) => m.collections ?? [])]);
	const repos = createRepositories(db, registry, { now });
	const moduleCodes = moduleProblems(modules);
	for (const code of Object.keys(moduleCodes))
		if (Object.hasOwn(INFRA_PROBLEMS, code)) throw new TypeError(`problem code ${code} is reserved by the infra layer`);
	const problems = createProblemFactory({ baseUri: config.problemBaseUri, codes: { ...INFRA_PROBLEMS, ...moduleCodes } });
	const keys = createPortalKeys(config.signingKeys, config.tokenSigningKeys);
	const locks = createLocks(repos.mutable(COLLECTIONS.locks), { now, randomBytes });
	const sessions = createSessions({
		repo: repos.mutable(COLLECTIONS.sessions),
		secret: config.sessionSecret,
		policies: config.sessions,
		now,
		randomBytes,
	});
	const replayStore = createReplayStore(repos.mutable(COLLECTIONS.replay), { now });
	const audit = createAudit({ repo: repos.appendOnly(COLLECTIONS.audit), now, randomBytes });

	/** @type {SharedContext} */
	const shared = Object.freeze({
		config,
		logger,
		now,
		randomBytes,
		problems,
		keys,
		secretBox: createSecretBox({ encryptionKey: config.encryptionKey, randomBytes }),
		audit,
		withTransaction: createTransactionRunner(db.client),
		mailer: mailer ?? createPlatformMailer({ config, logger: logger.child({ component: 'mailer' }) }),
		locks,
		sessions,
		loginThrottle: createLoginThrottle({ repo: repos.mutable(COLLECTIONS.loginThrottle), secret: config.sessionSecret, now }),
		replayStore,
		cookies: Object.freeze({
			name: (/** @type {'admin' | 'merchant'} */ kind) => sessionCookieName(kind, config.cookieSecure),
			set: (/** @type {'admin' | 'merchant'} */ kind, /** @type {string} */ token, /** @type {number} */ maxAgeSeconds) =>
				serializeCookie(sessionCookieName(kind, config.cookieSecure), token, { maxAgeSeconds, secure: config.cookieSecure }),
			clear: (/** @type {'admin' | 'merchant'} */ kind) =>
				clearCookie(sessionCookieName(kind, config.cookieSecure), { secure: config.cookieSecure }),
		}),
		rbac: Object.freeze({ can, websitesVisible }),
		system,
	});

	const composed = composeModules(modules, {
		shared,
		collection: (module, name) => {
			const def = registry.get(name);
			if (def.module !== module)
				throw platformError('foreign_collection', `module ${module} cannot access ${name} (owned by ${def.module})`);
			return repos.repo(name);
		},
	});

	const background = createBackground({
		logger: logger.child({ component: 'background' }),
		mode: backgroundOptions.mode ?? (config.env === 'test' ? 'off' : 'on'),
		...(backgroundOptions.fallback ? { fallback: backgroundOptions.fallback } : {}),
		// a product calling the Portal is the moment to retry its failed notices (PLAN 0.4.12)
		onProductCall: async (productId) => composed.ports.productCalled?.(productId),
	});

	const api = createApiHandler({
		routes: composed.routes,
		problems,
		logger,
		authenticators: createAuthenticators({
			sessions,
			replayStore,
			ports: composed.ports,
			portalUrl: config.portalUrl,
			cookieSecure: config.cookieSecure,
			now,
		}),
		allowedOrigin: config.portalUrl,
		can,
		idempotency: createIdempotencyStore(repos.mutable(COLLECTIONS.idempotency), { now }),
		idempotencySecret: config.idempotencySecret,
		rateLimits: createRateLimitStore(repos.mutable(COLLECTIONS.rateLimits)),
		now,
		randomBytes,
		maxBodyBytes: config.maxBodyBytes,
		afterResponse: background.afterResponse,
	});
	/**
	 * @param {Request} request
	 * @param {{ memo?: Map<string, unknown> }} [options] the memo of the console page render the request belongs to
	 */
	const handle = (request, options) => api(request, options);

	return Object.freeze({
		config,
		registry,
		shared,
		modules: composed,
		/** Work right after responses (`on`, or `off` in tests). */
		background: Object.freeze({ mode: background.mode }),
		handle,
		/** Published JWKS: Portal keys (current + previous) and token signing keys. */
		jwks: () =>
			new Response(JSON.stringify(keys.publishedJwks()), {
				status: 200,
				headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300, stale-while-revalidate=60' },
			}),
		/** @param {{ dryRun?: boolean }} [options] */
		ensureIndexes: ({ dryRun = false } = {}) => ensureIndexes(db, registry, { dryRun, logger }),
	});
};
/** @typedef {ReturnType<typeof createPortal>} Portal */
