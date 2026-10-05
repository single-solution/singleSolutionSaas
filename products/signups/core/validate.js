/**
 * Request validation (pure): shapes of every Mode C body. Field problems are `{ path, code }` (JSON Pointer paths);
 * the API turns them into RFC 9457 `validation_failed` problems.
 * @module
 */

/** @typedef {{ path: string, code: string }} FieldProblem */

export const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const EXTERNAL_ID = /^[\x21-\x7e]{1,128}$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {Record<string, unknown>} body
 * @param {readonly string[]} allowed
 * @returns {FieldProblem[]}
 */
const unknownFields = (body, allowed) =>
	Object.keys(body)
		.filter((key) => !allowed.includes(key))
		.map((key) => ({ path: `/${key}`, code: 'unknown_field' }));

/**
 * Optional `deviceId` and `locale`.
 * @param {Record<string, unknown>} body
 * @returns {FieldProblem[]}
 */
const common = (body) => [
	...(body.deviceId !== undefined && (typeof body.deviceId !== 'string' || !DEVICE_ID.test(body.deviceId))
		? [{ path: '/deviceId', code: 'format' }]
		: []),
	...(body.locale !== undefined && (typeof body.locale !== 'string' || !LOCALE.test(body.locale))
		? [{ path: '/locale', code: 'format' }]
		: []),
];

/**
 * @param {unknown} value
 * @param {string} path
 * @param {number} [max]
 * @returns {FieldProblem[]}
 */
const requiredString = (value, path, max = 320) =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= max ? [] : [{ path, code: 'required' }];

/**
 * `POST /v1/otp`: `{ channel, to, purpose?, locale?, deviceId? }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateOtpRequest = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	return [
		...unknownFields(body, ['channel', 'to', 'purpose', 'locale', 'deviceId']),
		...requiredString(body.channel, '/channel', 20),
		...requiredString(body.to, '/to', 320),
		...(body.purpose !== undefined && body.purpose !== 'sign_in' && body.purpose !== 'link'
			? [{ path: '/purpose', code: 'enum' }]
			: []),
		...common(body),
	];
};

/**
 * `POST /v1/otp/{id}/verify`: `{ code, deviceId?, consents? }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateOtpVerify = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	return [
		...unknownFields(body, ['code', 'deviceId', 'consents', 'locale']),
		...requiredString(body.code, '/code', 64),
		...common(body),
	];
};

/**
 * `POST /v1/magic-links`: `{ email, redirect?, purpose?, locale?, deviceId? }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateMagicRequest = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	return [
		...unknownFields(body, ['email', 'redirect', 'purpose', 'locale', 'deviceId']),
		...requiredString(body.email, '/email'),
		...(body.redirect !== undefined && (typeof body.redirect !== 'string' || body.redirect.length > 2048)
			? [{ path: '/redirect', code: 'format' }]
			: []),
		...(body.purpose !== undefined && body.purpose !== 'sign_in' && body.purpose !== 'link'
			? [{ path: '/purpose', code: 'enum' }]
			: []),
		...common(body),
	];
};

/**
 * `POST /v1/magic-links:consume`: `{ token, deviceId?, consents? }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateMagicConsume = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	return [
		...unknownFields(body, ['token', 'deviceId', 'consents', 'locale']),
		...requiredString(body.token, '/token', 512),
		...common(body),
	];
};

/**
 * `POST /v1/sessions:refresh` / `:logout`: `{ refreshToken }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateRefresh = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	return [
		...unknownFields(body, ['refreshToken', 'deviceId']),
		...requiredString(body.refreshToken, '/refreshToken', 512),
		...common(body),
	];
};

/**
 * `POST /v1/customers` (server import): `{ email?, phone?, externalId?, profile?, custom?, verified? }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateCustomerCreate = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	/** @type {FieldProblem[]} */
	const problems = unknownFields(body, ['email', 'phone', 'externalId', 'profile', 'addresses', 'custom', 'verified']);
	if (body.email !== undefined && typeof body.email !== 'string') problems.push({ path: '/email', code: 'type' });
	if (body.phone !== undefined && typeof body.phone !== 'string') problems.push({ path: '/phone', code: 'type' });
	if (body.externalId !== undefined && (typeof body.externalId !== 'string' || !EXTERNAL_ID.test(body.externalId)))
		problems.push({ path: '/externalId', code: 'format' });
	if (body.verified !== undefined) {
		if (!isObject(body.verified)) problems.push({ path: '/verified', code: 'type' });
		else
			for (const [key, value] of Object.entries(body.verified))
				if (!['email', 'phone'].includes(key) || typeof value !== 'boolean')
					problems.push({ path: `/verified/${key}`, code: 'type' });
	}
	return problems;
};

/**
 * `PATCH /v1/customers/{id}` (server): profile patch plus `status` and `externalId`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateCustomerAdminPatch = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	if (body.status !== undefined && body.status !== 'active' && body.status !== 'blocked')
		problems.push({ path: '/status', code: 'enum' });
	if (
		body.externalId !== undefined &&
		body.externalId !== null &&
		(typeof body.externalId !== 'string' || !EXTERNAL_ID.test(body.externalId))
	)
		problems.push({ path: '/externalId', code: 'format' });
	return problems;
};

/**
 * `POST /v1/data-requests`: `{ type: 'export' | 'delete' }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateDataRequest = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	return [
		...unknownFields(body, ['type']),
		...(body.type === 'export' || body.type === 'delete' ? [] : [{ path: '/type', code: 'enum' }]),
	];
};

/**
 * `POST /v1/consents`: `{ consents: [{ key, version }] }`.
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateConsentAccept = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'type' }];
	return [
		...unknownFields(body, ['consents']),
		...(Array.isArray(body.consents) ? [] : [{ path: '/consents', code: 'required' }]),
	];
};
