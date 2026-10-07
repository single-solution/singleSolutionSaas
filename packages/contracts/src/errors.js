/**
 * RFC 9457 problem details: a pure builder plus a factory that resolves stable machine codes to type URIs under a
 * configurable base (e.g. `https://errors.example.dev/`). The base is never hardcoded here.
 * @module
 */
import { PRODUCT_UNAVAILABLE_REASONS } from './constants.js';

/**
 * @typedef {object} ProblemError
 * @property {string} path JSON Pointer to the offending value (`''` = the whole document)
 * @property {string} message human-readable explanation
 * @property {string} [keyword] failing schema keyword or semantic rule
 * @property {string} [code] optional machine code
 */

/**
 * @typedef {object} Problem
 * @property {string} type URI identifying the problem type (`about:blank` when none)
 * @property {string} title short, stable summary of the type
 * @property {number} status HTTP status code
 * @property {string} [detail] explanation of this occurrence
 * @property {string} [instance] URI reference of this occurrence
 * @property {string} [requestId] correlation id
 * @property {ProductUnavailableReason} [reason] `product_unavailable` only: stopped, suspended or removed
 * @property {ReadonlyArray<ProblemError>} [errors] field-level errors
 */

/**
 * @typedef {object} ProblemInput
 * @property {string} [type] problem type URI; defaults to `about:blank`
 * @property {string} title
 * @property {number} status
 * @property {string} [detail]
 * @property {string} [instance]
 * @property {string} [requestId]
 * @property {ProductUnavailableReason} [reason]
 * @property {ReadonlyArray<ProblemError>} [errors]
 */

/** @typedef {import('./constants.js').ProductUnavailableReason} ProductUnavailableReason */

/** @typedef {{ readonly status: number, readonly title: string }} ProblemCodeDefinition */

/** Stable problem codes shared by the Portal and every product. Additive only within v1. */
export const PROBLEM_CODES = Object.freeze({
	bad_request: Object.freeze({ status: 400, title: 'Bad request' }),
	unsupported_version: Object.freeze({ status: 400, title: 'Unsupported contract version' }),
	unauthorized: Object.freeze({ status: 401, title: 'Authentication required' }),
	invalid_credentials: Object.freeze({ status: 401, title: 'Invalid or expired credentials' }),
	invalid_token: Object.freeze({ status: 401, title: 'Invalid token' }),
	forbidden: Object.freeze({ status: 403, title: 'Forbidden' }),
	product_unavailable: Object.freeze({ status: 403, title: 'Product unavailable for this website' }),
	feature_off: Object.freeze({ status: 403, title: 'Feature is off' }),
	database_not_connected: Object.freeze({ status: 403, title: 'Database not connected' }),
	not_found: Object.freeze({ status: 404, title: 'Not found' }),
	website_not_found: Object.freeze({ status: 404, title: 'Website not found' }),
	method_not_allowed: Object.freeze({ status: 405, title: 'Method not allowed' }),
	conflict: Object.freeze({ status: 409, title: 'Conflict' }),
	idempotency_conflict: Object.freeze({ status: 409, title: 'Idempotency key reused with a different request' }),
	gone: Object.freeze({ status: 410, title: 'Gone' }),
	precondition_failed: Object.freeze({ status: 412, title: 'Precondition failed' }),
	payload_too_large: Object.freeze({ status: 413, title: 'Payload too large' }),
	unsupported_media_type: Object.freeze({ status: 415, title: 'Unsupported media type' }),
	validation_failed: Object.freeze({ status: 422, title: 'Validation failed' }),
	invalid_manifest: Object.freeze({ status: 422, title: 'Invalid manifest' }),
	idempotency_key_required: Object.freeze({ status: 428, title: 'Idempotency-Key header required' }),
	rate_limited: Object.freeze({ status: 429, title: 'Too many requests' }),
	internal_error: Object.freeze({ status: 500, title: 'Internal error' }),
	not_implemented: Object.freeze({ status: 501, title: 'Not implemented' }),
	upstream_error: Object.freeze({ status: 502, title: 'Upstream error' }),
	unavailable: Object.freeze({ status: 503, title: 'Service unavailable' }),
	portal_unreachable: Object.freeze({ status: 503, title: 'Portal unreachable' }),
	timeout: Object.freeze({ status: 504, title: 'Upstream timeout' }),
});

/** @typedef {keyof typeof PROBLEM_CODES} ProblemCode */

/**
 * @param {ProblemError} error
 * @returns {ProblemError}
 */
const normaliseError = (error) =>
	Object.freeze({
		path: typeof error.path === 'string' ? error.path : '',
		message: String(error.message),
		...(error.keyword === undefined ? {} : { keyword: error.keyword }),
		...(error.code === undefined ? {} : { code: error.code }),
	});

/**
 * Build a frozen RFC 9457 problem object. Omits absent members; throws on an invalid status or empty title.
 * @param {ProblemInput} input
 * @returns {Readonly<Problem>}
 */
export const problem = ({ type, title, status, detail, instance, requestId, reason, errors }) => {
	if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError(`Invalid problem status: ${status}`);
	if (typeof title !== 'string' || title.length === 0) throw new TypeError('Problem title is required.');
	if (reason !== undefined && !PRODUCT_UNAVAILABLE_REASONS.includes(reason))
		throw new TypeError(`Invalid problem reason: ${JSON.stringify(reason)}`);
	return Object.freeze({
		type: type ?? 'about:blank',
		title,
		status,
		...(detail === undefined ? {} : { detail }),
		...(instance === undefined ? {} : { instance }),
		...(requestId === undefined ? {} : { requestId }),
		...(reason === undefined ? {} : { reason }),
		...(errors === undefined || errors.length === 0 ? {} : { errors: Object.freeze(errors.map(normaliseError)) }),
	});
};

/**
 * @typedef {object} ProblemFactory
 * @property {string} baseUri the normalised base (always ends with `/`)
 * @property {Readonly<Record<string, ProblemCodeDefinition>>} codes the registry in use
 * @property {(code: string) => string} typeFor type URI of a registered code (throws for unknown codes)
 * @property {(uri: string) => string | null} codeOf registered code of a type URI, or `null`
 * @property {(code: string, overrides?: Partial<Omit<ProblemInput, 'type'>>) => Readonly<Problem>} create build a problem for a code
 * @property {(input: (Partial<ProblemInput> & { code: string }) | ProblemInput) => Readonly<Problem>} problem
 *   like the pure {@link problem} builder, but `code` resolves type, title and status from the registry
 * @property {(errors: ReadonlyArray<ProblemError>, options?: { code?: string, detail?: string, requestId?: string, instance?: string }) => Readonly<Problem>} fromValidation
 *   wrap validator problems (default code `validation_failed`)
 */

/**
 * Create a problem factory bound to a base URI, e.g. `createProblemFactory({ baseUri: 'https://errors.example.dev' })`.
 * Products may extend the registry with their own codes (`codes`), which cannot redefine built-in ones.
 * @param {{ baseUri: string, codes?: Readonly<Record<string, ProblemCodeDefinition>> }} options
 * @returns {ProblemFactory}
 */
export const createProblemFactory = ({ baseUri, codes = {} }) => {
	/** @type {URL} */
	let parsed;
	try {
		parsed = new URL(baseUri);
	} catch {
		throw new TypeError(`Problem baseUri must be an absolute URI: ${JSON.stringify(baseUri)}`);
	}
	if (parsed.search || parsed.hash) throw new TypeError('Problem baseUri must not contain a query or fragment.');
	const base = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
	for (const [code, definition] of Object.entries(codes)) {
		if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new TypeError(`Invalid problem code: ${code}`);
		if (Object.hasOwn(PROBLEM_CODES, code)) throw new TypeError(`Problem code already defined: ${code}`);
		problem({ title: definition.title, status: definition.status });
	}
	/** @type {Readonly<Record<string, ProblemCodeDefinition>>} */
	const registry = Object.freeze({ ...PROBLEM_CODES, ...codes });

	/** @param {string} code */
	const definitionOf = (code) => {
		const definition = Object.hasOwn(registry, code) ? registry[code] : undefined;
		if (definition === undefined) throw new TypeError(`Unknown problem code: ${code}`);
		return definition;
	};

	/** @type {ProblemFactory['typeFor']} */
	const typeFor = (code) => {
		definitionOf(code);
		return `${base}${code}`;
	};

	/** @type {ProblemFactory['create']} */
	const create = (code, overrides = {}) => {
		const definition = definitionOf(code);
		if ((code === 'product_unavailable') !== (overrides.reason !== undefined))
			throw new TypeError('`reason` is required for product_unavailable and allowed only there.');
		return problem({ title: definition.title, status: definition.status, ...overrides, type: `${base}${code}` });
	};

	return Object.freeze({
		baseUri: base,
		codes: registry,
		typeFor,
		codeOf: (uri) => {
			if (typeof uri !== 'string' || !uri.startsWith(base)) return null;
			const code = uri.slice(base.length);
			return Object.hasOwn(registry, code) ? code : null;
		},
		create,
		problem: (input) => {
			if ('code' in input && typeof input.code === 'string') return create(input.code, input);
			return problem(/** @type {ProblemInput} */ (input));
		},
		fromValidation: (errors, options = {}) => {
			const { code = 'validation_failed', ...rest } = options;
			return create(code, { ...rest, errors });
		},
	});
};
