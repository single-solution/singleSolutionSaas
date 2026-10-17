/**
 * Source mappings (PLAN 0.8.10 Migration). A mapping says, for one schema family of store databases, which source
 * collections become which products' import collections, in import order, and how a source document becomes records of
 * the product's own shape. Mappings are the only place store-specific names may appear (0.13).
 *
 * The framework covers what the stores need (IMP-21):
 * - several steps per target: two source collections can feed one import collection (staff and customers into users);
 * - one-to-many steps: `map` may give several records for one document (the messages a conversation embeds);
 * - merges: records with the same `mergeKey` (across every step of a target) become one; the oldest is kept, or the
 *   step's `merge` reducer combines them (a union of category ids, the customer's id winning over the staff's);
 * - lookup tables: a step notes keys of its records (`lookups`, a slug for example) and later steps find the record by
 *   them (`ctx.lookup`), since the stores refer by slug where the products refer by id;
 * - a per-collection key (`key`, default `id`): `customerId`, `userId`, `key`, `day` + `part` …;
 * - verification sums (`sums`): what each record adds to the totals `ss-import verify` compares with the product's;
 * - the website's settings and lists (`settings`), read from the store and applied through the products' settings API.
 *
 * Ids are deterministic: `<prefix>_<the source ObjectId's 24 hex digits>` (accepted by `@ss/contracts`' id pattern), so
 * references and old links map without a lookup and every run gives the same ids.
 * @module
 */
import { isId } from '@ss/contracts';
import { DEFAULT_KEY, KEY_FIELD } from './keys.js';

/**
 * What `map`, `merge` and `mergeKey` get besides the document.
 * @typedef {object} MapContext
 * @property {(prefix: string, sourceId: unknown) => string} id the deterministic id of a source document
 * @property {(source: string, sourceId: unknown) => string | null} ref the key an earlier step gave a source document of
 *   `source` (merges followed; the first step that read the document wins), or null when it was not imported
 * @property {(table: string, key: string) => string | null} lookup the key of the record an earlier step noted under
 *   `key` in a lookup table, or null
 */

/**
 * One import step: a source collection into one product's import collection.
 * @typedef {object} MappingStep
 * @property {string} product the product id (`accounts`, `ecommerce`, `chat`, `growth` …)
 * @property {string} collection the product's import collection (`POST /v1/import/<collection>`)
 * @property {string} source the source collection, read only
 * @property {string} prefix the id prefix of the records (`usr`, `prd`, …)
 * @property {Record<string, unknown>} [filter] which source documents (default all)
 * @property {ReadonlyArray<string>} [key] the fields the product finds the records by (default `['id']`; every step of
 *   one target names the same)
 * @property {(doc: Record<string, any>, ctx: MapContext) => Record<string, unknown> | ReadonlyArray<Record<string, unknown>> | null} map
 *   the record (or records) in the product's own shape with its key, or null to leave the document out
 * @property {(doc: Record<string, any>, record: Record<string, unknown>) => string | null} [mergeKey] records with the
 *   same key (across the target's steps) become one
 * @property {(kept: Record<string, unknown>, next: Record<string, unknown>, ctx: MapContext) => Record<string, unknown>} [merge]
 *   combines a record into the one kept (default: the kept one stays as it is); the result may take `next`'s key
 * @property {Record<string, (record: Record<string, unknown>, doc: Record<string, any>) => string | ReadonlyArray<string> | null>} [lookups]
 *   lookup tables this step fills: table → the keys a record is found by
 * @property {(record: Record<string, unknown>) => Record<string, number>} [sums] what the record adds to the product's
 *   verification totals (`GET /v1/import/status` `totals`)
 * @property {string} [countPath] a count route of the product (K4) that `verify` also compares, e.g. `/v1/notes/count`
 */

/**
 * The website's settings in one product, written through its settings API (K1): settings by `<feature>.<setting>`, and
 * whole lists. `format` is not sent: the Format is the website's, set once in the Portal; a plan that carries one is
 * listed as refused.
 * @typedef {{ format?: Record<string, unknown>, settings?: Record<string, unknown>, lists?: Record<string, unknown> }} ProductSettings
 */
/** @typedef {Record<string, ProductSettings>} SettingsPlan by product id */

/**
 * @typedef {object} Mapping
 * @property {string} name
 * @property {string} description
 * @property {ReadonlyArray<MappingStep>} steps in import order
 * @property {(db: import('./read.js').SourceDb) => Promise<SettingsPlan>} [settings] the website's settings, read from
 *   the store (the per-store settings table fills in the rest by hand)
 */

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const PRODUCT = /^[a-z][a-z0-9-]{1,30}$/;
const COLLECTION = /^[a-z][a-z0-9_]{0,40}$/;
const SOURCE = /^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/;
const PREFIX = /^[a-z]{2,8}$/;
const COUNT_PATH = /^\/v1\/[a-z0-9/_-]+\/count$/;
const TABLE = /^[a-z][a-z0-9_-]{0,60}$/;

/**
 * Check a mapping and freeze it.
 * @param {Mapping} mapping
 * @returns {Readonly<Mapping>}
 */
export const defineMapping = (mapping) => {
	if (typeof mapping !== 'object' || mapping === null) throw new TypeError('a mapping is an object');
	if (!NAME.test(mapping.name)) throw new TypeError(`mapping names match ${NAME}`);
	if (!Array.isArray(mapping.steps) || mapping.steps.length === 0) throw new TypeError(`mapping ${mapping.name} has no steps`);
	if (mapping.settings !== undefined && typeof mapping.settings !== 'function')
		throw new TypeError(`mapping ${mapping.name}: settings is a function`);
	/** @type {Map<string, string>} target → its key */
	const keys = new Map();
	for (const [index, step] of mapping.steps.entries()) {
		const where = `mapping ${mapping.name} step ${index + 1}`;
		if (!PRODUCT.test(step.product)) throw new TypeError(`${where}: product is a product id`);
		if (!COLLECTION.test(step.collection)) throw new TypeError(`${where}: collection is an import collection name`);
		if (!SOURCE.test(step.source)) throw new TypeError(`${where}: source is a collection name`);
		if (!PREFIX.test(step.prefix)) throw new TypeError(`${where}: prefix is 2–8 lowercase letters`);
		if (typeof step.map !== 'function') throw new TypeError(`${where}: map is a function`);
		for (const name of /** @type {const} */ (['mergeKey', 'merge', 'sums']))
			if (step[name] !== undefined && typeof step[name] !== 'function') throw new TypeError(`${where}: ${name} is a function`);
		if (step.merge !== undefined && step.mergeKey === undefined) throw new TypeError(`${where}: merge needs a mergeKey`);
		if (step.countPath !== undefined && !COUNT_PATH.test(step.countPath))
			throw new TypeError(`${where}: countPath is /v1/<list>/count`);
		const key = step.key ?? DEFAULT_KEY;
		if (!Array.isArray(key) || key.length === 0 || key.length > 4 || !key.every((field) => KEY_FIELD.test(field)))
			throw new TypeError(`${where}: key is 1–4 top-level field names`);
		if (step.lookups !== undefined) {
			if (typeof step.lookups !== 'object' || step.lookups === null)
				throw new TypeError(`${where}: lookups maps table names to functions`);
			for (const [table, of] of Object.entries(step.lookups))
				if (!TABLE.test(table) || typeof of !== 'function')
					throw new TypeError(`${where}: lookups maps table names to functions`);
		}
		const target = `${step.product}.${step.collection}`;
		const named = keys.get(target);
		if (named !== undefined && named !== key.join(','))
			throw new TypeError(`${where}: every step of ${target} names the same key`);
		keys.set(target, key.join(','));
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
