/**
 * Request validation (pure): every body and query value is checked and capped before use. Problems are
 * `{ path, code }` pairs (JSON Pointer + stable code); the API turns them into RFC 9457 `validation_failed`.
 * @module
 */
import { isId, isKey, isObject } from './text.js';

/** @typedef {Array<{ path: string, code: string }>} Problems */

/** Longest merchant note on an assignment or unit. */
export const MAX_NOTE = 500;
/** Longest inspector name. */
export const MAX_INSPECTOR = 80;
/** Assignments per batch request. */
export const MAX_BATCH = 100;

/**
 * Unknown top-level fields.
 * @param {Record<string, unknown>} body
 * @param {readonly string[]} allowed
 * @param {string} [prefix]
 * @returns {Problems}
 */
const unknownFields = (body, allowed, prefix = '') =>
	Object.keys(body)
		.filter((key) => !allowed.includes(key))
		.map((key) => ({ path: `${prefix}/${key}`, code: 'field_unknown' }));

/**
 * @param {unknown} value
 * @param {number} max
 */
const isText = (value, max) => typeof value === 'string' && value.length <= max;

/**
 * @param {Record<string, unknown>} body
 * @param {string} field
 * @param {(value: unknown) => boolean} test
 * @param {string} code
 * @param {string} [prefix]
 * @returns {Problems}
 */
const optional = (body, field, test, code, prefix = '') =>
	body[field] === undefined || test(body[field]) ? [] : [{ path: `${prefix}/${field}`, code }];

/**
 * A tier assignment `{ itemId, variantId?, tier, note? }`.
 * @param {unknown} body
 * @param {string} [prefix]
 * @returns {Problems}
 */
export const validateAssignment = (body, prefix = '') => {
	if (!isObject(body)) return [{ path: prefix || '/', code: 'body_invalid' }];
	return [
		...unknownFields(body, ['itemId', 'variantId', 'tier', 'note'], prefix),
		...(isId(body.itemId) ? [] : [{ path: `${prefix}/itemId`, code: 'id_invalid' }]),
		...optional(body, 'variantId', (v) => v === null || isId(v), 'id_invalid', prefix),
		...(isKey(body.tier) ? [] : [{ path: `${prefix}/tier`, code: 'tier_invalid' }]),
		...optional(body, 'note', (v) => v === null || isText(v, MAX_NOTE), 'note_invalid', prefix),
	];
};

/**
 * `{ assignments: [...] }` with 1..100 entries.
 * @param {unknown} body
 * @returns {Problems}
 */
export const validateBatch = (body) => {
	if (!isObject(body)) return [{ path: '/', code: 'body_invalid' }];
	const list = body.assignments;
	if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH)
		return [{ path: '/assignments', code: 'assignments_invalid' }];
	return [
		...unknownFields(body, ['assignments']),
		...list.flatMap((entry, index) => validateAssignment(entry, `/assignments/${index}`)),
	];
};

/**
 * A new graded unit `{ itemId, variantId?, serial?, tier?, note?, available? }`.
 * @param {unknown} body
 * @returns {Problems}
 */
export const validateUnit = (body) => {
	if (!isObject(body)) return [{ path: '/', code: 'body_invalid' }];
	return [
		...unknownFields(body, ['itemId', 'variantId', 'serial', 'tier', 'note', 'available']),
		...(isId(body.itemId) ? [] : [{ path: '/itemId', code: 'id_invalid' }]),
		...optional(body, 'variantId', (v) => v === null || isId(v), 'id_invalid'),
		...optional(body, 'serial', (v) => v === null || isId(v), 'serial_invalid'),
		...optional(body, 'tier', (v) => v === null || isKey(v), 'tier_invalid'),
		...optional(body, 'note', (v) => v === null || isText(v, MAX_NOTE), 'note_invalid'),
		...optional(body, 'available', (v) => typeof v === 'boolean', 'flag_invalid'),
	];
};

/**
 * A unit change (JSON Merge Patch of `tier`, `note`, `serial`, `available`).
 * @param {unknown} body
 * @returns {Problems}
 */
export const validateUnitPatch = (body) => {
	if (!isObject(body) || Object.keys(body).length === 0) return [{ path: '/', code: 'body_invalid' }];
	return [
		...unknownFields(body, ['tier', 'note', 'serial', 'available']),
		...optional(body, 'tier', (v) => v === null || isKey(v), 'tier_invalid'),
		...optional(body, 'note', (v) => v === null || isText(v, MAX_NOTE), 'note_invalid'),
		...optional(body, 'serial', (v) => v === null || isId(v), 'serial_invalid'),
		...optional(body, 'available', (v) => typeof v === 'boolean', 'flag_invalid'),
	];
};

/**
 * Shared fields of inspection create and update.
 * @param {Record<string, unknown>} body
 * @returns {Problems}
 */
const inspectionFields = (body) => [
	...optional(body, 'results', (v) => Array.isArray(v) && v.length <= 50, 'results_invalid'),
	...optional(
		body,
		'inspector',
		(v) => v === null || (isText(v, MAX_INSPECTOR) && String(v).trim() !== ''),
		'inspector_invalid',
	),
	...optional(body, 'complete', (v) => typeof v === 'boolean', 'flag_invalid'),
	...optional(body, 'tier', (v) => v === null || isKey(v), 'tier_invalid'),
];

/**
 * A new inspection `{ unitId, checklist?, results?, inspector?, complete?, tier? }`.
 * @param {unknown} body
 * @returns {Problems}
 */
export const validateInspection = (body) => {
	if (!isObject(body)) return [{ path: '/', code: 'body_invalid' }];
	return [
		...unknownFields(body, ['unitId', 'checklist', 'results', 'inspector', 'complete', 'tier']),
		...(isId(body.unitId) ? [] : [{ path: '/unitId', code: 'id_invalid' }]),
		...optional(body, 'checklist', isKey, 'checklist_invalid'),
		...inspectionFields(body),
	];
};

/**
 * An inspection update `{ results?, inspector?, complete?, tier? }`.
 * @param {unknown} body
 * @returns {Problems}
 */
export const validateInspectionPatch = (body) => {
	if (!isObject(body) || Object.keys(body).length === 0) return [{ path: '/', code: 'body_invalid' }];
	return [...unknownFields(body, ['results', 'inspector', 'complete', 'tier']), ...inspectionFields(body)];
};

/**
 * A photo upload slot `{ item, contentType, size }` within the inspection settings.
 * @param {unknown} body
 * @param {{ allowed_types: string[], max_photo_bytes: number }} config
 * @returns {Problems}
 */
export const validatePhotoUpload = (body, config) => {
	if (!isObject(body)) return [{ path: '/', code: 'body_invalid' }];
	return [
		...unknownFields(body, ['item', 'contentType', 'size']),
		...(isKey(body.item) ? [] : [{ path: '/item', code: 'item_invalid' }]),
		...(typeof body.contentType === 'string' && config.allowed_types.includes(body.contentType)
			? []
			: [{ path: '/contentType', code: 'type_not_allowed' }]),
		...(Number.isInteger(body.size) && Number(body.size) > 0 && Number(body.size) <= config.max_photo_bytes
			? []
			: [{ path: '/size', code: 'size_invalid' }]),
	];
};

/**
 * A report link request `{ days? }` (1..the configured lifetime).
 * @param {unknown} body
 * @param {number} maxDays
 * @returns {Problems}
 */
export const validateReportLink = (body, maxDays) => {
	if (body === undefined || body === null) return [];
	if (!isObject(body)) return [{ path: '/', code: 'body_invalid' }];
	return [
		...unknownFields(body, ['days']),
		...optional(body, 'days', (v) => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= maxDays, 'days_invalid'),
	];
};

/**
 * A comma-separated id list from a query (`ids=a,b`), 1..max unique ids; null when malformed.
 * @param {unknown} value
 * @param {number} max
 * @returns {string[] | null}
 */
export const idList = (value, max) => {
	if (typeof value !== 'string' || value.length === 0 || value.length > max * 130) return null;
	const ids = [...new Set(value.split(','))];
	return ids.length <= max && ids.every(isId) ? ids : null;
};
