/**
 * Process-wide product and request handler (created lazily on first request, reused across invocations).
 */
import { createRequestHandler, toNextRoute } from '@ss/app-kit';
import { createPlatform, loadStrings } from '../../adapters/platform.js';
import { buildRoutes, wireEvents } from '../../api/routes.js';

/** @type {Promise<any> | undefined} */
let product;
/** @type {Promise<Record<string, (request: Request, context?: unknown) => Promise<Response>>> | undefined} */
let next;
/** @type {Promise<Record<string, Record<string, string>>> | undefined} */
let strings;

export const getProduct = () => (product ??= createPlatform().then(wireEvents));
export const getStrings = () => (strings ??= loadStrings(process.cwd()));

/**
 * A Next.js route export that forwards to the app-kit router (which strips the `/api` prefix of rewritten paths).
 * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method
 */
export const forward = (method) => async (/** @type {Request} */ request, /** @type {unknown} */ context) => {
	next ??= getProduct().then((instance) => toNextRoute(createRequestHandler(instance, buildRoutes(instance))));
	return /** @type {any} */ ((await next)[method])(request, context);
};
