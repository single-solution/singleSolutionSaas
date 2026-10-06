/**
 * Delivery of the durable queues (usage, event outbox) on requests only (PLAN F.19: event-driven, no scheduled or
 * background processing — no timers, no polling, no periodic passes).
 *
 * After a request, the records that request (or any request on this instance since the last run) queued are sent, and
 * the request's own website gets its due retries sent: a send that failed earlier is retried by the next request of
 * this product for that website, never by a timer. The work is scheduled with the framework's `after()` when the
 * adapter provides one (`toNextRoute(handler, { after })` with Next.js `after`), otherwise it runs in the background of
 * the request (not awaited). Each run is bounded to one batch per website and queue.
 *
 * `mode: 'on'` (the default, `'auto'` is an alias) enables it; `mode: 'off'` (the default when `NODE_ENV=test`) leaves
 * sending to explicit `flush()` calls. Explicit `tick()` sends everything due (`product.flush()`, `heartbeat()`).
 * @module
 */

/** @typedef {'auto' | 'on' | 'off'} BackgroundMode */
/** @typedef {(task: () => Promise<unknown>) => void} AfterScheduler */
/**
 * @typedef {object} QueueTask
 * @property {string} name
 * @property {(options?: { websiteId?: string, maxBatches?: number }) => Promise<unknown>} run send due records
 *   (only the website's with `websiteId`)
 */

/** Websites remembered as "queued something" on this instance before the oldest are dropped. */
const PENDING_MEMORY = 1_000;

/**
 * @param {{ tasks: ReadonlyArray<QueueTask>, mode?: BackgroundMode, logger: import('./logger.js').Logger }} options
 */
export const createBackground = ({ tasks, mode = 'auto', logger }) => {
	if (mode !== 'auto' && mode !== 'on' && mode !== 'off') throw new TypeError(`invalid background mode: ${String(mode)}`);
	const resolved = mode === 'off' ? 'off' : 'on';
	/** @type {Set<string>} websites with records queued on this instance since the last run */
	const pending = new Set();
	/** @type {Promise<void> | null} */
	let running = null;

	/**
	 * Run every queue once (single-flight per instance for the unfiltered run; failures are logged, never thrown).
	 * @param {{ websiteId?: string, maxBatches?: number }} [options]
	 */
	const runAll = async (options) => {
		for (const task of tasks) {
			try {
				await task.run(options);
			} catch (error) {
				logger.warn('queue delivery failed', {
					task: task.name,
					...(options?.websiteId ? { websiteId: options.websiteId } : {}),
					error,
				});
			}
		}
	};

	/** Send everything due now (explicit calls: `product.flush()`, `heartbeat()`). */
	const tick = () => {
		if (running) return running;
		pending.clear();
		running = runAll().finally(() => {
			running = null;
		});
		return running;
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
	 * Called by the request handler after each request: send what was queued, and the request website's due retries.
	 * @param {AfterScheduler | null | undefined} schedule the framework's `after()` (if any)
	 * @param {{ websiteId?: string | null }} [request] what the request was about
	 */
	const afterRequest = (schedule, { websiteId = null } = {}) => {
		if (resolved === 'off') return;
		const websites = new Set(pending);
		pending.clear();
		if (websiteId) websites.add(websiteId);
		if (websites.size === 0) return;
		later(schedule, async () => {
			for (const id of websites) await runAll({ websiteId: id, maxBatches: 1 });
		});
	};

	return Object.freeze({
		mode: resolved,
		tick,
		afterRequest,
		/**
		 * Note that this instance queued something (usage, events) for a website: the next request's run sends it.
		 * @param {string} websiteId
		 */
		markDirty: (websiteId) => {
			if (resolved === 'off' || typeof websiteId !== 'string') return;
			pending.add(websiteId);
			if (pending.size > PENDING_MEMORY) pending.delete(/** @type {string} */ (pending.values().next().value));
		},
	});
};
