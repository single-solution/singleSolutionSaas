/**
 * Credential schemas of client-owned resources (PLAN §1a), per kind and provider (pure). Structural validation uses
 * closed JSON Schemas through `@ss/contracts` `createValidator`; semantic checks (public hosts, https, allowed ports,
 * safe MongoDB options, TLS — the `@ss/net` outbound policy) follow. Error messages never echo submitted values.
 * @module
 */
import { RESOURCE_KINDS, createValidator } from '@ss/contracts';
import { checkHost, checkUrl } from '@ss/net';
import { checkDatabaseCredentials } from './mongo-uri.js';

/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/** @typedef {{ path: string, message: string, keyword?: string, code?: string }} FieldError */
/** @typedef {typeof RESOURCE_KINDS[number]} ResourceKind */

export const KINDS = RESOURCE_KINDS;

/** Built-in AI providers and their API base URLs. */
export const AI_PROVIDERS = Object.freeze({
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com/v1',
	google: 'https://generativelanguage.googleapis.com/v1beta',
	generic: null,
});

/** S3-compatible object stores (all signed with SigV4). */
export const STORAGE_PROVIDERS = Object.freeze(['s3', 'r2', 'gcs', 'minio']);
export const MESSAGING_PROVIDERS = Object.freeze(['generic-http', 'smtp']);
const SLUG = '^[a-z][a-z0-9-]{1,31}$';
const TOKEN = '^[\\x21-\\x7e]+$';
const HEADER_NAME = '^[A-Za-z0-9-]{1,64}$';
const FORBIDDEN_HEADERS = new Set([
	'host',
	'content-length',
	'content-type',
	'transfer-encoding',
	'connection',
	'cookie',
	'authorization',
	'proxy-authorization',
	'te',
	'upgrade',
	'expect',
]);

const ID_BASE = 'urn:ss:platform:connectors:v1:';
const secret = (max = 4096) => ({ type: 'string', minLength: 1, maxLength: max, pattern: TOKEN });
const url = { type: 'string', minLength: 8, maxLength: 512 };
const headers = {
	type: 'object',
	maxProperties: 20,
	propertyNames: { type: 'string', pattern: HEADER_NAME },
	additionalProperties: { type: 'string', maxLength: 1024, pattern: '^[\\x20-\\x7e]*$' },
};

/** @type {Record<string, Record<string, unknown>>} */
const SCHEMAS = {
	database: {
		type: 'object',
		additionalProperties: false,
		required: ['uri'],
		properties: {
			uri: { type: 'string', minLength: 10, maxLength: 4096 },
			dbName: { type: 'string', minLength: 1, maxLength: 63 },
		},
	},
	storage: {
		type: 'object',
		additionalProperties: false,
		required: ['region', 'bucket', 'accessKeyId', 'secretAccessKey'],
		properties: {
			endpoint: url,
			region: { type: 'string', pattern: '^[a-z0-9-]{1,32}$' },
			bucket: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' },
			accessKeyId: secret(256),
			secretAccessKey: secret(512),
			forcePathStyle: { type: 'boolean' },
			prefix: { type: 'string', maxLength: 200, pattern: "^(?:[A-Za-z0-9!_.*'()-]+/)*$" },
		},
	},
	ai: {
		type: 'object',
		additionalProperties: false,
		required: ['apiKey'],
		properties: { baseUrl: url, apiKey: secret(), model: { type: 'string', minLength: 1, maxLength: 128, pattern: TOKEN } },
	},
	'messaging-generic-http': {
		type: 'object',
		additionalProperties: false,
		required: ['baseUrl', 'apiKey'],
		properties: {
			baseUrl: url,
			apiKey: secret(),
			authScheme: { type: 'string', enum: ['bearer', 'header'] },
			authHeader: { type: 'string', pattern: HEADER_NAME },
			headers,
			testPath: { type: 'string', maxLength: 256, pattern: "^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$" },
		},
	},
	'messaging-smtp': {
		type: 'object',
		additionalProperties: false,
		required: ['host', 'username', 'password'],
		properties: {
			host: { type: 'string', minLength: 1, maxLength: 253 },
			port: { type: 'integer', minimum: 1, maximum: 65535 },
			secure: { type: 'boolean' },
			username: { type: 'string', minLength: 1, maxLength: 256 },
			password: { type: 'string', minLength: 1, maxLength: 1024 },
			from: { type: 'string', maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+$' },
		},
	},
	payments: {
		type: 'object',
		minProperties: 1,
		maxProperties: 20,
		propertyNames: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' },
		additionalProperties: { type: 'string', minLength: 1, maxLength: 4096 },
	},
};

/** @type {import('@ss/contracts').Validator | null} */
let validator = null;
const getValidator = () => {
	validator ??= createValidator({
		schemas: Object.entries(SCHEMAS).map(([name, schema]) => ({ $id: `${ID_BASE}${name}`, ...schema })),
	});
	return validator;
};

/**
 * Providers accepted for a kind (`null` = any slug, for kinds whose providers are adapters registered later).
 * @param {ResourceKind} kind
 * @returns {ReadonlyArray<string> | null}
 */
export const providersFor = (kind) => {
	switch (kind) {
		case 'database':
			return ['mongodb'];
		case 'storage':
			return STORAGE_PROVIDERS;
		case 'ai':
			return Object.keys(AI_PROVIDERS);
		case 'messaging':
			return MESSAGING_PROVIDERS;
		default:
			return null;
	}
};

/**
 * @param {ResourceKind} kind
 * @param {string} provider
 */
const schemaNameFor = (kind, provider) => (kind === 'messaging' ? `messaging-${provider}` : kind);

/**
 * @param {URL} target
 * @param {string} path
 * @returns {FieldError[]}
 */
const plainUrl = (target, path) => {
	if (path.endsWith('endpoint'))
		return target.search || target.pathname !== '/' ? [{ path, message: 'must be an origin (no path or query)' }] : [];
	return target.search ? [{ path, message: 'must not carry a query' }] : [];
};

/**
 * @param {unknown} raw
 * @param {string} path
 * @param {OutboundPolicy} policy
 * @returns {FieldError[]}
 */
const checkUrlField = (raw, path, policy) => {
	if (raw === undefined) return [];
	const text = String(raw);
	if (text.includes('#')) return [{ path, message: 'is not a valid URL', code: 'invalid_url' }];
	const checked = checkUrl(text, policy);
	if (!checked.ok) {
		const code = urlRefusalCode(checked);
		const message =
			code === 'https_required'
				? 'must use https'
				: code === 'port_refused'
					? 'must use port 443 or 8443'
					: code === 'address_refused'
						? 'must point at a public address'
						: 'is not a valid URL';
		return [{ path, message, code }];
	}
	return plainUrl(checked.url, path);
};

/**
 * Stable connector code of an `@ss/net` URL refusal (`checkUrl` / `safeFetch`).
 * @param {{ code: string, reason: string }} refusal
 * @returns {'https_required' | 'port_refused' | 'address_refused' | 'invalid_url'}
 */
export const urlRefusalCode = ({ code, reason }) => {
	if (reason === 'https_required' || reason === 'unsupported_scheme') return 'https_required';
	if (reason === 'port') return 'port_refused';
	return code === 'ssrf_blocked' ? 'address_refused' : 'invalid_url';
};

/**
 * Validate a connector's credentials for its kind and provider.
 * @param {{ kind: unknown, provider: unknown, credentials: unknown }} input
 * @param {OutboundPolicy} policy outbound policy (`@ss/net`) the credentials' destinations must pass
 * @returns {{ ok: true, kind: ResourceKind, provider: string, credentials: Record<string, any> } | { ok: false, errors: FieldError[] }}
 */
export const validateCredentials = ({ kind, provider, credentials }, policy) => {
	if (typeof kind !== 'string' || !KINDS.includes(/** @type {ResourceKind} */ (kind)))
		return { ok: false, errors: [{ path: '/kind', message: `must be one of: ${KINDS.join(', ')}` }] };
	const k = /** @type {ResourceKind} */ (kind);
	const allowed = providersFor(k);
	if (typeof provider !== 'string' || (allowed ? !allowed.includes(provider) : !new RegExp(SLUG).test(provider))) {
		return {
			ok: false,
			errors: [{ path: '/provider', message: allowed ? `must be one of: ${allowed.join(', ')}` : 'must be a provider slug' }],
		};
	}
	const structural = getValidator().validate(`${ID_BASE}${schemaNameFor(k, provider)}`, credentials);
	if (!structural.ok)
		return {
			ok: false,
			errors: structural.problems.map((p) => ({ path: `/credentials${p.path}`, message: p.message, keyword: p.keyword })),
		};
	const c = /** @type {Record<string, any>} */ (credentials);
	/** @type {FieldError[]} */
	const errors = [];
	if (k === 'database') errors.push(...checkDatabaseCredentials(/** @type {any} */ (c), policy).errors);
	if (k === 'storage') errors.push(...checkUrlField(c.endpoint, '/credentials/endpoint', policy));
	if (k === 'ai') {
		if (provider === 'generic' && c.baseUrl === undefined)
			errors.push({ path: '/credentials/baseUrl', message: 'is required for the generic provider' });
		errors.push(...checkUrlField(c.baseUrl, '/credentials/baseUrl', policy));
	}
	if (k === 'messaging' && provider === 'generic-http') {
		errors.push(...checkUrlField(c.baseUrl, '/credentials/baseUrl', policy));
		if (c.authHeader !== undefined && FORBIDDEN_HEADERS.has(String(c.authHeader).toLowerCase()))
			errors.push({ path: '/credentials/authHeader', message: 'is a reserved header' });
		for (const name of Object.keys(c.headers ?? {}))
			if (
				FORBIDDEN_HEADERS.has(name.toLowerCase()) ||
				(c.authHeader && name.toLowerCase() === String(c.authHeader).toLowerCase())
			)
				errors.push({ path: `/credentials/headers/${name}`, message: 'is a reserved header' });
		if (typeof c.testPath === 'string' && (c.testPath.startsWith('//') || c.testPath.split('/').includes('..')))
			errors.push({ path: '/credentials/testPath', message: 'must be a relative path' });
	}
	if (k === 'messaging' && provider === 'smtp') {
		const host = checkHost(String(c.host), policy);
		if (!host.ok)
			errors.push(
				host.code === 'ssrf_blocked'
					? { path: '/credentials/host', message: 'must be a public host', code: 'address_refused' }
					: { path: '/credentials/host', message: 'is not a valid host', code: 'invalid_host' },
			);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, kind: k, provider, credentials: c };
};

/**
 * Validate a list of website ids (unique, ≤ 100).
 * @param {unknown} value
 * @returns {{ ok: true, value: string[] } | { ok: false, errors: FieldError[] }}
 */
export const validateWebsiteIds = (value) => {
	if (value === undefined) return { ok: true, value: [] };
	if (
		!Array.isArray(value) ||
		value.length > 100 ||
		value.some((id) => typeof id !== 'string' || !/^web_[0-9a-z]{10,64}$/.test(id)) ||
		new Set(value).size !== value.length
	)
		return { ok: false, errors: [{ path: '/websiteIds', message: 'must be up to 100 unique website ids' }] };
	return { ok: true, value: [...value] };
};

/**
 * Validate a label (1..80 printable characters, trimmed).
 * @param {unknown} value
 * @returns {{ ok: true, value: string } | { ok: false, errors: FieldError[] }}
 */
export const validateLabel = (value) => {
	if (
		typeof value !== 'string' ||
		value.trim().length === 0 ||
		value.trim().length > 80 ||
		[...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
	)
		return { ok: false, errors: [{ path: '/label', message: 'must be 1..80 printable characters' }] };
	return { ok: true, value: value.trim() };
};
