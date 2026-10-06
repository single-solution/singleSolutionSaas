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

/**
 * The Portal's address is the request's own origin (no stored Portal URL): `Host` plus the protocol
 * (`X-Forwarded-Proto` behind a proxy). It is the issuer and audience of Portal tokens, the base of the links the
 * Portal builds and the only origin the CSRF check accepts.
 * @type {AsyncLocalStorage<string>}
 */
const originStorage = new AsyncLocalStorage();
const HOST = /^(?:[a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/;

/**
 * Origin of a request from its headers (`host`, and `x-forwarded-proto` as the first hop set it: its last entry),
 * falling back to its URL.
 * @param {{ get: (name: string) => string | null }} headers
 * @param {string} url the request URL (or any URL whose origin is the fallback)
 * @returns {string}
 */
export const originFromHeaders = (headers, url) => {
	const fallback = new URL(url);
	const host = (headers.get('host') ?? '').trim().toLowerCase();
	const forwarded = (headers.get('x-forwarded-proto') ?? '').split(',').at(-1)?.trim().toLowerCase();
	const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : fallback.protocol.slice(0, -1);
	try {
		return new URL(`${proto}://${HOST.test(host) ? host : fallback.host}`).origin;
	} catch {
		return fallback.origin;
	}
};

/**
 * @param {Request} request
 * @returns {string}
 */
export const requestOrigin = (request) => originFromHeaders(request.headers, request.url);

/**
 * Run `fn` with `origin` as the Portal's address.
 * @template T
 * @param {string} origin
 * @param {() => T} fn
 * @returns {T}
 */
export const withOrigin = (origin, fn) => originStorage.run(origin, fn);

/** @returns {string | null} the current request's origin (null outside a request) */
export const currentOrigin = () => originStorage.getStore() ?? null;
