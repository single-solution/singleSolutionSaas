/**
 * Composition root: builds the Portal from a validated config, a control-plane `Db` and the module list. Pure
 * wiring — no I/O happens here (the Mongo driver connects on first use), so building is cheap and testable.
 *
 * The returned object is what the Next.js adapters in `app/` call:
 * - `handle(request)` — the Portal API (`/v1/*` for modules, `/cron/:job` for cron triggers)
 * - `jwks()` — the published JWKS (Portal keys and website-key signing keys, distinct kids)
 * - `readyz()` — dependency check
 * - `ensureIndexes()`, `migrate()` — operational entry points (scripts, deploy pipeline)
 * @module
 */
import { createProblemFactory } from '@ss/contracts';
import { createAudit } from './infra/audit.js';
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
import { createCronRunner, createCronRuns, createJobs } from './infra/jobs.js';
import { composeModules, moduleProblems } from './infra/modules.js';
import { can, websitesVisible } from './infra/rbac.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from './infra/schema.js';
import { createIdempotencyStore, createRateLimitStore, createReplayStore } from './infra/stores.js';
import { defaultRandomBytes } from './infra/util.js';

/** @typedef {import('./infra/config.js').PortalConfig} PortalConfig */

/** Built-in cron that verifies the audit hash chains (scheduled nightly in `vercel.json`). */
export const AUDIT_VERIFY_CRON = 'audit_verify';
/** Built-in job doing the same verification on demand. */
export const AUDIT_VERIFY_JOB = 'audit.verify';
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
 *   pingTimeoutMs?: number, mailer?: import('./infra/mailer.js').Mailer }} options
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
		// the runner is built after the modules (it needs their crons); names are read when asked
		cronRuns: createCronRuns({ runs: repos.appendOnly(COLLECTIONS.cronRuns), names: () => cron.names() }),
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

	if (Object.hasOwn(composed.jobs, AUDIT_VERIFY_JOB)) throw new TypeError(`job ${AUDIT_VERIFY_JOB} is reserved`);
	for (const name of ['drain', AUDIT_VERIFY_CRON])
		if (Object.hasOwn(composed.crons, name)) throw new TypeError(`cron ${name} is reserved`);
	/** @type {Record<string, import('./infra/jobs.js').JobHandler>} */
	const jobHandlers = {
		...composed.jobs,
		// built-in: the same verification on demand (`jobs.enqueue({ name: 'audit.verify' })`)
		[AUDIT_VERIFY_JOB]: async (_payload, { deadline, signal }) => audit.verifyAll({ deadline, signal }),
	};

	const cron = createCronRunner({
		crons: {
			// built-in: drain the job queue within the cron time budget
			drain: async ({ deadline }) =>
				jobs.runBatch({ handlers: jobHandlers, deadlineMs: Math.max(0, deadline - now()), owner: 'cron:drain' }),
			// built-in: recompute every audit hash chain (nightly)
			[AUDIT_VERIFY_CRON]: async ({ deadline, signal }) => audit.verifyAll({ deadline, signal }),
			...composed.crons,
		},
		locks,
		runs: repos.appendOnly(COLLECTIONS.cronRuns),
		logger: logger.child({ component: 'cron' }),
		deadlineMs: config.cronDeadlineMs,
		now,
		randomBytes,
	});

	/** @param {import('./infra/http.js').RequestContext} ctx */
	const cronRoute = async (ctx) => {
		const result = await cron.run(String(ctx.params.job), { trigger: ctx.method === 'GET' ? 'cron' : 'manual' });
		if (!result) return problem('not_found', `No cron job named ${ctx.params.job}.`);
		if (result.status === 'failed') return problem('internal_error', `Cron run ${result.id} failed.`);
		return ok(result);
	};

	const infraRoutes = [
		defineRoute({ method: 'GET', path: '/cron/:job', auth: 'cron', handler: cronRoute }),
		defineRoute({ method: 'POST', path: '/cron/:job', auth: 'cron', idempotent: false, handler: cronRoute }),
	];

	const handle = createApiHandler({
		routes: [...infraRoutes, ...composed.routes],
		problems,
		logger,
		authenticators: createAuthenticators({
			sessions,
			cookieSecure: config.cookieSecure,
			verifyWebsiteKey,
			portalUrl: config.portalUrl,
			replayStore,
			cronSecret: config.cronSecret,
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
	});

	return Object.freeze({
		config,
		registry,
		shared,
		modules: composed,
		cron,
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
