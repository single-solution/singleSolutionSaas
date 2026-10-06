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
const REASON_MAX = 500;

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
 * `PUT /v1/admin/apps/:appId/environments` — `staging: null` removes the staging environment.
 * @param {unknown} body
 * @returns {Parsed<{ production?: string, staging?: string | null }>}
 */
export const parseEnvironments = (body) => {
	const { input, errors } = open(body, ['production', 'staging']);
	/** @type {{ production?: string, staging?: string | null }} */
	const value = {};
	if (input.production !== undefined) {
		const production = str(input.production, '/production', errors, { required: true });
		if (production) value.production = production;
	}
	if (input.staging === null) value.staging = null;
	else if (input.staging !== undefined) {
		const staging = str(input.staging, '/staging', errors, { required: true });
		if (staging) value.staging = staging;
	}
	if (input.production === undefined && input.staging === undefined && errors.length === 0)
		errors.push({ path: '', message: 'send production and/or staging' });
	return done(errors, value);
};

/**
 * `POST /v1/admin/apps/:appId/lifecycle`
 * @param {unknown} body
 * @returns {Parsed<{ action: 'activate' | 'deprecate' | 'retire', sunsetAt: string | null, reason: string | null, force: boolean }>}
 */
export const parseLifecycle = (body) => {
	const { input, errors } = open(body, ['action', 'sunsetAt', 'reason', 'force']);
	const action = input.action;
	if (action !== 'activate' && action !== 'deprecate' && action !== 'retire')
		errors.push({ path: '/action', message: 'action must be activate, deprecate or retire' });
	const sunsetAt = str(input.sunsetAt, '/sunsetAt', errors, { required: action === 'deprecate', max: 40 });
	const reason = str(input.reason, '/reason', errors, { required: action !== 'activate', max: REASON_MAX });
	if (input.force !== undefined && typeof input.force !== 'boolean')
		errors.push({ path: '/force', message: 'must be a boolean' });
	return done(errors, {
		action: /** @type {'activate' | 'deprecate' | 'retire'} */ (action),
		sunsetAt: sunsetAt ?? null,
		reason: reason ?? null,
		force: input.force === true,
	});
};

/**
 * Version review (`approve` reason optional, `reject` reason required) and key revocation (reason required).
 * @param {unknown} body
 * @param {{ reasonRequired: boolean }} options
 * @returns {Parsed<{ reason: string | null }>}
 */
export const parseReason = (body, { reasonRequired }) => {
	const { input, errors } = open(body ?? {}, ['reason']);
	const reason = str(input.reason, '/reason', errors, { required: reasonRequired, max: REASON_MAX });
	return done(errors, { reason: reason ?? null });
};

/**
 * `POST /v1/product/keys/rotate` `{ publicJwk }` (F.9)
 * @param {unknown} body
 * @returns {Parsed<{ publicJwk: unknown }>}
 */
export const parseRotate = (body) => {
	const { input, errors } = open(body, ['publicJwk']);
	if (typeof input.publicJwk !== 'object' || input.publicJwk === null || Array.isArray(input.publicJwk))
		errors.push({ path: '/publicJwk', message: 'publicJwk must be an Ed25519 public JWK' });
	return done(errors, { publicJwk: input.publicJwk });
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
 * Staff launch body (`POST /v1/admin/apps/:appId/launch`). `all: true` asks for an app-wide admin launch
 * (`scope: { all: true }`), exclusive with merchant/website/partner/developer ids.
 * @param {unknown} body
 * @returns {Parsed<{ kind: string, all: boolean, merchantId: string | null, websiteId: string | null, partnerId: string | null,
 *   developerId: string | null, subject: string | null, impersonationSeconds: number | undefined,
 *   environment: 'production' | 'staging' }>}
 */
export const parseStaffLaunch = (body) => {
	const { input, errors } = open(body, [
		'kind',
		'all',
		'merchantId',
		'websiteId',
		'partnerId',
		'developerId',
		'subject',
		'impersonationSeconds',
		'environment',
	]);
	const kind = str(input.kind, '/kind', errors, { required: true, max: 32 });
	const merchantId = str(input.merchantId, '/merchantId', errors, { max: 128 });
	const websiteId = str(input.websiteId, '/websiteId', errors, { max: 128 });
	const partnerId = str(input.partnerId, '/partnerId', errors, { max: 128 });
	const developerId = str(input.developerId, '/developerId', errors, { max: 128 });
	const subject = str(input.subject, '/subject', errors, { max: 128 });
	if (input.impersonationSeconds !== undefined && !Number.isInteger(input.impersonationSeconds))
		errors.push({ path: '/impersonationSeconds', message: 'must be an integer' });
	const environment = input.environment ?? 'production';
	if (environment !== 'production' && environment !== 'staging')
		errors.push({ path: '/environment', message: 'environment must be production or staging' });
	if (input.all !== undefined && input.all !== true) errors.push({ path: '/all', message: 'all must be true when given' });
	if (input.all === true && (kind !== 'admin' || merchantId || websiteId || partnerId || developerId))
		errors.push({ path: '/all', message: 'all is only for admin launches without merchantId or websiteId' });
	return done(errors, {
		kind: kind ?? '',
		all: input.all === true,
		merchantId: merchantId ?? null,
		websiteId: websiteId ?? null,
		partnerId: partnerId ?? null,
		developerId: developerId ?? null,
		subject: subject ?? null,
		impersonationSeconds: /** @type {number | undefined} */ (input.impersonationSeconds),
		environment: /** @type {'production' | 'staging'} */ (environment),
	});
};

/**
 * Merchant demo launch body (`POST /v1/merchants/:merchantId/apps/:appId/demo`): no fields — a demo is never scoped
 * to the merchant or a website.
 * @param {unknown} body
 * @returns {Parsed<Record<string, never>>}
 */
export const parseDemoLaunch = (body) => {
	const { errors } = open(body ?? {}, []);
	return done(errors, /** @type {Record<string, never>} */ ({}));
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
