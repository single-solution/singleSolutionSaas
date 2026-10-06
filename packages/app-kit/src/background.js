/**
 * Background delivery of the durable queues (usage, event outbox) without a product-side cron:
 *
 * - **long-lived server** (`mode: 'server'`): a timer (unref'd, so it never keeps the process alive) flushes every
 *   `intervalMs`; it starts with the first request (or `start()`), and `stop()` / `product.close()` clear it;
 * - **serverless** (`mode: 'serverless'`): flushes run opportunistically after requests — through the framework's
 *   `after()` when the adapter provides one (`toNextRoute(handler, { after })` with Next.js `after`), otherwise in the
 *   background of the request (not awaited) — when this instance queued something since the last flush, or on every
 *   `everyRequests`-th request; `product.heartbeat()` flushes too;
 * - `mode: 'auto'` (default) picks serverless when a serverless platform is detected from the environment (`VERCEL`,
 *   `AWS_LAMBDA_FUNCTION_NAME`, `NETLIFY`, `FUNCTION_TARGET`, `FUNCTIONS_WORKER_RUNTIME`), else server;
 *   `mode: 'off'` (the default when `NODE_ENV=test`) leaves flushing to explicit `flush()` calls.
 *
 * Runs are single-flight per instance; leases in the stores keep instances from sending the same records twice.
 *
 * **Throttled work after requests** (`every(name, intervalMs, fn, { per })`): the free-tier hosting model (PLAN F.19)
 * has one daily cron per deployment, so anything that must happen sooner runs after ordinary requests instead. A task
 * runs at most once per `intervalMs` per product (`per: 'product'`) or per website (`per: 'website'`, only after
 * requests that carry a website): an in-memory check skips the store on most requests, then a lease in the control
 * store (`leases.acquire`) lets exactly one instance run it per interval. The run is scheduled with the framework's
 * `after()` when available, gets a `deadline` (`budgetMs`, default 10 s) and never fails the request. It is active in
 * the `server` and `serverless` modes; `trigger()` runs it directly (tests, the daily cron).
 * @module
 */

/** @typedef {'auto' | 'server' | 'serverless' | 'off'} BackgroundMode */
/** @typedef {(task: () => Promise<unknown>) => void} AfterScheduler */
/** @typedef {{ websiteId: string | null, deadline: number }} EveryContext */
/**
 * @typedef {object} EveryTask
 * @property {string} name
 * @property {(input?: { websiteId?: string | null }) => Promise<boolean>} trigger run now unless throttled or leased
 *   elsewhere; resolves true when `fn` ran (its errors are logged, never thrown)
 */

const EVERY_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
/** In-memory throttle entries kept per instance before the oldest are dropped. */
const EVERY_MEMORY = 2_000;

const SERVERLESS_ENV = Object.freeze([
	'VERCEL',
	'AWS_LAMBDA_FUNCTION_NAME',
	'NETLIFY',
	'FUNCTION_TARGET',
	'FUNCTIONS_WORKER_RUNTIME',
]);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {'server' | 'serverless'}
 */
export const detectRuntime = (env) => (SERVERLESS_ENV.some((name) => env[name]) ? 'serverless' : 'server');

/**
 * @param {{
 *   tasks: ReadonlyArray<{ name: string, run: () => Promise<unknown> }>,
 *   mode?: BackgroundMode,
 *   env?: Record<string, string | undefined>,
 *   intervalMs?: number,
 *   everyRequests?: number,
 *   logger: import('./logger.js').Logger,
 *   leases?: import('./stores/types.js').LeaseStore | null,
 *   now?: () => number,
 *   setInterval?: (fn: () => void, ms: number) => unknown,
 *   clearInterval?: (handle: any) => void,
 * }} options
 */
export const createBackground = ({
	tasks,
	mode = 'auto',
	env = process.env,
	intervalMs = 30_000,
	everyRequests = 20,
	logger,
	leases = null,
	now = Date.now,
	setInterval: startTimer = globalThis.setInterval,
	clearInterval: stopTimer = globalThis.clearInterval,
}) => {
	if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new RangeError('background intervalMs must be ≥ 1000');
	if (!Number.isInteger(everyRequests) || everyRequests < 1) throw new RangeError('background everyRequests must be ≥ 1');
	const resolved = mode === 'auto' ? detectRuntime(env) : mode;
	/** @type {unknown} */
	let timer = null;
	let dirty = false;
	let requests = 0;
	/** @type {Promise<void> | null} */
	let running = null;
	/** @type {Array<{ name: string, intervalMs: number, per: 'product' | 'website', run: (websiteId: string | null) => Promise<boolean> }>} */
	const periodic = [];
	/** @type {Map<string, number>} last attempt per throttle key on this instance */
	const attempted = new Map();

	/** Flush every queue once (single-flight; failures are logged, never thrown). */
	const tick = () => {
		if (running) return running;
		dirty = false;
		running = (async () => {
			for (const task of tasks) {
				try {
					await task.run();
				} catch (error) {
					logger.warn('background flush failed', { task: task.name, error });
				}
			}
		})().finally(() => {
			running = null;
		});
		return running;
	};

	const start = () => {
		if (resolved !== 'server' || timer !== null) return;
		timer = startTimer(() => {
			void tick();
		}, intervalMs);
		/** @type {any} */ (timer)?.unref?.();
	};

	const stop = () => {
		if (timer !== null) stopTimer(timer);
		timer = null;
	};

	/**
	 * Run `task` after the response (the framework's `after()`), else in the background of the request.
	 * @param {AfterScheduler | null | undefined} schedule
	 * @param {() => Promise<unknown>} task
	 */
	const later = (schedule, task) => {
		if (schedule) {
			try {
				schedule(task);
				return;
			} catch {
				// not inside a request scope: fall through to a background run
			}
		}
		void task();
	};

	/**
	 * Register throttled work that runs after requests (see the module comment).
	 * @param {string} name
	 * @param {number} taskIntervalMs at most one run per interval (≥ 1000)
	 * @param {(input: EveryContext) => Promise<unknown>} fn
	 * @param {{ per?: 'product' | 'website', budgetMs?: number }} [options]
	 * @returns {EveryTask}
	 */
	const every = (name, taskIntervalMs, fn, { per = 'product', budgetMs = 10_000 } = {}) => {
		if (!EVERY_NAME.test(name)) throw new TypeError(`invalid background task name: ${name}`);
		if (periodic.some((task) => task.name === name)) throw new TypeError(`background task ${name} is registered twice`);
		if (!Number.isInteger(taskIntervalMs) || taskIntervalMs < 1000)
			throw new RangeError('background task intervalMs must be ≥ 1000');
		if (per !== 'product' && per !== 'website') throw new TypeError('background task per must be product or website');
		/** @param {string | null} websiteId */
		const run = async (websiteId) => {
			if (per === 'website' && !websiteId) return false;
			const key = per === 'website' ? `every:${name}:${websiteId}` : `every:${name}`;
			const t = now();
			const last = attempted.get(key);
			if (last !== undefined && t - last < taskIntervalMs) return false;
			attempted.delete(key);
			attempted.set(key, t);
			if (attempted.size > EVERY_MEMORY) attempted.delete(/** @type {string} */ (attempted.keys().next().value));
			try {
				if (leases && !(await leases.acquire(key, taskIntervalMs))) return false;
				await fn({ websiteId: per === 'website' ? websiteId : null, deadline: now() + budgetMs });
			} catch (error) {
				logger.warn('background task failed', { task: name, ...(websiteId ? { websiteId } : {}), error });
			}
			return true;
		};
		periodic.push({ name, intervalMs: taskIntervalMs, per, run });
		return Object.freeze({ name, trigger: ({ websiteId = null } = {}) => run(websiteId) });
	};

	/**
	 * Called by the request handler after each request.
	 * @param {AfterScheduler | null | undefined} schedule the framework's `after()` (if any)
	 * @param {{ websiteId?: string | null }} [request] what the request was about
	 */
	const afterRequest = (schedule, { websiteId = null } = {}) => {
		if (resolved === 'off') return;
		const t = now();
		const due = periodic.filter((task) => {
			if (task.per === 'website' && !websiteId) return false;
			const last = attempted.get(task.per === 'website' ? `every:${task.name}:${websiteId}` : `every:${task.name}`);
			return last === undefined || t - last >= task.intervalMs;
		});
		if (due.length > 0)
			later(schedule, async () => {
				for (const task of due) await task.run(websiteId);
			});
		if (resolved === 'server') {
			start();
			return;
		}
		requests += 1;
		if (!dirty && requests % everyRequests !== 0) return;
		later(schedule, () => tick());
	};

	return Object.freeze({
		mode: resolved,
		tick,
		start,
		stop,
		afterRequest,
		every,
		/** Note that this instance queued something (usage, events) since the last flush. */
		markDirty: () => {
			dirty = true;
		},
	});
};
