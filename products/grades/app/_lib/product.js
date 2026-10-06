/**
 * Process-wide product and request handler (created lazily on first request, reused across invocations). Kept on
 * `globalThis`: Next.js bundles route handlers and pages separately, and they must share one product (its in-memory
 * development stores hold the dashboard sessions created by `/sso`).
 */
import { after } from 'next/server.js';
import { createRequestHandler, toNextRoute } from '@ss/app-kit';
import { createPlatform } from '../../adapters/platform.js';
import { buildRoutes, createGrades, wireEvents } from '../../api/routes.js';

const KEY = Symbol.for('ss.products.grades');

/**
 * @returns {{ grades?: Promise<import('../../api/routes.js').Grades>,
 *   next?: Promise<Record<string, (request: Request, context?: unknown) => Promise<Response>>> }}
 */
const shared = () => {
	const store = /** @type {any} */ (globalThis);
	return (store[KEY] ??= {});
};

export const getGrades = () => (shared().grades ??= createPlatform().then((app) => wireEvents(createGrades(app))));

/**
 * A Next.js route export that forwards to the app-kit router (which strips the `/api` prefix of rewritten paths).
 * Every route file also exports `OPTIONS` so browsers' CORS preflights reach app-kit; `after` lets app-kit finish
 * work (event outbox, usage) after the response is sent.
 * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'} method
 */
export const forward = (method) => async (/** @type {Request} */ request, /** @type {unknown} */ context) => {
	const state = shared();
	state.next ??= getGrades().then((instance) =>
		toNextRoute(createRequestHandler(instance.product, buildRoutes(instance)), { after }),
	);
	return /** @type {any} */ ((await state.next)[method])(request, context);
};
