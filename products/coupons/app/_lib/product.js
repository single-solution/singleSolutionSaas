/**
 * Process-wide product and request handler (created lazily on first request, reused across invocations). Kept on
 * `globalThis`: Next.js bundles route handlers and pages separately, and they must share one product (its in-memory
 * development stores hold the dashboard sessions created by `/sso`).
 */
import { createRequestHandler, toNextRoute } from '@ss/app-kit';
import { createPlatform } from '../../adapters/platform.js';
import { buildRoutes, createCoupons, wireEvents } from '../../api/routes.js';
import { cronRoutes } from '../../jobs/sweep.js';

const KEY = Symbol.for('ss.products.coupons');

/**
 * @returns {{ coupons?: Promise<import('../../api/routes.js').Coupons>,
 *   next?: Promise<Record<string, (request: Request, context?: unknown) => Promise<Response>>> }}
 */
const shared = () => {
	const store = /** @type {any} */ (globalThis);
	return (store[KEY] ??= {});
};

export const getCoupons = () => (shared().coupons ??= createPlatform().then((app) => wireEvents(createCoupons(app))));

/**
 * A Next.js route export that forwards to the app-kit router (which strips the `/api` prefix of rewritten paths).
 * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method
 */
export const forward = (method) => async (/** @type {Request} */ request, /** @type {unknown} */ context) => {
	const state = shared();
	state.next ??= getCoupons().then((instance) =>
		toNextRoute(createRequestHandler(instance.product, [...buildRoutes(instance), ...cronRoutes(instance)])),
	);
	return /** @type {any} */ ((await state.next)[method])(request, context);
};
