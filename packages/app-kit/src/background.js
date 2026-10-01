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
 * @module
 */

/** @typedef {'auto' | 'server' | 'serverless' | 'off'} BackgroundMode */
/** @typedef {(task: () => Promise<unknown>) => void} AfterScheduler */

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
	 * Called by the request handler after each request.
	 * @param {AfterScheduler | null | undefined} schedule the framework's `after()` (if any)
	 */
	const afterRequest = (schedule) => {
		if (resolved === 'off') return;
		if (resolved === 'server') {
			start();
			return;
		}
		requests += 1;
		if (!dirty && requests % everyRequests !== 0) return;
		if (schedule) {
			try {
				schedule(() => tick());
				return;
			} catch {
				// not inside a request scope: fall through to a background run
			}
		}
		void tick();
	};

	return Object.freeze({
		mode: resolved,
		tick,
		start,
		stop,
		afterRequest,
		/** Note that this instance queued something (usage, events) since the last flush. */
		markDirty: () => {
			dirty = true;
		},
	});
};
