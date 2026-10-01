/**
 * Request validation (pure): every API body is checked and capped here before anything else runs. Field problems are
 * `{ path, code }` (JSON pointers); the routes turn them into RFC 9457 `validation_failed`.
 * @module
 */
import { LIMITS } from './limits.js';
import { MAX_SEARCH } from './urlSync.js';

/** @typedef {{ path: string, code: string, message?: string }} FieldProblem */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A configurator reference: its id (`cfg_…`) or its key. */
export const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * A selection object: at most `LIMITS.groups * 2` keys, values of bounded size.
 * @param {unknown} value
 * @param {string} path
 * @returns {FieldProblem[]}
 */
const selectionProblems = (value, path) => {
	if (value === undefined) return [];
	if (!isObject(value)) return [{ path, code: 'type', message: 'must be an object' }];
	const entries = Object.entries(value);
	if (entries.length > LIMITS.groups * 2) return [{ path, code: 'too_many' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const [key, item] of entries) {
		const at = `${path}/${key}`;
		if (key.length > LIMITS.keyLength) problems.push({ path: at, code: 'too_long' });
		else if (item === null || typeof item === 'number' || typeof item === 'boolean') continue;
		else if (typeof item === 'string') {
			if (item.length > LIMITS.textLength) problems.push({ path: at, code: 'too_long' });
		} else if (Array.isArray(item)) {
			if (
				item.length > LIMITS.options ||
				item.some((entry) => typeof entry !== 'string' || entry.length > LIMITS.optionKeyLength)
			)
				problems.push({ path: at, code: 'invalid', message: 'a list of option keys' });
		} else problems.push({ path: at, code: 'type' });
	}
	return problems;
};

/**
 * @param {unknown} value
 * @param {string} path
 * @param {number} max
 * @returns {FieldProblem[]}
 */
const quantityProblems = (value, path, max) =>
	value === undefined ||
	(Number.isSafeInteger(value) && /** @type {number} */ (value) >= 1 && /** @type {number} */ (value) <= max)
		? []
		: [{ path, code: 'range', message: `an integer from 1 to ${max}` }];

/** @param {unknown} value @returns {FieldProblem[]} */
const referenceProblems = (value) =>
	typeof value === 'string' && REFERENCE.test(value)
		? []
		: [{ path: '/configurator', code: 'required', message: 'a configurator id or key' }];

/** @param {unknown} value @returns {FieldProblem[]} */
const searchProblems = (value) =>
	value === undefined || (typeof value === 'string' && value.length <= MAX_SEARCH) ? [] : [{ path: '/search', code: 'invalid' }];

/**
 * `POST /v1/evaluations`.
 * @param {unknown} body
 * @param {{ maxQuantity: number }} limits
 */
export const validateEvaluation = (body, { maxQuantity }) => {
	if (!isObject(body)) return [{ path: '', code: 'type', message: 'must be an object' }];
	return [
		...referenceProblems(body.configurator),
		...selectionProblems(body.selection, '/selection'),
		...(body.changed === undefined ||
		body.changed === null ||
		(typeof body.changed === 'string' && body.changed.length <= LIMITS.keyLength)
			? []
			: [{ path: '/changed', code: 'invalid' }]),
		...quantityProblems(body.quantity, '/quantity', maxQuantity),
		...searchProblems(body.search),
	];
};

/**
 * `POST /v1/quotes`.
 * @param {unknown} body
 * @param {{ maxQuantity: number }} limits
 */
export const validateQuote = (body, { maxQuantity }) => {
	if (!isObject(body)) return [{ path: '', code: 'type', message: 'must be an object' }];
	return [
		...referenceProblems(body.configurator),
		...(isObject(body.selection)
			? selectionProblems(body.selection, '/selection')
			: [{ path: '/selection', code: 'required' }]),
		...quantityProblems(body.quantity, '/quantity', maxQuantity),
	];
};

/**
 * `POST /v1/url-params:build` (selection → query) and `:parse` (query → selection).
 * @param {unknown} body
 * @param {'build' | 'parse'} mode
 */
export const validateUrlParams = (body, mode) => {
	if (!isObject(body)) return [{ path: '', code: 'type', message: 'must be an object' }];
	return [
		...referenceProblems(body.configurator),
		...(mode === 'build' ? selectionProblems(body.selection ?? {}, '/selection') : []),
		...(mode === 'parse' && typeof body.search !== 'string'
			? [{ path: '/search', code: 'required' }]
			: searchProblems(body.search)),
	];
};

/** Fields a create / update may set besides the schema itself. */
export const STATUSES = Object.freeze(/** @type {const} */ (['draft', 'published']));

/**
 * The status and version fields of a create / update body.
 * @param {unknown} body
 * @param {{ update: boolean }} options updates need the current `version` (optimistic concurrency)
 * @returns {FieldProblem[]}
 */
export const validateLifecycle = (body, { update }) => {
	if (!isObject(body)) return [{ path: '', code: 'type', message: 'must be an object' }];
	return [
		...(body.status === undefined || STATUSES.includes(body.status)
			? []
			: [{ path: '/status', code: 'enum', message: STATUSES.join(', ') }]),
		...(update && !(Number.isSafeInteger(body.version) && body.version >= 1)
			? [{ path: '/version', code: 'required', message: 'the current version (optimistic concurrency)' }]
			: []),
	];
};

/** Schema fields an update may replace (top level). */
export const SCHEMA_FIELDS = Object.freeze([
	'key',
	'name',
	'description',
	'source',
	'groups',
	'rules',
	'combinations',
	'pricing',
]);
