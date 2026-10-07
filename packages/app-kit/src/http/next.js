/**
 * Next.js App Router adapter: `export const { GET, POST, PATCH, DELETE } = toNextRoute(handler)` in a catch-all
 * `route.js`. A leading `/api` is stripped so routes are declared as `/v1/...` whether Next serves them under
 * `/api/v1/...` (e.g. through a `/v1/:path*` → `/api/v1/:path*` rewrite) or directly. Pass Next's `after` (`import { after } from 'next/server.js'`) so the usage and
 * events a request queued (and its website's due retries) are sent after the response.
 * @module
 */
import { rememberScheduler } from './handler.js';

/**
 * @param {Request} request
 * @param {string} prefix
 * @returns {Request}
 */
const stripPrefix = (request, prefix) => {
	const url = new URL(request.url);
	if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return request;
	url.pathname = url.pathname.slice(prefix.length) || '/';
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
	return new Request(url, {
		method: request.method,
		headers: request.headers,
		...(hasBody ? { body: request.body, duplex: 'half' } : {}),
		redirect: request.redirect,
		signal: request.signal,
	});
};

/**
 * @param {(request: Request) => Promise<Response>} handler
 * @param {{ stripPrefix?: string | false, after?: (task: () => Promise<unknown>) => void }} [options] default strips
 *   `/api`; `after` = the framework's post-response scheduler (Next.js `after`)
 * @returns {Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS', (request: Request, context?: unknown) => Promise<Response>>}
 */
export const toNextRoute = (handler, { stripPrefix: prefix = '/api', after } = {}) => {
	/** @param {Request} request */
	const route = (request) => {
		const target = prefix ? stripPrefix(request, prefix) : request;
		if (typeof after === 'function') rememberScheduler(target, after);
		return handler(target);
	};
	return Object.freeze({ GET: route, POST: route, PUT: route, PATCH: route, DELETE: route, HEAD: route, OPTIONS: route });
};
