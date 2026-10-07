/**
 * Process-wide product and request handler (created lazily on first request, reused across invocations). Kept on
 * `globalThis`: Next.js bundles route handlers and pages separately, and they must share one product (its in-memory
 * development stores hold the dashboard sessions created by `/sso`).
 */
import { after } from 'next/server.js';
import { createRequestHandler, toNextRoute, startupFailedResponse } from '@ss/app-kit';
import { createPlatform } from '../../adapters/platform.js';
import { assets } from './assets.js';
import { buildRoutes, createDeals, wireEvents } from '../../api/routes.js';

const KEY = Symbol.for('ss.products.deals');

/**
 * @returns {{ deals?: Promise<import('../../api/routes.js').Deals>,
 *   next?: Promise<Record<string, (request: Request, context?: unknown) => Promise<Response>>> }}
 */
const shared = () => {
	const store = /** @type {any} */ (globalThis);
	return (store[KEY] ??= {});
};

export const getDeals = () => (shared().deals ??= createPlatform({ assets }).then((app) => wireEvents(createDeals(app))));

/**
 * A Next.js route export that forwards to the app-kit router (which strips the `/api` prefix of rewritten paths).
 * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'} method
 */
export const forward = (method) => async (/** @type {Request} */ request, /** @type {unknown} */ context) => {
	const state = shared();
	state.next ??= getDeals().then((instance) =>
		toNextRoute(createRequestHandler(instance.product, buildRoutes(instance)), { after }),
	);
	/** @type {Record<string, (request: Request, context?: unknown) => Promise<Response>>} */
	let handlers;
	try {
		handlers = await state.next;
	} catch (error) {
		// a failed start (database unreachable, …) is retried on the next request and reported instead of a blank 500
		state.next = undefined;
		return startupFailedResponse(error);
	}
	return /** @type {any} */ (handlers[method])(request, context);
};
