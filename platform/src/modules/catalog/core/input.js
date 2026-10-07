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
 * @param {unknown} value
 * @param {string} path
 * @param {FieldError[]} errors
 * @param {{ required?: boolean, max?: number }} [options]
 * @returns {string | undefined}
 */
const str = (value, path, errors, { required = false, max = 2048 } = {}) => {
	if (value === undefined || value === null) {
		if (required) errors.push({ path, message: 'is required' });
		return undefined;
	}
	if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
		errors.push({ path, message: `must be a non-empty string of at most ${max} characters` });
		return undefined;
	}
	return value.trim();
};

/**
 * `POST /v1/admin/apps/:appId/status` `{ status }`
 * @param {unknown} body
 * @returns {Parsed<{ status: 'active' | 'inactive' }>}
 */
export const parseStatus = (body) => {
	const { input, errors } = open(body, ['status']);
	if (input.status !== 'active' && input.status !== 'inactive')
		errors.push({ path: '/status', message: 'status must be active or inactive' });
	return done(errors, { status: /** @type {'active' | 'inactive'} */ (input.status) });
};

/**
 * `POST /v1/product/launch/consume` `{ jti }` (F.9; app-kit also sends `exp`, which is accepted and ignored).
 * @param {unknown} body
 * @returns {Parsed<{ jti: string }>}
 */
export const parseConsume = (body) => {
	const { input, errors } = open(body, ['jti', 'exp']);
	if (typeof input.jti !== 'string' || !JTI.test(input.jti)) errors.push({ path: '/jti', message: 'jti is required' });
	if (input.exp !== undefined && !Number.isSafeInteger(input.exp))
		errors.push({ path: '/exp', message: 'exp must be unix seconds' });
	return done(errors, { jti: /** @type {string} */ (input.jti) });
};

/**
 * Staff (admin) launch body (`POST /v1/admin/apps/:appId/launch`): one merchant (optionally one website), or
 * `all: true` for an app-wide admin launch (`scope: { all: true }`). `kind` may be sent and must be `admin`.
 * @param {unknown} body
 * @returns {Parsed<{ all: boolean, merchantId: string | null, websiteId: string | null }>}
 */
export const parseStaffLaunch = (body) => {
	const { input, errors } = open(body ?? {}, ['kind', 'all', 'merchantId', 'websiteId']);
	if (input.kind !== undefined && input.kind !== 'admin') errors.push({ path: '/kind', message: 'kind must be admin' });
	const merchantId = str(input.merchantId, '/merchantId', errors, { max: 128 });
	const websiteId = str(input.websiteId, '/websiteId', errors, { max: 128 });
	if (input.all !== undefined && input.all !== true) errors.push({ path: '/all', message: 'all must be true when given' });
	if (input.all === true && (merchantId || websiteId))
		errors.push({ path: '/all', message: 'all excludes merchantId and websiteId' });
	return done(errors, { all: input.all === true, merchantId: merchantId ?? null, websiteId: websiteId ?? null });
};

/**
 * Merchant launch body (`POST /v1/merchants/:merchantId/apps/:appId/launch`).
 * @param {unknown} body
 * @returns {Parsed<{ websiteId: string | null }>}
 */
export const parseMerchantLaunch = (body) => {
	const { input, errors } = open(body ?? {}, ['websiteId']);
	const websiteId = str(input.websiteId, '/websiteId', errors, { max: 128 });
	return done(errors, { websiteId: websiteId ?? null });
};
