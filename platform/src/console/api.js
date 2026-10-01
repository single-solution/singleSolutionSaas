/**
 * Server-side API client of the consoles. Server components never reach module services directly: every read is
 * an HTTP call to the Portal's own handler (`portal.handle`), made **in-process** with the signed-in user's cookies,
 * so the console exercises exactly the public API (auth, RBAC, rate limits, problems) — "every UI action is an API
 * call". Results are plain `{ ok, status, data }` / `{ ok: false, status, problem }` objects (never thrown), so pages
 * can render friendly error states.
 *
 * Non-GET requests (the console only issues side-effect-free ones from the server, e.g. a configuration preview)
 * carry the Portal origin and `Sec-Fetch-Site: same-origin` — the request is made by the Portal on the user's
 * behalf, never forwarded from a browser.
 * @module
 */

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {{ ok: true, status: number, data: T } | { ok: false, status: number, problem: Problem }} ApiResult
 */

/**
 * @typedef {object} ConsoleApi
 * @property {<T = any>(method: string, path: string, body?: unknown) => Promise<ApiResult<T>>} request
 * @property {<T = any>(path: string) => Promise<ApiResult<T>>} get
 * @property {<T = any>(path: string, body?: unknown) => Promise<ApiResult<T>>} post
 */

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
const readJson = async (response) => {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

/**
 * @param {{ handle: (request: Request) => Promise<Response>, baseUrl: string, cookie?: string | null | (() => string | null),
 *   onSetCookie?: (setCookies: string[]) => void, forwardedFor?: string | null, userAgent?: string | null,
 *   randomUUID?: () => string }} options `cookie` is the request's Cookie header (or a getter, for a client that
 *   follows `Set-Cookie` through `onSetCookie`, e.g. tests and scripts).
 * @returns {ConsoleApi}
 */
export const createConsoleApi = ({
	handle,
	baseUrl,
	cookie = null,
	onSetCookie,
	forwardedFor = null,
	userAgent = null,
	randomUUID = () => globalThis.crypto.randomUUID(),
}) => {
	const origin = new URL(baseUrl).origin;
	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {unknown} [body]
	 * @returns {Promise<ApiResult>}
	 */
	const request = async (method, path, body) => {
		if (!path.startsWith('/v1/')) throw new TypeError(`console API paths start with /v1/ (got ${path})`);
		/** @type {Record<string, string>} */
		const headers = { accept: 'application/json' };
		const cookieHeader = typeof cookie === 'function' ? cookie() : cookie;
		if (cookieHeader) headers.cookie = cookieHeader;
		if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
		if (userAgent) headers['user-agent'] = userAgent;
		if (method !== 'GET' && method !== 'HEAD') {
			headers.origin = origin;
			headers['sec-fetch-site'] = 'same-origin';
		}
		if (body !== undefined) headers['content-type'] = 'application/json';
		if (method === 'POST') headers['idempotency-key'] = randomUUID();
		/** @type {Response} */
		let response;
		try {
			response = await handle(
				new Request(new URL(path, origin), {
					method,
					headers,
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
		} catch (error) {
			return {
				ok: false,
				status: 500,
				problem: {
					type: 'internal_error',
					title: 'Internal error',
					status: 500,
					detail: error instanceof Error ? error.message : 'The Portal failed.',
				},
			};
		}
		if (onSetCookie) {
			const set = response.headers.getSetCookie();
			if (set.length > 0) onSetCookie(set);
		}
		const data = await readJson(response);
		if (response.ok) return { ok: true, status: response.status, data };
		const problem =
			data && typeof data === 'object'
				? /** @type {Problem} */ (data)
				: { title: response.statusText || 'Error', status: response.status };
		return { ok: false, status: response.status, problem: { status: response.status, ...problem } };
	};
	return {
		request,
		get: (path) => request('GET', path),
		post: (path, body) => request('POST', path, body),
	};
};
