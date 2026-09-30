/**
 * Fields every Website Graph entity carries (PLAN Part E §7).
 * @module
 */
import { commonRef as ref } from '../common.js';

/** Base properties shared by graph entities. */
export const baseProperties = Object.freeze({
	id: ref('opaqueId'),
	websiteId: ref('websiteId'),
	merchantId: ref('merchantId'),
	env: ref('env'),
	createdAt: ref('timestamp'),
	updatedAt: ref('timestamp'),
	schemaVersion: { type: 'integer', minimum: 1, maximum: 10_000 },
});

/** Base required fields. */
export const baseRequired = Object.freeze(['id', 'websiteId', 'env', 'createdAt', 'updatedAt', 'schemaVersion']);

/**
 * Build an entity schema from its own properties.
 * @param {string} $id
 * @param {string} title
 * @param {Record<string, unknown>} properties
 * @param {string[]} [required]
 */
export const entity = ($id, title, properties, required = []) => ({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id,
	title,
	type: 'object',
	required: [...baseRequired, ...required],
	additionalProperties: false,
	properties: { ...baseProperties, ...properties },
});

/**
 * Bounded non-empty string.
 * @param {number} max
 */
export const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });
