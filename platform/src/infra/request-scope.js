/**
 * The request a piece of work belongs to (PLAN F.19: event-driven only). The HTTP handler runs every request inside a
 * scope; code deep in a module can then hand work to the end of *that* request with {@link afterResponse} — e.g. the
 * job queue runs the job a request just enqueued, the Event Hub delivers the event a request just ingested — without
 * threading `ctx.defer` through every call. Outside a request (scripts, tests calling services directly) nothing is
 * deferred and the work simply waits for the next request that touches it or an admin operation.
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {{ defer: (task: () => Promise<unknown>) => void }} RequestScope */

/** @type {AsyncLocalStorage<RequestScope>} */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` inside a request scope.
 * @template T
 * @param {RequestScope} scope
 * @param {() => T} fn
 * @returns {T}
 */
export const runInRequestScope = (scope, fn) => storage.run(scope, fn);

/**
 * Run `task` after the current request's response (failures are logged by the handler, never seen by the client).
 * @param {() => Promise<unknown>} task
 * @returns {boolean} false outside a request (nothing was scheduled)
 */
export const afterResponse = (task) => {
	const scope = storage.getStore();
	if (!scope) return false;
	scope.defer(task);
	return true;
};
