/**
 * The website Setup sheet, `ss.blueprint/1` (owner request 2026-10-14; design `audit/design/website-blueprint.md`).
 *
 * - **Product blueprint** (each product's `GET /v1/blueprint?websiteId=`, a Portal call answered by `@ss/app-kit`):
 *   the product's part for one website: `{ productId, name, version, status, docs, install, features,
 *   shared, connections, widgets, staffPermissions, events, checklist, summaries, build }`. Features carry the
 *   business profile answers they suit (`recommendFor`, from the manifest) and their settings with values
 *   (`default: true` while the website has not saved its own; a value holding a secret saved in the website's
 *   Connections is never shown: the setting has `set: true` instead of `value`) and their lists summarized, but only
 *   while the feature is on. Connections show their state only: `set` and `state`, never a value, its last characters
 *   or a test message. `build` says, per feature that is on, what the merchant's website builds for it (pages, routes, script
 *   tags, server calls) with the guide's section.
 * - **Blueprint** (the Portal's sheet): `{ schema: 'ss.blueprint/1', generatedAt, website, access, products, share? }`.
 *   `website.status` is the status the website's products have (`active`, `grace`, `stopped` or `suspended`, PLAN
 *   0.5.5) and `website.profile` its business profile (null until someone fills it in). Each product is its blueprint
 *   plus `reachable: true`, `apiBase` (the address its API paths go after), the browser token and install snippet in
 *   `install`, `serverToken: { issued }` (the value is never in a sheet) and the advisor's view: `recommended` (features the profile calls for, on or not,
 *   with the tags and why) and `notRecommended` (features that are on although the profile rules them out); a
 *   product that did not answer in time is `{ productId, name, reachable: false, reason }`. `share` describes a copy
 *   opened from a share link: what it leaves out (`values: false` drops every setting's `value`, `install: false`
 *   the browser token and snippet).
 * @module
 */
import { deepFreeze } from '../util.js';
import { PATTERNS, commonRef as ref } from './common.js';
import { RECOMMEND_TAG_PATTERN, recommendForSchema } from './profile.js';
import { SCHEMA_IDS } from './schema-ids.js';

const draft = 'https://json-schema.org/draft/2020-12/schema';

/** The `schema` member of every Setup sheet. */
export const BLUEPRINT_SCHEMA = 'ss.blueprint/1';

/** Why a product is missing from a sheet. */
export const BLUEPRINT_UNREACHABLE_REASONS = Object.freeze(
	/** @type {const} */ (['timeout', 'unreachable', 'refused', 'invalid']),
);

/** Longest "what your website builds" text of one feature. */
export const BUILD_TEXT_MAX = 1000;

/** Connection kinds and states (as the kit keeps them). */
const CONNECTION_KINDS = Object.freeze(['database', 'storage', 'secret', 'link']);
const CONNECTION_STATES = Object.freeze(['connected', 'not_connected', 'test_failed']);

const text = (/** @type {number} */ max) => ({ type: 'string', maxLength: max });
const nullable = (/** @type {Record<string, unknown>} */ schema) => ({ anyOf: [schema, { type: 'null' }] });

/**
 * One setting with its value; `value` is absent in a shared copy without values, and replaced by `set` when it holds
 * a secret.
 */
const setting = {
	type: 'object',
	required: ['key', 'title', 'default'],
	additionalProperties: false,
	// `set` stands in for the value: never both
	dependentSchemas: { set: { type: 'object', properties: { value: false } } },
	properties: {
		key: { type: 'string', pattern: PATTERNS.settingKey },
		title: text(120),
		value: {},
		set: {
			type: 'boolean',
			description: 'In place of value when the value holds a secret saved in Connections: a value is set (never shown).',
		},
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

/** The statuses a website's products have (PLAN 0.5.5; a removed product is no part of a sheet). */
const WEBSITE_STATUSES = Object.freeze(['active', 'grace', 'stopped', 'suspended']);

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
	install: {
		type: 'object',
		required: ['scriptUrl', 'scriptLoading', 'installed', 'lastSeenAt'],
		additionalProperties: false,
		properties: {
			scriptUrl: nullable(ref('url')),
			scriptLoading: { enum: ['async', 'blocking'] },
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
			required: ['key', 'title', 'description', 'on', 'dependsOn', 'recommendFor', 'settings', 'lists'],
			additionalProperties: false,
			properties: {
				key: ref('featureKey'),
				title: ref('name'),
				description: ref('description'),
				on: { type: 'boolean' },
				dependsOn: ref('featureKeys'),
				recommendFor: recommendForSchema,
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
	build: {
		type: 'array',
		maxItems: 100,
		items: {
			type: 'object',
			required: ['feature', 'what', 'docs'],
			additionalProperties: false,
			properties: {
				feature: ref('featureKey'),
				what: { type: 'string', minLength: 1, maxLength: BUILD_TEXT_MAX },
				docs: ref('url'),
			},
		},
	},
};

/** Tags a piece of advice names (one rule's worth). */
const adviceTags = { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', pattern: `^${RECOMMEND_TAG_PATTERN}$` } };

/** The advisor's view of a reachable product in a sheet. */
const adviceProperties = {
	recommended: {
		type: 'array',
		maxItems: 100,
		items: {
			type: 'object',
			required: ['feature', 'on', 'because', 'why'],
			additionalProperties: false,
			properties: { feature: ref('featureKey'), on: { type: 'boolean' }, because: adviceTags, why: text(500) },
		},
	},
	notRecommended: {
		type: 'array',
		maxItems: 100,
		items: {
			type: 'object',
			required: ['feature', 'missing', 'why'],
			additionalProperties: false,
			properties: { feature: ref('featureKey'), missing: adviceTags, why: text(500) },
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
			required: ['id', 'domain', 'status', 'business', 'profile'],
			additionalProperties: false,
			properties: {
				id: ref('opaqueId'),
				domain: ref('hostname'),
				status: { type: 'string', enum: [...WEBSITE_STATUSES], description: "The status of the website's products." },
				profile: nullable({ $ref: SCHEMA_IDS.businessProfile }),
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
						required: ['reachable', 'apiBase', 'serverToken', ...PRODUCT_REQUIRED, ...Object.keys(adviceProperties)],
						additionalProperties: false,
						properties: {
							reachable: { const: true },
							apiBase: ref('url'),
							serverToken: {
								type: 'object',
								required: ['issued'],
								additionalProperties: false,
								properties: { issued: { type: 'boolean' } },
							},
							...productProperties,
							...adviceProperties,
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
