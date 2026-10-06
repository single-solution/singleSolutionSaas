/**
 * Composition root: builds the Portal from a validated config, a control-plane `Db` and the module list. Pure
 * wiring — no I/O happens here (the Mongo driver connects on first use), so building is cheap and testable.
 *
 * The returned object is what the Next.js adapters in `app/` call:
 * - `handle(request)` — the Portal API (`/v1/*`; admin operations at `/v1/admin/operations/:name`)
 * - `jwks()` — the published JWKS (Portal keys and website-key signing keys, distinct kids)
 * - `readyz()` — dependency check
 * - `ensureIndexes()`, `migrate()` — operational entry points (scripts, deploy pipeline)
 * @module
 */
import { createProblemFactory } from '@ss/contracts';
import { createAudit } from './infra/audit.js';
import { createBackground } from './infra/background.js';
import { clearCookie, createLoginThrottle, createSessions, serializeCookie, sessionCookieName } from './infra/auth.js';
import { createAuthenticators, createWebsiteKeyVerifier } from './infra/authenticators.js';
import { createEnvelope, createPortalKeys, createSecretHasher } from './infra/crypto.js';
import {
	createLocks,
	createRegistry,
	createRepositories,
	createTransactionRunner,
	ensureIndexes,
	runMigrations,
} from './infra/db.js';
import { platformError } from './infra/errors.js';
import { INFRA_PROBLEMS, createApiHandler, defineRoute, ok, problem } from './infra/http.js';
import { createPlatformMailer } from './infra/mailer.js';
import { createJobs, createOperationRunner, createOperationRuns } from './infra/jobs.js';
import { composeModules, moduleProblems } from './infra/modules.js';
import { can, websitesVisible } from './infra/rbac.js';
import { afterResponse } from './infra/request-scope.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from './infra/schema.js';
import { createIdempotencyStore, createRateLimitStore, createReplayStore } from './infra/stores.js';
import { defaultRandomBytes } from './infra/util.js';

/** @typedef {import('./infra/config.js').PortalConfig} PortalConfig */

/** Built-in operation that verifies the audit hash chains (admin console; resumable with `after`). */
export const AUDIT_VERIFY_OPERATION = 'audit_verify';
/** Built-in operation that runs due jobs of the queue (admin console "Run due jobs"; bounded). */
export const DRAIN_OPERATION = 'drain';
/** A job enqueued during a request runs right after its response, within this budget (F.19: no queue drains). */
export const REQUEST_JOB_BUDGET_MS = 8_000;
/** @typedef {import('./infra/modules.js').ModuleDefinition} ModuleDefinition */
/** @typedef {import('./infra/modules.js').SharedContext} SharedContext */
/** @typedef {import('./infra/logger.js').Logger} Logger */

/**
 * Liveness: no dependencies, no configuration.
 * @param {{ version?: string, now?: () => number }} [options]
 */
export const healthz = ({ version = 'dev', now = Date.now } = {}) =>
	new Response(JSON.stringify({ status: 'ok', version, time: new Date(now()).toISOString() }), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});

/**
 * @param {{ config: Readonly<PortalConfig>, db: import('mongodb').Db, modules: ReadonlyArray<Readonly<ModuleDefinition>>,
 *   logger: Logger, now?: () => number, randomBytes?: (n: number) => Uint8Array, random?: () => number,
 *   pingTimeoutMs?: number, mailer?: import('./infra/mailer.js').Mailer,
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
	random = Math.random,
	pingTimeoutMs = 2_000,
	mailer,
	background: backgroundOptions = {},
}) => {
	const registry = createRegistry([...INFRA_COLLECTIONS, ...modules.flatMap((m) => m.collections ?? [])]);
	const repos = createRepositories(db, registry, { now });
	const moduleCodes = moduleProblems(modules);
	for (const code of Object.keys(moduleCodes))
		if (Object.hasOwn(INFRA_PROBLEMS, code)) throw new TypeError(`problem code ${code} is reserved by the infra layer`);
	const problems = createProblemFactory({ baseUri: config.problemBaseUri, codes: { ...INFRA_PROBLEMS, ...moduleCodes } });
	const keys = createPortalKeys(config.signingKeys, config.websiteKeySigningKeys);
	const locks = createLocks(repos.mutable(COLLECTIONS.locks), { now, randomBytes });
	const sessions = createSessions({
		repo: repos.mutable(COLLECTIONS.sessions),
		secret: config.sessionSecret,
		policies: config.sessions,
		now,
		randomBytes,
	});
	const replayStore = createReplayStore(repos.mutable(COLLECTIONS.replay), { now });
	const jobs = createJobs({
		repo: repos.mutable(COLLECTIONS.jobs),
		now,
		randomBytes,
		random,
		logger: logger.child({ component: 'jobs' }),
		// event-driven (F.19): a job a request enqueued runs right after that request's response, and only that job
		onEnqueued: ({ id }) => {
			afterResponse(() =>
				jobs.runBatch({
					handlers: jobHandlers,
					ids: [id],
					maxJobs: 1,
					deadlineMs: REQUEST_JOB_BUDGET_MS,
					owner: 'request',
					safetyMs: 1_000,
				}),
			);
		},
	});

	// ports are known once the modules are composed; the verifier reads them lazily
	/** @type {import('./infra/authenticators.js').AuthPorts} */
	let ports = {};
	const verifyWebsiteKey = createWebsiteKeyVerifier({
		keyResolver: keys.websiteKeyResolver,
		revoked: () => ports.websiteKeyRevoked,
		now,
	});
	const audit = createAudit({
		repo: repos.appendOnly(COLLECTIONS.audit),
		locks,
		now,
		randomBytes,
		logger: logger.child({ component: 'audit' }),
	});

	/** @type {SharedContext} */
	const shared = Object.freeze({
		config,
		logger,
		now,
		randomBytes,
		problems,
		keys,
		envelope: createEnvelope({ keks: config.keks, randomBytes }),
		secretHasher: createSecretHasher(config.websiteKeyPepper),
		audit,
		jobs,
		// the runner is built after the modules (it needs their operations); names are read when asked
		operationRuns: createOperationRuns({
			runs: repos.appendOnly(COLLECTIONS.operationRuns),
			names: () => operationRunner.names(),
		}),
		withTransaction: createTransactionRunner(db.client),
		verifyWebsiteKey,
		mailer: mailer ?? createPlatformMailer({ config, logger: logger.child({ component: 'mailer' }) }),
		locks,
		sessions,
		loginThrottle: createLoginThrottle({ repo: repos.mutable(COLLECTIONS.loginThrottle), secret: config.sessionSecret, now }),
		replayStore,
		cookies: Object.freeze({
			name: (/** @type {'staff' | 'merchant'} */ kind) => sessionCookieName(kind, config.cookieSecure),
			set: (/** @type {'staff' | 'merchant'} */ kind, /** @type {string} */ token, /** @type {number} */ maxAgeSeconds) =>
				serializeCookie(sessionCookieName(kind, config.cookieSecure), token, { maxAgeSeconds, secure: config.cookieSecure }),
			clear: (/** @type {'staff' | 'merchant'} */ kind) =>
				clearCookie(sessionCookieName(kind, config.cookieSecure), { secure: config.cookieSecure }),
		}),
		rbac: Object.freeze({ can, websitesVisible }),
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
	ports = composed.ports;

	for (const name of [DRAIN_OPERATION, AUDIT_VERIFY_OPERATION])
		if (Object.hasOwn(composed.operations, name)) throw new TypeError(`operation ${name} is reserved`);

	/** @type {Record<string, import('./infra/jobs.js').JobHandler>} */
	const jobHandlers = { ...composed.jobs };

	/** @type {Record<string, import('./infra/jobs.js').OperationHandler>} */
	const operations = {
		// built-in: run due jobs (failed jobs waiting for their retry time included) within the time budget
		[DRAIN_OPERATION]: async ({ deadline }) =>
			jobs.runBatch({ handlers: jobHandlers, deadlineMs: Math.max(0, deadline - now()), owner: 'operation:drain' }),
		// built-in: recompute the audit hash chains from `after` on; a run cut by its deadline returns `resumeAfter`
		[AUDIT_VERIFY_OPERATION]: async ({ deadline, signal, input }) =>
			audit.verifyAll({ deadline, signal, after: typeof input.after === 'string' ? input.after : null }),
		...composed.operations,
	};

	const operationRunner = createOperationRunner({
		operations,
		locks,
		runs: repos.appendOnly(COLLECTIONS.operationRuns),
		logger: logger.child({ component: 'operations' }),
		deadlineMs: config.operationDeadlineMs,
		now,
		randomBytes,
	});

	const background = createBackground({
		logger: logger.child({ component: 'background' }),
		mode: backgroundOptions.mode ?? (config.env === 'test' ? 'off' : 'on'),
		...(backgroundOptions.fallback ? { fallback: backgroundOptions.fallback } : {}),
		// a product calling the Portal is a natural moment to retry its own pending work (due event deliveries)
		onProductCall: async (appId) => composed.ports.productCalled?.(appId),
	});

	const infraRoutes = [
		defineRoute({
			method: 'GET',
			path: '/v1/admin/operations',
			auth: 'staff',
			permission: 'platform.jobs.read',
			handler: async () => ok({ items: await shared.operationRuns.latest() }),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/operations/:name',
			auth: 'staff',
			permission: 'platform.jobs.manage',
			idempotent: false,
			handler: async (ctx) => {
				const body = /** @type {Record<string, unknown> | undefined} */ (ctx.body);
				const after = typeof body?.after === 'string' && body.after.length <= 512 ? body.after : undefined;
				const result = await operationRunner.run(String(ctx.params.name), {
					trigger: `staff:${ctx.actor?.id ?? 'unknown'}`,
					input: after === undefined ? {} : { after },
				});
				if (!result) return problem('not_found', `No operation named ${ctx.params.name}.`);
				if (result.status === 'failed') return problem('internal_error', `Operation run ${result.id} failed.`);
				return ok(result);
			},
		}),
	];

	const api = createApiHandler({
		routes: [...infraRoutes, ...composed.routes],
		problems,
		logger,
		authenticators: createAuthenticators({
			sessions,
			cookieSecure: config.cookieSecure,
			verifyWebsiteKey,
			portalUrl: config.portalUrl,
			replayStore,
			ports: composed.ports,
			now,
		}),
		can,
		idempotency: createIdempotencyStore(repos.mutable(COLLECTIONS.idempotency), { now }),
		idempotencySecret: config.idempotencySecret,
		rateLimits: createRateLimitStore(repos.mutable(COLLECTIONS.rateLimits)),
		portalOrigin: config.portalOrigin,
		now,
		randomBytes,
		maxBodyBytes: config.maxBodyBytes,
		trustProxyHeaders: config.trustProxyHeaders,
		afterResponse: background.afterResponse,
	});
	// a dedicated preview origin (`PREVIEW_URL`, F.16) serves the preview proxy and nothing else: no API, no
	// console, no delivery artefacts — the delivery module in turn refuses `/p/*` on the Portal host
	const previewHost = config.delivery?.previewOrigin ? new URL(config.delivery.previewOrigin).host : null;
	/** @param {Request} request */
	const handle = (request) => {
		if (previewHost !== null) {
			const url = new URL(request.url);
			if (url.host === previewHost && !url.pathname.startsWith('/p/'))
				return Promise.resolve(
					new Response(
						JSON.stringify(problems.create('not_found', { detail: 'The preview origin serves previews only.' })),
						{
							status: 404,
							headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
						},
					),
				);
		}
		return api(request);
	};

	return Object.freeze({
		config,
		registry,
		shared,
		modules: composed,
		/** On-demand admin operations (`run(name, { input })`), also reachable at `POST /v1/admin/operations/:name`. */
		operations: operationRunner,
		/** Work right after responses (`on`, or `off` in tests). */
		background: Object.freeze({ mode: background.mode }),
		handle,
		/** Published JWKS: Portal keys (current + previous) and website-key signing keys. */
		jwks: () =>
			new Response(JSON.stringify(keys.publishedJwks()), {
				status: 200,
				headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300, stale-while-revalidate=60' },
			}),
		/** Readiness: the control-plane database answers a ping within `pingTimeoutMs`. */
		readyz: async () => {
			/** @type {'ok' | 'down'} */
			let database = 'ok';
			/** @type {ReturnType<typeof setTimeout> | undefined} */
			let timer;
			try {
				await Promise.race([
					db.command({ ping: 1 }),
					new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error('timeout')), pingTimeoutMs);
					}),
				]);
			} catch (error) {
				database = 'down';
				logger.warn('readiness check failed', { error });
			} finally {
				clearTimeout(timer);
			}
			const ready = database === 'ok';
			return new Response(
				JSON.stringify({ status: ready ? 'ready' : 'unavailable', version: config.version, checks: { database } }),
				{
					status: ready ? 200 : 503,
					headers: {
						'content-type': 'application/json',
						'cache-control': 'no-store',
						...(ready ? {} : { 'retry-after': '10' }),
					},
				},
			);
		},
		/** @param {{ dryRun?: boolean }} [options] */
		ensureIndexes: ({ dryRun = false } = {}) => ensureIndexes(db, registry, { dryRun, logger }),
		/** @param {{ dryRun?: boolean }} [options] */
		migrate: ({ dryRun = false } = {}) =>
			runMigrations({
				db,
				applied: repos.appendOnly(COLLECTIONS.migrations),
				locks,
				migrations: composed.migrations(),
				logger,
				now,
				dryRun,
			}),
	});
};
/** @typedef {ReturnType<typeof createPortal>} Portal */
