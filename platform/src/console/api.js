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
 * @param {string} text
 * @returns {unknown}
 */
const parse = (text) => {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

/**
 * @param {{ handle: (request: Request, options?: { memo?: Map<string, unknown> }) => Promise<Response>, baseUrl: string,
 *   cookie?: string | null | (() => string | null), onSetCookie?: (setCookies: string[]) => void,
 *   forwardedFor?: string | null, userAgent?: string | null, randomUUID?: () => string, perRender?: boolean }} options
 *   `cookie` is the request's Cookie header (or a getter, for a client that follows `Set-Cookie` through
 *   `onSetCookie`, e.g. tests and scripts). `perRender`: the client serves one page render (one browser request), so
 *   its reads are made once each (the same GET twice answers from the first call) and share one in-request memo with
 *   the Portal (the session is looked up and each merchant checked once per render, PLAN 0.5.7); a write starts
 *   afresh.
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
	perRender = false,
}) => {
	const origin = new URL(baseUrl).origin;
	/** @type {Map<string, Promise<{ status: number, statusText: string, text: string } | { error: unknown }>>} */
	let reads = new Map();
	/** @type {Map<string, unknown>} */
	let memo = new Map();

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {unknown} [body]
	 */
	const send = async (method, path, body) => {
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
		try {
			const response = await handle(
				new Request(new URL(path, origin), {
					method,
					headers,
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
				perRender && method === 'GET' ? { memo } : undefined,
			);
			if (onSetCookie) {
				const set = response.headers.getSetCookie();
				if (set.length > 0) onSetCookie(set);
			}
			return { status: response.status, statusText: response.statusText, text: await response.text() };
		} catch (error) {
			return { error };
		}
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {unknown} [body]
	 * @returns {Promise<ApiResult>}
	 */
	const request = async (method, path, body) => {
		if (!path.startsWith('/v1/')) throw new TypeError(`console API paths start with /v1/ (got ${path})`);
		/** @type {Awaited<ReturnType<typeof send>>} */
		let answer;
		if (perRender && method === 'GET') {
			const known = reads.get(path) ?? send(method, path);
			reads.set(path, known);
			answer = await known;
		} else {
			if (perRender) {
				reads = new Map();
				memo = new Map();
			}
			answer = await send(method, path, body);
		}
		if ('error' in answer) {
			const { error } = answer;
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
		// every caller gets its own copy of the data
		const data = parse(answer.text);
		if (answer.status >= 200 && answer.status < 300) return { ok: true, status: answer.status, data };
		const problem =
			data && typeof data === 'object'
				? /** @type {Problem} */ (data)
				: { title: answer.statusText || 'Error', status: answer.status };
		return { ok: false, status: answer.status, problem: { status: answer.status, ...problem } };
	};
	return {
		request,
		get: (path) => request('GET', path),
		post: (path, body) => request('POST', path, body),
	};
};
