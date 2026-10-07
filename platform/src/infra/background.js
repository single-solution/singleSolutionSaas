/**
 * Work right after a response, for that request only (PLAN F.19: event-driven only — no crons, no timers, no
 * throttled passes, no polling).
 *
 * - **Deferred tasks**: whatever the request deferred (`ctx.defer(task)`, or `afterResponse(task)` from
 *   `request-scope.js` deep in a module: the notices and e-mails it caused). Tasks deferred while these run are run
 *   too.
 * - **Product calls**: when a product called the Portal (`product` auth), `onProductCall(productId)` follows the
 *   request (the product's failed notices are retried, oldest first).
 *
 * Everything runs through the framework's `after()` when the adapter provided one (`toNextRoute(handler, { after })`),
 * otherwise through `fallback` (default: in the background of the request). Failures are logged, never thrown. Mode
 * `off` (the default in tests) runs nothing: the work waits for the next request that touches it.
 * @module
 */
import { runInRequestScope } from './request-scope.js';

/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./http.js').AfterResponse} AfterResponse */
/** @typedef {import('./http.js').AfterScheduler} AfterScheduler */

/** At most this many tasks run after one request (a task deferring tasks cannot loop forever). */
export const MAX_TASKS_PER_REQUEST = 200;

/**
 * @param {{ logger: Logger, mode?: 'on' | 'off', fallback?: AfterScheduler,
 *   onProductCall?: (productId: string) => Promise<unknown> }} options
 */
export const createBackground = ({ logger, mode = 'on', fallback, onProductCall }) => {
	/** @type {AfterScheduler} */
	const background = fallback ?? ((task) => void task());

	/**
	 * Schedule the request's deferred tasks (the handler's `afterResponse` hook).
	 * @param {AfterResponse} input
	 */
	const afterResponse = ({ deferred, schedule, log, product }) => {
		if (mode === 'off') return;
		if (product && onProductCall) deferred.push(() => onProductCall(product.productId));
		if (deferred.length === 0) return;
		const work = () =>
			runInRequestScope({ defer: (task) => void deferred.push(task) }, async () => {
				for (let index = 0; index < deferred.length && index < MAX_TASKS_PER_REQUEST; index += 1) {
					try {
						await /** @type {() => Promise<unknown>} */ (deferred[index])();
					} catch (error) {
						log.warn('deferred task failed', { error });
					}
				}
				if (deferred.length > MAX_TASKS_PER_REQUEST)
					logger.warn('deferred tasks dropped', { dropped: deferred.length - MAX_TASKS_PER_REQUEST });
			});
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

	return Object.freeze({ mode, afterResponse });
};
/** @typedef {ReturnType<typeof createBackground>} Background */
