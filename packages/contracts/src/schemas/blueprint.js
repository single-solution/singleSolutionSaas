/**
 * The website Setup sheet, `ss.blueprint/1` (owner request 2026-10-14; design `audit/design/website-blueprint.md`).
 *
 * - **Product blueprint** (each product's `GET /v1/blueprint?websiteId=`, a Portal call answered by `@ss/app-kit`):
 *   the product's part for one website: `{ productId, name, version, status, docs, business, install, features,
 *   shared, connections, widgets, staffPermissions, events, checklist, summaries }`. Features carry their settings
 *   with values (`default: true` while the website has not saved its own) and their lists summarized, but only while
 *   the feature is on. Connections show their state only: `set` and `state`, never a value, its last characters or a
 *   test message.
 * - **Blueprint** (the Portal's sheet): `{ schema: 'ss.blueprint/1', generatedAt, website, access, products, share? }`.
 *   Each product is its blueprint plus `reachable: true`, the browser token and install snippet in `install`, and
 *   `serverToken: { issued }` (the value is never in a sheet); a product that did not answer in time is
 *   `{ productId, name, reachable: false, reason }`. `share` describes a copy opened from a share link: what it
 *   leaves out (`values: false` drops every setting's `value`, `install: false` the browser token and snippet).
 * @module
 */
import { deepFreeze } from '../util.js';
import { PATTERNS, commonRef as ref } from './common.js';
import { SCHEMA_IDS } from './schema-ids.js';

const draft = 'https://json-schema.org/draft/2020-12/schema';

/** The `schema` member of every Setup sheet. */
export const BLUEPRINT_SCHEMA = 'ss.blueprint/1';

/** Why a product is missing from a sheet. */
export const BLUEPRINT_UNREACHABLE_REASONS = Object.freeze(
	/** @type {const} */ (['timeout', 'unreachable', 'refused', 'invalid']),
);

/** Connection kinds and states (as the kit keeps them). */
const CONNECTION_KINDS = Object.freeze(['database', 'storage', 'secret', 'token']);
const CONNECTION_STATES = Object.freeze(['connected', 'not_connected', 'test_failed']);

const text = (/** @type {number} */ max) => ({ type: 'string', maxLength: max });
const nullable = (/** @type {Record<string, unknown>} */ schema) => ({ anyOf: [schema, { type: 'null' }] });

/** One setting with its value; `value` is absent in a shared copy without values. */
const setting = {
	type: 'object',
	required: ['key', 'title', 'default'],
	additionalProperties: false,
	properties: {
		key: { type: 'string', pattern: PATTERNS.settingKey },
		title: text(120),
		value: {},
		default: { type: 'boolean', description: 'True while the website has not saved a value of its own.' },
	},
};

/** A list setting, summarized (`count`: entries of a list that is an array). */
const list = {
	type: 'object',
	required: ['name', 'title', 'summary', 'count'],
	additionalProperties: false,
	properties: {
		name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,40}$' },
		title: text(120),
		summary: text(300),
		count: nullable({ type: 'integer', minimum: 0 }),
	},
};

/** Members of a product's part, shared by the product blueprint and the sheet. */
const productProperties = {
	productId: ref('productId'),
	name: ref('name'),
	version: ref('semver'),
	status: ref('productStatus'),
	docs: {
		type: 'object',
		required: ['guide', 'openapi'],
		additionalProperties: false,
		properties: { guide: ref('url'), openapi: nullable(ref('url')) },
	},
	business: {
		type: 'object',
		required: ['found', 'fetchedAt', 'name', 'country', 'timeZone'],
		additionalProperties: false,
		properties: {
			found: { type: 'boolean' },
			fetchedAt: nullable(ref('timestamp')),
			name: nullable(text(200)),
			country: nullable(ref('country')),
			timeZone: nullable(text(64)),
		},
	},
	install: {
		type: 'object',
		required: ['scriptUrl', 'installed', 'lastSeenAt'],
		additionalProperties: false,
		properties: {
			scriptUrl: nullable(ref('url')),
			installed: nullable({ type: 'boolean' }),
			lastSeenAt: nullable(ref('timestamp')),
			browserToken: { type: 'string', minLength: 1, maxLength: 4096 },
			snippet: nullable(text(8192)),
		},
	},
	features: {
		type: 'array',
		maxItems: 100,
		items: {
			type: 'object',
			required: ['key', 'title', 'description', 'on', 'dependsOn', 'settings', 'lists'],
			additionalProperties: false,
			properties: {
				key: ref('featureKey'),
				title: ref('name'),
				description: ref('description'),
				on: { type: 'boolean' },
				dependsOn: ref('featureKeys'),
				settings: { type: 'array', maxItems: 100, items: setting },
				lists: { type: 'array', maxItems: 50, items: list },
			},
		},
	},
	shared: {
		type: 'array',
		maxItems: 50,
		items: {
			type: 'object',
			required: ['key', 'title', 'features', 'settings'],
			additionalProperties: false,
			properties: {
				key: ref('featureKey'),
				title: ref('name'),
				features: ref('featureKeys'),
				settings: { type: 'array', maxItems: 100, items: setting },
			},
		},
	},
	connections: {
		type: 'array',
		maxItems: 100,
		items: {
			type: 'object',
			required: ['key', 'title', 'kind', 'neededBy', 'needed', 'set', 'state', 'testedAt'],
			additionalProperties: false,
			properties: {
				key: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
				title: text(120),
				kind: { type: 'string', enum: [...CONNECTION_KINDS] },
				neededBy: ref('featureKeys'),
				needed: { type: 'boolean', description: 'A feature that is on needs it.' },
				set: { type: 'boolean', description: 'A value is saved (the value itself is never shown).' },
				state: { type: 'string', enum: [...CONNECTION_STATES] },
				testedAt: nullable(ref('timestamp')),
			},
		},
	},
	widgets: {
		type: 'array',
		maxItems: 50,
		items: {
			type: 'object',
			required: ['key', 'kind', 'features', 'on', 'ready'],
			additionalProperties: false,
			properties: {
				key: ref('widgetKey'),
				kind: { type: 'string', enum: ['visitor', 'admin'] },
				features: { type: 'array', minItems: 1, maxItems: 20, items: ref('featureKey') },
				on: { type: 'boolean', description: 'One of its features is on.' },
				ready: { type: 'boolean', description: 'On, served for the website and the merchant database connected.' },
			},
		},
	},
	staffPermissions: {
		type: 'array',
		maxItems: 200,
		items: {
			type: 'object',
			required: ['key', 'name', 'feature', 'on'],
			additionalProperties: false,
			properties: { key: ref('permissionKey'), name: ref('name'), feature: ref('featureKey'), on: { type: 'boolean' } },
		},
	},
	events: {
		type: 'array',
		maxItems: 200,
		uniqueItems: true,
		items: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,30}(?:\\.[a-z][a-z0-9_]{0,30}){1,4}$' },
	},
	checklist: {
		type: 'array',
		maxItems: 100,
		items: {
			type: 'object',
			required: ['key', 'done', 'text'],
			additionalProperties: false,
			properties: {
				key: { type: 'string', pattern: '^[a-z][a-z0-9_.]{0,80}$' },
				done: { type: 'boolean' },
				text: text(500),
			},
		},
	},
	summaries: {
		type: 'array',
		maxItems: 20,
		items: {
			type: 'object',
			required: ['title', 'text'],
			additionalProperties: false,
			properties: {
				title: { type: 'string', minLength: 1, maxLength: 120 },
				text: { type: 'string', minLength: 1, maxLength: 2000 },
			},
		},
	},
};

const PRODUCT_REQUIRED = Object.freeze(Object.keys(productProperties));

/** A product's part of the Setup sheet (the kit's `GET /v1/blueprint`). */
export const productBlueprintSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.productBlueprint,
	title: 'Product blueprint',
	type: 'object',
	required: [...PRODUCT_REQUIRED],
	additionalProperties: false,
	properties: productProperties,
});

/** The Setup sheet of a website, `ss.blueprint/1`. */
export const blueprintSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.blueprint,
	title: 'Website Setup sheet',
	type: 'object',
	required: ['schema', 'generatedAt', 'website', 'access', 'products'],
	additionalProperties: false,
	properties: {
		schema: { const: BLUEPRINT_SCHEMA },
		generatedAt: ref('timestamp'),
		website: {
			type: 'object',
			required: ['id', 'domain', 'business'],
			additionalProperties: false,
			properties: {
				id: ref('opaqueId'),
				domain: ref('hostname'),
				business: {
					type: 'object',
					required: ['found', 'name', 'country', 'timeZone'],
					additionalProperties: false,
					properties: {
						found: { type: 'boolean' },
						name: nullable(text(200)),
						country: nullable(ref('country')),
						timeZone: nullable(text(64)),
					},
				},
			},
		},
		access: {
			type: 'object',
			required: ['allowedOrigins', 'testingOrigins', 'serverTokens'],
			additionalProperties: false,
			properties: {
				allowedOrigins: { type: 'array', minItems: 1, maxItems: 10, items: ref('url') },
				testingOrigins: { type: 'array', maxItems: 10, items: text(200) },
				serverTokens: text(300),
			},
		},
		products: {
			type: 'array',
			maxItems: 50,
			items: {
				oneOf: [
					{
						type: 'object',
						required: ['reachable', 'serverToken', ...PRODUCT_REQUIRED],
						additionalProperties: false,
						properties: {
							reachable: { const: true },
							serverToken: {
								type: 'object',
								required: ['issued'],
								additionalProperties: false,
								properties: { issued: { type: 'boolean' } },
							},
							...productProperties,
						},
					},
					{
						type: 'object',
						required: ['productId', 'name', 'reachable', 'reason'],
						additionalProperties: false,
						properties: {
							productId: ref('productId'),
							name: ref('name'),
							reachable: { const: false },
							reason: { type: 'string', enum: [...BLUEPRINT_UNREACHABLE_REASONS] },
						},
					},
				],
			},
		},
		share: {
			type: 'object',
			required: ['expiresAt', 'values', 'install'],
			additionalProperties: false,
			properties: { expiresAt: ref('timestamp'), values: { type: 'boolean' }, install: { type: 'boolean' } },
		},
	},
});
