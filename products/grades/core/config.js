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
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'string':
			return typeof value === 'string';
		case 'boolean':
			return typeof value === 'boolean';
		case 'array':
			return Array.isArray(value);
		case 'object':
			return value !== null && typeof value === 'object' && !Array.isArray(value);
		default:
			return value !== undefined;
	}
};

/**
 * Top-level defaults of a feature schema.
 * @param {{ properties?: Record<string, { default?: unknown }> }} schema
 * @returns {Record<string, unknown>}
 */
export const defaultsOf = (schema) =>
	Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, node]) => [key, structuredClone(node.default)]));

/**
 * Defaults overlaid with the entitlement's values (only keys the schema declares, with the declared type).
 * @param {{ properties?: Record<string, { default?: unknown, type?: string }> }} schema
 * @param {Record<string, unknown> | null | undefined} values
 * @returns {Record<string, any>}
 */
export const effectiveConfig = (schema, values) => {
	const out = defaultsOf(schema);
	for (const [key, node] of Object.entries(schema.properties ?? {})) {
		const value = values?.[key];
		if (value !== undefined && hasType(value, node.type)) out[key] = value;
	}
	return out;
};
