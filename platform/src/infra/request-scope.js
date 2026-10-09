/**
 * The request a piece of work belongs to (PLAN 0.10: event-driven only). The HTTP handler runs every request inside a
 * scope; code deep in a module can then hand work to the end of *that* request with {@link afterResponse} — e.g. the
 * notices a change causes, the e-mails a request sends — without threading `ctx.defer` through every call. Outside a
 * request (scripts, tests calling services directly) nothing is deferred and callers do the work at once.
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `memo`: values shared by the requests of one page render (the console's in-process reads, `memoize`); absent for
 * every other request.
 * @typedef {{ defer: (task: () => Promise<unknown>) => void, memo?: Map<string, unknown> | null }} RequestScope
 */

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

/**
 * The value of `compute()` once per page render: the in-process reads of one console page share it (the session of
 * the signed-in person, the check of a merchant). Any other request computes it every time.
 * @template T
 * @param {string} key
 * @param {() => T} compute
 * @returns {T}
 */
export const memoize = (key, compute) => {
	const memo = storage.getStore()?.memo;
	if (!memo) return compute();
	if (!memo.has(key)) memo.set(key, compute());
	return /** @type {T} */ (memo.get(key));
};
