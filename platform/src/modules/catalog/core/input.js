/**
 * Request body validation for the catalog routes (pure). Every parser returns `{ ok: true, value }` or
 * `{ ok: false, errors: [{ path, message }] }` and refuses unknown properties.
 * @module
 */

/** @typedef {{ path: string, message: string }} FieldError */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, errors: FieldError[] }} Parsed
 */

const JTI = /^[A-Za-z0-9_-]{16,256}$/;
const ID = /^[a-z]{2,8}_[0-9a-z]{10,64}$/;

/**
 * @param {unknown} body
 * @param {ReadonlyArray<string>} allowed
 * @returns {{ input: Record<string, unknown>, errors: FieldError[] }}
 */
const open = (body, allowed) => {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		return { input: {}, errors: [{ path: '', message: 'body must be a JSON object' }] };
	const input = /** @type {Record<string, unknown>} */ (body);
	return {
		input,
		errors: Object.keys(input)
			.filter((key) => !allowed.includes(key))
			.map((key) => ({ path: `/${key}`, message: 'unknown property' })),
	};
};

/**
 * @template T
 * @param {FieldError[]} errors
 * @param {T} value
 * @returns {Parsed<T>}
 */
const done = (errors, value) => (errors.length > 0 ? { ok: false, errors } : { ok: true, value });

/**
 * Add product and Reconnect: the product address and its connect secret (`url` optional on Reconnect, where the
 * stored address is kept).
 * @param {unknown} body
 * @param {{ urlRequired: boolean }} options
 * @returns {Parsed<{ url: string | null, secret: string }>}
 */
export const parseConnect = (body, { urlRequired }) => {
	const { input, errors } = open(body, ['url', 'secret']);
	const url = input.url;
	if (url === undefined || url === null) {
		if (urlRequired) errors.push({ path: '/url', message: 'is required' });
	} else if (typeof url !== 'string' || url.length === 0 || url.length > 2048)
		errors.push({ path: '/url', message: 'must be a URL' });
	if (typeof input.secret !== 'string' || input.secret.length === 0 || input.secret.length > 1024)
		errors.push({ path: '/secret', message: 'is required' });
	return done(errors, { url: typeof url === 'string' ? url : null, secret: String(input.secret ?? '') });
};

/**
 * Set active / inactive.
 * @param {unknown} body
 * @returns {Parsed<{ status: 'active' | 'inactive' }>}
 */
export const parseStatus = (body) => {
	const { input, errors } = open(body, ['status']);
	if (input.status !== 'active' && input.status !== 'inactive')
		errors.push({ path: '/status', message: 'must be active or inactive' });
	return done(errors, { status: /** @type {'active' | 'inactive'} */ (input.status) });
};

/**
 * Open as admin: the website to open, or null (Owner only: Defaults with no website).
 * @param {unknown} body
 * @returns {Parsed<{ websiteId: string | null }>}
 */
export const parseAdminLaunch = (body) => {
	const { input, errors } = open(body ?? {}, ['websiteId']);
	const websiteId = input.websiteId ?? null;
	if (websiteId !== null && (typeof websiteId !== 'string' || !ID.test(websiteId)))
		errors.push({ path: '/websiteId', message: 'must be a website id or null' });
	return done(errors, { websiteId: /** @type {string | null} */ (websiteId) });
};

/**
 * Launch consumption by the product.
 * @param {unknown} body
 * @returns {Parsed<{ jti: string }>}
 */
export const parseConsume = (body) => {
	const { input, errors } = open(body, ['jti']);
	if (typeof input.jti !== 'string' || !JTI.test(input.jti))
		errors.push({ path: '/jti', message: 'must be 16..256 base64url characters' });
	return done(errors, { jti: String(input.jti) });
};

/**
 * Product URL that exchanges a launch (`GET <base>/sso?launch=<token>`, PLAN 0.4.3).
 * @param {string} baseUrl
 * @param {string} token
 */
export const launchUrl = (baseUrl, token) => `${baseUrl.replace(/\/+$/, '')}/sso?launch=${encodeURIComponent(token)}`;
