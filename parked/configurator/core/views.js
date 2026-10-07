/**
 * API views of stored configurators (pure).
 * - `configuratorView`: the merchant's definition (server keys, dashboard).
 * - `publicView`: what browsers get — the published, catalog-linked schema made concrete, parseable again by
 *   `parseSchema` (so the headless resolver can run it locally), with stock counts reduced to in stock (1) / out of
 *   stock (0) / not tracked (null).
 * @module
 */

/** @typedef {import('./schema.js').Schema} Schema */
/**
 * @typedef {object} ConfiguratorRecord
 * @property {string} id
 * @property {string | null} key
 * @property {string} name
 * @property {'draft' | 'published' | 'archived'} status
 * @property {number} version
 * @property {Schema} schema
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} publishedAt
 */

/** @param {number | null} stock */
const stockFlag = (stock) => (stock === null ? null : stock > 0 ? 1 : 0);

/**
 * @param {ConfiguratorRecord} record
 */
export const configuratorView = (record) => ({
	id: record.id,
	key: record.key,
	name: record.name,
	status: record.status,
	version: record.version,
	createdAt: record.createdAt,
	updatedAt: record.updatedAt,
	publishedAt: record.publishedAt,
	schema: record.schema,
});

/**
 * List entry (no schema).
 * @param {ConfiguratorRecord} record
 */
export const summaryView = (record) => ({
	id: record.id,
	key: record.key,
	name: record.name,
	status: record.status,
	version: record.version,
	groups: record.schema.groups.map((group) => group.key),
	source: record.schema.source,
	updatedAt: record.updatedAt,
});

/**
 * @param {ConfiguratorRecord} record
 * @param {Schema} concrete the schema after `linkSchema` (or the stored one for standalone configurators)
 */
export const publicView = (record, concrete) => ({
	id: record.id,
	key: record.key,
	name: record.name,
	version: record.version,
	itemId: record.schema.source.type === 'catalog' ? record.schema.source.itemId : null,
	schema: {
		...concrete,
		source: { type: /** @type {const} */ ('standalone') },
		groups: concrete.groups.map((group) => ({
			...group,
			options: group.options.map((option) => ({ ...option, stock: stockFlag(option.stock) })),
		})),
		combinations: concrete.combinations.map((combination) => ({ ...combination, stock: stockFlag(combination.stock) })),
	},
});
