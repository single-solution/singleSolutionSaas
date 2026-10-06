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
import { createCronRunner, createCronRuns, createJobs } from './infra/jobs.js';
import { composeModules, moduleProblems } from './infra/modules.js';
import { can, websitesVisible } from './infra/rbac.js';
import { COLLECTIONS, INFRA_COLLECTIONS } from './infra/schema.js';
import { createIdempotencyStore, createRateLimitStore, createReplayStore } from './infra/stores.js';
import { defaultRandomBytes } from './infra/util.js';

/** @typedef {import('./infra/config.js').PortalConfig} PortalConfig */

/** Built-in cron that verifies the audit hash chains (a step of the daily cron). */
export const AUDIT_VERIFY_CRON = 'audit_verify';
/** Built-in job doing the same verification on demand (and continuing a pass that hit its deadline). */
export const AUDIT_VERIFY_JOB = 'audit.verify';
/** The one scheduled cron (`vercel.json`, Vercel Hobby: daily): runs {@link DAILY_STEPS} in order (F.19). */
export const DAILY_CRON = 'daily';
/**
 * The daily cron's steps, in order, with their share of its time budget. A step may use all the time the later
 * steps do not reserve (their shares), so an early finish leaves more to the rest; every step resumes where it
 * stopped on the next run (cursors, the job queue, continuation jobs).
 */
export const DAILY_STEPS = Object.freeze([
	{ cron: 'settlement', share: 0.2 },
	{ cron: 'drain', share: 0.16 },
	{ cron: 'connectors-health', share: 0.3 },
	{ cron: 'reconciliation', share: 0.12 },
	{ cron: 'catalog_refresh', share: 0.12 },
	{ cron: AUDIT_VERIFY_CRON, share: 0.1 },
]);
/** Opportunistic drain after requests: at most once per interval across instances, a few jobs, a short budget. */
export const REQUEST_DRAIN = Object.freeze({ intervalMs: 15_000, budgetMs: 8_000, maxJobs: 10 });
/** The deliveries an ingest enqueued are attempted right after the response, within this budget. */
export const IMMEDIATE_DELIVERY_BUDGET_MS = 8_000;
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
	for (const name of ['drain', AUDIT_VERIFY_CRON, DAILY_CRON])
		if (Object.hasOwn(composed.crons, name)) throw new TypeError(`cron ${name} is reserved`);

	/**
	 * Verify the audit chains from `after` on; a pass cut by its deadline continues in a `daily` job from the first
	 * scope it skipped (the next daily drain runs it).
	 * @param {{ deadline: number, signal?: AbortSignal, after?: string | null }} input
	 */
	const verifyAudit = async ({ deadline, signal, after = null }) => {
		const report = await audit.verifyAll({ deadline, ...(signal ? { signal } : {}), after });
		if (report.resumeAfter !== null) {
			const day = new Date(now()).toISOString().slice(0, 10);
			await jobs.enqueue({
				name: AUDIT_VERIFY_JOB,
				key: `${AUDIT_VERIFY_JOB}:${day}:${report.resumeAfter}`,
				payload: { after: report.resumeAfter },
				maxAttempts: 3,
				daily: true,
			});
		}
		return report;
	};

	/** @type {Record<string, import('./infra/jobs.js').JobHandler>} */
	const jobHandlers = {
		...composed.jobs,
		// built-in: the same verification on demand (`jobs.enqueue({ name: 'audit.verify' })`), or its continuation
		[AUDIT_VERIFY_JOB]: async (payload, { deadline, signal }) =>
			verifyAudit({ deadline, signal, after: typeof payload?.after === 'string' ? payload.after : null }),
	};

	/** @type {Record<string, import('./infra/jobs.js').CronHandler>} */
	const crons = {
		// built-in: drain the job queue within the cron time budget
		drain: async ({ deadline }) =>
			jobs.runBatch({ handlers: jobHandlers, deadlineMs: Math.max(0, deadline - now()), owner: 'cron:drain' }),
		// built-in: recompute every audit hash chain
		[AUDIT_VERIFY_CRON]: async ({ deadline, signal }) => verifyAudit({ deadline, signal }),
		...composed.crons,
	};
	/**
	 * Built-in: the daily cron (the only one `vercel.json` schedules). Each step gets the time the later steps do not
	 * reserve; a failing step is recorded and the next one runs.
	 * @type {import('./infra/jobs.js').CronHandler}
	 */
	const daily = async ({ deadline, signal, logger: log, trigger }) => {
		const total = Math.max(0, deadline - now());
		const steps = DAILY_STEPS.filter((step) => Object.hasOwn(crons, step.cron));
		/** @type {Record<string, unknown>} */
		const stats = {};
		for (const [index, step] of steps.entries()) {
			const reserved = steps.slice(index + 1).reduce((sum, later) => sum + later.share * total, 0);
			const stepDeadline = Math.floor(deadline - reserved);
			if (signal.aborted || stepDeadline <= now()) {
				stats[step.cron] = { skipped: true };
				continue;
			}
			try {
				const handler = /** @type {import('./infra/jobs.js').CronHandler} */ (crons[step.cron]);
				stats[step.cron] =
					(await handler({ deadline: stepDeadline, signal, logger: log.child({ step: step.cron }), trigger })) ?? {};
			} catch (error) {
				log.error('daily cron step failed', { step: step.cron, error });
				stats[step.cron] = { failed: true };
			}
		}
		return stats;
	};

	const cron = createCronRunner({
		crons: { ...crons, [DAILY_CRON]: daily },
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

	const background = createBackground({
		locks,
		logger: logger.child({ component: 'background' }),
		now,
		mode: backgroundOptions.mode ?? (config.env === 'test' ? 'off' : 'on'),
		...(backgroundOptions.fallback ? { fallback: backgroundOptions.fallback } : {}),
	});
	// built-in: a short, bounded drain after requests (deliveries, mails, retries); `daily` jobs wait for the cron
	const requestDrain = background.every(
		'drain',
		REQUEST_DRAIN.intervalMs,
		async ({ deadline }) =>
			jobs.runBatch({
				handlers: jobHandlers,
				deadlineMs: Math.max(0, deadline - now()),
				owner: 'request:drain',
				maxJobs: REQUEST_DRAIN.maxJobs,
				skipDaily: true,
				safetyMs: 1_000,
			}),
		{ budgetMs: REQUEST_DRAIN.budgetMs },
	);
	const moduleTasks = Object.fromEntries(
		Object.entries(composed.background).map(([name, task]) => [
			name,
			background.every(name, task.intervalMs, task.run, task.budgetMs ? { budgetMs: task.budgetMs } : {}),
		]),
	);

	const infraRoutes = [
		defineRoute({ method: 'GET', path: '/cron/:job', auth: 'cron', handler: cronRoute }),
		defineRoute({ method: 'POST', path: '/cron/:job', auth: 'cron', idempotent: false, handler: cronRoute }),
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
		afterResponse: background.afterResponse,
	});
	// a dedicated preview origin (`PREVIEW_ORIGIN`, F.16) serves the preview proxy and nothing else: no API, no
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
		cron,
		/** Work after responses: `tasks.drain` and the modules' tasks can be triggered directly (tests, operations). */
		background: Object.freeze({ mode: background.mode, tasks: Object.freeze({ drain: requestDrain, ...moduleTasks }) }),
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
