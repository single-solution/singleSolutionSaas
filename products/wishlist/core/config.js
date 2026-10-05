/**
 * Effective element configuration (pure). The feature schemas in `schemas/` are the single source of truth for
 * defaults and bounds; the signed entitlement document carries the merchant's resolved values. `effectiveConfig`
 * takes a schema's top-level `default`s and overlays the document's values, dropping values of the wrong JSON type, so
 * no constant is duplicated in code.
 * @module
 */

/**
 * @param {unknown} value
 * @param {string | undefined} type JSON Schema type
 */
const hasType = (value, type) => {
	switch (type) {
		case 'integer':
			return Number.isInteger(value);
		case 'string':
			return typeof value === 'string';
		case 'boolean':
			return typeof value === 'boolean';
		case 'array':
			return Array.isArray(value);
		default:
			return value !== undefined;
	}
};

/**
 * Defaults overlaid with the entitlement's values (only keys the schema declares, with the declared type and, for
 * enums, an allowed value).
 * @param {{ properties?: Record<string, { default?: unknown, type?: string, enum?: unknown[] }> }} schema
 * @param {Record<string, unknown> | null | undefined} values
 * @returns {Record<string, any>}
 */
export const effectiveConfig = (schema, values) => {
	/** @type {Record<string, any>} */
	const out = {};
	for (const [key, node] of Object.entries(schema.properties ?? {})) {
		const value = values?.[key];
		const valid = value !== undefined && hasType(value, node.type) && (!node.enum || node.enum.includes(value));
		out[key] = structuredClone(valid ? value : node.default);
	}
	return out;
};
