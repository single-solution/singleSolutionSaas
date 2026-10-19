/**
 * Product ↔ Portal wire shapes (PLAN 0.4.12): price report, feature report, status response, websites page,
 * revocations and directory (one product, or every connected product). The validators in `validate.js` add the semantic
 * rules (unique keys, dependencies, real timestamps, grace consistency). Notice bodies are checked by `@ss/protocol`
 * (`verifyNotice`).
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';

const draft = 'https://json-schema.org/draft/2020-12/schema';

/** `PUT /v1/product/prices` body (also the `prices` of a connect answer). */
export const priceReportSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.priceReport,
	title: 'Price report',
	type: 'object',
	required: ['version', 'features'],
	additionalProperties: false,
	properties: {
		version: ref('version'),
		features: {
			type: 'array',
			maxItems: 100,
			items: {
				type: 'object',
				required: ['key', 'name', 'description', 'dependsOn', 'millicreditsPerHour'],
				additionalProperties: false,
				properties: {
					key: ref('featureKey'),
					name: ref('name'),
					description: ref('description'),
					dependsOn: ref('featureKeys'),
					millicreditsPerHour: ref('millicredits'),
				},
			},
		},
	},
});

/** `PUT /v1/product/websites/:websiteId/features` body. */
export const featureReportSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.featureReport,
	title: 'Feature report',
	type: 'object',
	required: ['version', 'on', 'adminId', 'adminName'],
	additionalProperties: false,
	properties: {
		version: ref('version'),
		on: ref('featureKeys'),
		adminId: ref('opaqueId'),
		adminName: ref('name'),
	},
});

/** `GET /v1/product/websites/:websiteId/status` answer. */
export const statusResponseSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.statusResponse,
	title: 'Status response',
	type: 'object',
	required: [
		'websiteId',
		'merchantId',
		'merchantName',
		'domain',
		'status',
		'graceEndsAt',
		'todayMillicredits',
		'featuresVersion',
		'validUntil',
	],
	additionalProperties: false,
	properties: {
		websiteId: ref('opaqueId'),
		merchantId: ref('opaqueId'),
		merchantName: ref('name'),
		domain: ref('hostname'),
		status: ref('productStatus'),
		graceEndsAt: { anyOf: [ref('timestamp'), { type: 'null' }] },
		todayMillicredits: ref('millicredits'),
		featuresVersion: ref('count'),
		// optional until every Portal sends it: the Portal's saves of the website's settings (0: none yet)
		settingsVersion: ref('count'),
		// optional until every Portal sends it: the Portal's changes to the website's connections and links (0: none yet)
		connectionsVersion: ref('count'),
		validUntil: ref('timestamp'),
	},
});

/** `GET /v1/product/websites?cursor=` answer (removed products excluded). */
export const websitesPageSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.websitesPage,
	title: 'Websites page',
	type: 'object',
	required: ['items', 'cursor'],
	additionalProperties: false,
	properties: {
		items: {
			type: 'array',
			maxItems: 1000,
			items: {
				type: 'object',
				required: ['websiteId', 'domain', 'merchantId', 'merchantName', 'status'],
				additionalProperties: false,
				properties: {
					websiteId: ref('opaqueId'),
					domain: ref('hostname'),
					merchantId: ref('opaqueId'),
					merchantName: ref('name'),
					status: ref('productStatus'),
				},
			},
		},
		cursor: ref('cursor'),
	},
});

/** `GET /v1/product/revocations?since=` answer. */
export const revocationsSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.revocations,
	title: 'Revocations',
	type: 'object',
	required: ['tokenIds', 'cursor'],
	additionalProperties: false,
	properties: {
		tokenIds: { type: 'array', maxItems: 10_000, items: { type: 'string', minLength: 1, maxLength: 256 } },
		cursor: ref('cursor'),
	},
});

/** `GET /v1/product/directory/:productId` answer. */
export const directorySchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.directory,
	title: 'Directory entry',
	type: 'object',
	required: ['baseUrl'],
	additionalProperties: false,
	properties: { baseUrl: ref('url') },
});

/** `GET /v1/product/directory` answer: every connected product with its name and address, by id. */
export const directoryListSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.directoryList,
	title: 'Directory',
	type: 'object',
	required: ['items'],
	additionalProperties: false,
	properties: {
		items: {
			type: 'array',
			maxItems: 1000,
			items: {
				type: 'object',
				required: ['productId', 'name', 'baseUrl'],
				additionalProperties: false,
				properties: { productId: ref('productId'), name: ref('name'), baseUrl: ref('url') },
			},
		},
	},
});

const MONGODB_URI = '^mongodb(?:\\+srv)?://\\S+$';

/**
 * `GET /v1/product/websites/:websiteId/connections` answer (never cached): the website's database and storage and the
 * product's links. A value that is not set is null.
 */
export const websiteConnectionsSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.websiteConnections,
	title: 'Website connections',
	type: 'object',
	required: ['version', 'database', 'storage', 'links'],
	additionalProperties: false,
	properties: {
		version: ref('count'),
		database: {
			anyOf: [
				{ type: 'null' },
				{
					type: 'object',
					required: ['uri', 'dbName'],
					additionalProperties: false,
					properties: { uri: { type: 'string', maxLength: 4096, pattern: MONGODB_URI }, dbName: ref('databaseName') },
				},
			],
		},
		storage: {
			anyOf: [
				{ type: 'null' },
				{
					type: 'object',
					required: ['bucket', 'region', 'accessKeyId', 'secretAccessKey'],
					additionalProperties: false,
					properties: {
						bucket: { type: 'string', minLength: 1, maxLength: 255 },
						region: { type: 'string', minLength: 1, maxLength: 64 },
						accessKeyId: { type: 'string', minLength: 1, maxLength: 256 },
						secretAccessKey: { type: 'string', minLength: 1, maxLength: 512 },
						endpoint: ref('url'),
						forcePathStyle: { type: 'boolean' },
						prefix: { type: 'string', maxLength: 200 },
						publicBaseUrl: ref('url'),
					},
				},
			],
		},
		links: {
			type: 'object',
			required: ['out', 'in'],
			additionalProperties: false,
			properties: {
				out: {
					type: 'array',
					maxItems: 20,
					items: {
						type: 'object',
						required: ['to', 'token', 'scopes'],
						additionalProperties: false,
						properties: {
							to: ref('productId'),
							token: { type: 'string', minLength: 1, maxLength: 4096 },
							scopes: { type: 'array', maxItems: 40, uniqueItems: true, items: ref('linkScope') },
						},
					},
				},
				in: {
					type: 'array',
					maxItems: 20,
					items: {
						type: 'object',
						required: ['from', 'scopes'],
						additionalProperties: false,
						properties: {
							from: ref('productId'),
							scopes: { type: 'array', maxItems: 40, uniqueItems: true, items: ref('linkScope') },
						},
					},
				},
			},
		},
	},
});

/** `PUT /v1/product/websites/:websiteId/connections/:name/health` body: whether the delivered value worked. */
export const connectionHealthSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.connectionHealth,
	title: 'Connection health',
	type: 'object',
	required: ['version', 'ok'],
	additionalProperties: false,
	properties: {
		version: ref('count'),
		ok: { type: 'boolean' },
		message: { type: 'string', maxLength: 300 },
	},
});
