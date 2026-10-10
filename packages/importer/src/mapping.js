/**
 * Source mappings (PLAN 0.8.10 Migration). A mapping says, for one schema family of store databases, which source
 * collection becomes which product's import collection, in import order, and how one source document becomes one
 * record of the product's own shape. Mappings are the only place store-specific names may appear (0.13).
 *
 * Ids are deterministic: `<prefix>_<the source ObjectId's 24 hex digits>` (accepted by `@ss/contracts`' id pattern), so
 * references and old links map without a lookup and every run gives the same ids. Records with the same `mergeKey`
 * merge into the oldest (the lowest ObjectId, which is the oldest); the others are recorded in the id map.
 * @module
 */
import { isId } from '@ss/contracts';

/**
 * What `map` gets besides the document.
 * @typedef {object} MapContext
 * @property {(prefix: string, sourceId: unknown) => string} id the deterministic id of a source document
 * @property {(source: string, sourceId: unknown) => string | null} ref the id an earlier step gave a source document of
 *   `source` (merges followed), or null when it was not imported
 */

/**
 * One import step: a source collection into one product's import collection.
 * @typedef {object} MappingStep
 * @property {string} product the product id (`accounts`, `ecommerce`, `chat`, `growth` …)
 * @property {string} collection the product's import collection (`POST /v1/import/<collection>`)
 * @property {string} source the source collection, read only
 * @property {string} prefix the id prefix of the records (`usr`, `prd`, …)
 * @property {Record<string, unknown>} [filter] which source documents (default all)
 * @property {(doc: Record<string, any>) => string | null} [mergeKey] documents with the same key become one record
 * @property {(doc: Record<string, any>, ctx: MapContext) => Record<string, unknown> | null} map the record in the
 *   product's own shape with its `id`, or null to leave the document out
 * @property {string} [countPath] a count route of the product (K4) that `verify` also compares, e.g. `/v1/notes/count`
 */

/**
 * @typedef {object} Mapping
 * @property {string} name
 * @property {string} description
 * @property {ReadonlyArray<MappingStep>} steps in import order
 */

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const PRODUCT = /^[a-z][a-z0-9-]{1,30}$/;
const COLLECTION = /^[a-z][a-z0-9_]{0,40}$/;
const SOURCE = /^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/;
const PREFIX = /^[a-z]{2,8}$/;
const COUNT_PATH = /^\/v1\/[a-z0-9/_-]+\/count$/;

/**
 * Check a mapping and freeze it.
 * @param {Mapping} mapping
 * @returns {Readonly<Mapping>}
 */
export const defineMapping = (mapping) => {
	if (typeof mapping !== 'object' || mapping === null) throw new TypeError('a mapping is an object');
	if (!NAME.test(mapping.name)) throw new TypeError(`mapping names match ${NAME}`);
	if (!Array.isArray(mapping.steps) || mapping.steps.length === 0) throw new TypeError(`mapping ${mapping.name} has no steps`);
	const targets = new Set();
	for (const [index, step] of mapping.steps.entries()) {
		const where = `mapping ${mapping.name} step ${index + 1}`;
		if (!PRODUCT.test(step.product)) throw new TypeError(`${where}: product is a product id`);
		if (!COLLECTION.test(step.collection)) throw new TypeError(`${where}: collection is an import collection name`);
		if (!SOURCE.test(step.source)) throw new TypeError(`${where}: source is a collection name`);
		if (!PREFIX.test(step.prefix)) throw new TypeError(`${where}: prefix is 2–8 lowercase letters`);
		if (typeof step.map !== 'function') throw new TypeError(`${where}: map is a function`);
		if (step.mergeKey !== undefined && typeof step.mergeKey !== 'function')
			throw new TypeError(`${where}: mergeKey is a function`);
		if (step.countPath !== undefined && !COUNT_PATH.test(step.countPath))
			throw new TypeError(`${where}: countPath is /v1/<list>/count`);
		const target = `${step.product}.${step.collection}`;
		if (targets.has(target)) throw new TypeError(`${where}: ${target} is imported by two steps`);
		targets.add(target);
	}
	return Object.freeze({ ...mapping, steps: Object.freeze(mapping.steps.map((step) => Object.freeze({ ...step }))) });
};

/**
 * The 24 hex digits of a source id (an ObjectId, or its hex text).
 * @param {unknown} sourceId
 * @returns {string}
 */
export const hexOf = (sourceId) => {
	const text =
		typeof sourceId === 'string'
			? sourceId
			: typeof sourceId === 'object' && sourceId !== null && typeof (/** @type {any} */ (sourceId).toHexString) === 'function'
				? /** @type {any} */ (sourceId).toHexString()
				: '';
	if (!/^[0-9a-f]{24}$/i.test(text)) throw new TypeError(`a source id is an ObjectId: ${String(sourceId)}`);
	return text.toLowerCase();
};

/**
 * The deterministic id of a source document: `<prefix>_<24 hex digits>`.
 * @param {string} prefix
 * @param {unknown} sourceId
 * @returns {string}
 */
export const legacyId = (prefix, sourceId) => {
	const id = `${prefix}_${hexOf(sourceId)}`;
	if (!PREFIX.test(prefix) || !isId(id, prefix)) throw new TypeError(`not an id: ${id}`);
	return id;
};
