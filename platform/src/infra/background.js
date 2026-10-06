/**
 * Work after responses (PLAN F.19, free-tier hosting: one daily cron, no always-on process).
 *
 * - **Deferred tasks**: a route calls `ctx.defer(task)` (e.g. the Event Hub delivers what an ingest just enqueued).
 * - **Throttled tasks**: `every(name, intervalMs, fn, { budgetMs })` registers work that runs after any request at most
 *   once per `intervalMs` across all instances: an in-memory check skips the database on most requests, then a lease
 *   lock (`locks.acquire('every:<name>', { ttlMs: intervalMs })`, never released, so it expires by itself) lets one
 *   instance run it. `fn` gets a `deadline` (`budgetMs`) and must stay well under the function limit.
 *
 * Everything runs through the framework's `after()` when the adapter provided one (`toNextRoute(handler, { after })`),
 * otherwise through `fallback` (default: in the background of the request). Failures are logged, never thrown. Mode
 * `off` (the default in tests) runs nothing; tests drive tasks with `trigger()`.
 * @module
 */

/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./db.js').Locks} Locks */
/** @typedef {import('./http.js').AfterResponse} AfterResponse */
/** @typedef {import('./http.js').AfterScheduler} AfterScheduler */

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * @param {{ locks: Pick<Locks, 'acquire'>, logger: Logger, now?: () => number, mode?: 'on' | 'off',
 *   fallback?: AfterScheduler }} options
 */
export const createBackground = ({ locks, logger, now = Date.now, mode = 'on', fallback }) => {
	/** @type {AfterScheduler} */
	const background = fallback ?? ((task) => void task());
	/** @type {Array<{ name: string, intervalMs: number, run: () => Promise<boolean> }>} */
	const tasks = [];
	/** @type {Map<string, number>} last attempt per task on this instance */
	const attempted = new Map();

	/**
	 * @param {string} name
	 * @param {number} intervalMs
	 * @param {(input: { deadline: number }) => Promise<unknown>} fn
	 * @param {{ budgetMs?: number }} [options]
	 */
	const every = (name, intervalMs, fn, { budgetMs = 5_000 } = {}) => {
		if (!NAME.test(name)) throw new TypeError(`invalid background task name: ${name}`);
		if (tasks.some((task) => task.name === name)) throw new TypeError(`background task ${name} is registered twice`);
		if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new RangeError('background intervalMs must be ≥ 1000');
		const run = async () => {
			const t = now();
			const last = attempted.get(name);
			if (last !== undefined && t - last < intervalMs) return false;
			attempted.set(name, t);
			try {
				if (!(await locks.acquire(`every:${name}`, { ttlMs: intervalMs, owner: 'background' }))) return false;
				await fn({ deadline: now() + budgetMs });
			} catch (error) {
				logger.warn('background task failed', { task: name, error });
			}
			return true;
		};
		tasks.push({ name, intervalMs, run });
		return Object.freeze({ name, trigger: run });
	};

	/**
	 * Schedule the request's deferred tasks and the due throttled tasks (the handler's `afterResponse` hook).
	 * @param {AfterResponse} input
	 */
	const afterResponse = ({ deferred, schedule, log }) => {
		if (mode === 'off') return;
		const t = now();
		const due = tasks.filter((task) => {
			const last = attempted.get(task.name);
			return last === undefined || t - last >= task.intervalMs;
		});
		if (deferred.length === 0 && due.length === 0) return;
		const work = async () => {
			for (const task of deferred) {
				try {
					await task();
				} catch (error) {
					log.warn('deferred task failed', { error });
				}
			}
			for (const task of due) await task.run();
		};
		if (schedule) {
			try {
				schedule(work);
				return;
			} catch {
				// outside a request scope: run it in the background instead
			}
		}
		background(work);
	};

	return Object.freeze({ mode, every, afterResponse });
};
/** @typedef {ReturnType<typeof createBackground>} Background */
