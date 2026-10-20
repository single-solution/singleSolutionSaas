/**
 * Server-side API client of the consoles. Server components never reach module services directly: every read is
 * an HTTP call to the Portal's own handler (`portal.handle`), made **in-process** with the signed-in user's cookies,
 * so the console exercises exactly the public API (auth, RBAC, rate limits, problems) — "every UI action is an API
 * call". It only reads: every change is made by the browser (`client.js`). Results are plain `{ ok, status, data }` /
 * `{ ok: false, status, problem }` objects (never thrown), so pages can render friendly error states.
 * @module
 */

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {{ ok: true, status: number, data: T } | { ok: false, status: number, problem: Problem }} ApiResult
 */

/**
 * @typedef {object} ConsoleApi
 * @property {<T = any>(path: string) => Promise<ApiResult<T>>} get
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
 * The client of one page render (one browser request): each read is made once (the same GET twice answers from the
 * first call), and the reads share one in-request memo with the Portal (the session is looked up and each merchant
 * checked once per render, PLAN 0.5.7).
 * @param {{ handle: (request: Request, options?: { memo?: Map<string, unknown> }) => Promise<Response>, baseUrl: string,
 *   cookie?: string | null, forwardedFor?: string | null, realIp?: string | null }} options `cookie`: the request's Cookie
 * header; `forwardedFor`, `realIp`: the request's address headers, so the Portal sees the same visitor
 * @returns {ConsoleApi}
 */
export const createConsoleApi = ({ handle, baseUrl, cookie = null, forwardedFor = null, realIp = null }) => {
	const origin = new URL(baseUrl).origin;
	/** @type {Map<string, Promise<{ status: number, statusText: string, text: string } | { error: unknown }>>} */
	const reads = new Map();
	/** @type {Map<string, unknown>} */
	const memo = new Map();

	/** @param {string} path */
	const send = async (path) => {
		/** @type {Record<string, string>} */
		const headers = { accept: 'application/json' };
		if (cookie) headers.cookie = cookie;
		if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
		if (realIp) headers['x-real-ip'] = realIp;
		try {
			const response = await handle(new Request(new URL(path, origin), { headers }), { memo });
			return { status: response.status, statusText: response.statusText, text: await response.text() };
		} catch (error) {
			return { error };
		}
	};

	return {
		get: async (path) => {
			if (!path.startsWith('/v1/')) throw new TypeError(`console API paths start with /v1/ (got ${path})`);
			const known = reads.get(path) ?? send(path);
			reads.set(path, known);
			const answer = await known;
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
			const data = /** @type {any} */ (parse(answer.text));
			if (answer.status >= 200 && answer.status < 300) return { ok: true, status: answer.status, data };
			const problem =
				data && typeof data === 'object'
					? /** @type {Problem} */ (data)
					: { title: answer.statusText || 'Error', status: answer.status };
			return { ok: false, status: answer.status, problem: { status: answer.status, ...problem } };
		},
	};
};
