/**
 * A small driver of the Portal HTTP API for system tests (`@ss/platform/testing`): requests go straight to
 * `portal.handle(request)` the way a browser on `PORTAL_URL` would send them (same Origin, JSON bodies, an
 * `Idempotency-Key` on every POST), and each signed-in client keeps its own session cookie. `settle()` (optional) is
 * awaited after every call, so work that runs right after a response (notices, e-mails) is done before the caller
 * looks.
 * @module
 */

/**
 * @typedef {object} CallInit
 * @property {unknown} [body] sent as JSON
 * @property {string} [cookie] a `name=value` session cookie
 * @property {string} [bearer] `Authorization: Bearer <bearer>` (product client assertions)
 * @property {Record<string, string>} [headers]
 * @property {string | null} [idempotencyKey] POST only; null sends none (default: a fresh key)
 */

/** @typedef {{ status: number, headers: Headers, json: any }} CallResult */

/**
 * @param {{ handle: (request: Request) => Promise<Response>, portalUrl: string, settle?: () => Promise<unknown> }} options
 */
export const createPortalClient = ({ handle, portalUrl, settle }) => {
	let counter = 0;

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {CallInit} [init]
	 * @returns {Promise<CallResult & { cookies: string[] }>}
	 */
	const call = async (method, path, { body, cookie, bearer, headers = {}, idempotencyKey } = {}) => {
		counter += 1;
		const response = await handle(
			new Request(`${portalUrl}${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(cookie ? { cookie, origin: portalUrl, 'sec-fetch-site': 'same-origin' } : {}),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? `key-${counter}` } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		if (settle) await settle();
		/** @type {any} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = text;
		}
		return { status: response.status, headers: response.headers, json, cookies: response.headers.getSetCookie() };
	};

	/**
	 * A client that keeps one session cookie (updated from `Set-Cookie`).
	 * @param {string} [cookie] an existing `name=value` cookie
	 */
	const session = (cookie = '') => {
		let current = cookie;
		/** @param {string} method @param {string} path @param {unknown} [body] */
		const send = async (method, path, body) => {
			const res = await call(method, path, { body, ...(current ? { cookie: current } : {}) });
			for (const set of res.cookies) {
				const [pair = ''] = set.split(';');
				const [name, value] = pair.split('=');
				current = value ? `${name}=${value}` : '';
			}
			return res;
		};
		return {
			/** @param {string} path */
			get: (path) => send('GET', path),
			/** @param {string} path @param {unknown} [body] */
			post: (path, body) => send('POST', path, body ?? {}),
			/** @param {string} path @param {unknown} [body] */
			put: (path, body) => send('PUT', path, body),
			/** @param {string} path @param {unknown} [body] */
			patch: (path, body) => send('PATCH', path, body),
			/** @param {string} path @param {unknown} [body] */
			del: (path, body) => send('DELETE', path, body),
			get cookie() {
				return current;
			},
		};
	};

	/**
	 * Create the first admin (an Owner) from the sign-in page; returns the signed-in client.
	 * @param {{ name: string, email: string, password: string }} input
	 */
	const firstAdmin = async (input) => {
		const client = session();
		const res = await client.post('/v1/auth/first-admin', input);
		if (res.status !== 201) throw new Error(`first admin: ${res.status} ${JSON.stringify(res.json)}`);
		return client;
	};

	/**
	 * Sign in (no two-step); returns the signed-in client.
	 * @param {string} email
	 * @param {string} password
	 */
	const signIn = async (email, password) => {
		const client = session();
		const res = await client.post('/v1/auth/sign-in', { email, password });
		if (res.status !== 200 || res.json?.status !== 'ok') throw new Error(`sign-in: ${res.status} ${JSON.stringify(res.json)}`);
		return client;
	};

	return Object.freeze({ call, session, firstAdmin, signIn });
};
/** @typedef {ReturnType<typeof createPortalClient>} PortalClient */
