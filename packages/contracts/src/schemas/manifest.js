/**
 * Product manifest (PLAN 0.4.13): `manifest.json` declares only `id`, `name`, `version`, `endpoints` (base,
 * dashboard), `widgetScriptUrl` (or null) and, optionally, `widgetScriptLoading` (`async`, the default, or `blocking`
 * for a script that must run in page order before the others), `docsUrl`, `features` (key, name, description, dependsOn, settings schema
 * and, optionally, `recommendFor`: the business profile answers the feature suits, for the Setup sheet's advisor),
 * `permissions` (key, name, feature) and `widgets` (key, feature, visitor or admin). It carries no prices.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';
import { recommendForSchema } from './profile.js';

/** How a website loads a product's widget script: `async` (the default) or `blocking` (in page order). */
const WIDGET_SCRIPT_LOADING = Object.freeze(/** @type {const} */ (['async', 'blocking']));

/** How much a product needs the website's storage connection. */
const STORAGE_NEEDS = Object.freeze(/** @type {const} */ (['none', 'optional', 'required']));

/** Widget kinds. */
const WIDGET_KINDS = Object.freeze(/** @type {const} */ (['visitor', 'admin']));

/** The manifest schema (shape only; `validateManifest` adds the semantic rules). */
export const manifestSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.manifest,
	title: 'Product manifest',
	type: 'object',
	required: ['id', 'name', 'version', 'endpoints', 'widgetScriptUrl', 'docsUrl', 'features', 'permissions', 'widgets'],
	additionalProperties: false,
	properties: {
		id: ref('productId'),
		name: { type: 'string', minLength: 1, maxLength: 80 },
		version: ref('semver'),
		endpoints: {
			type: 'object',
			required: ['base', 'dashboard'],
			additionalProperties: false,
			properties: { base: ref('url'), dashboard: ref('url') },
		},
		widgetScriptUrl: { anyOf: [ref('url'), { type: 'null' }] },
		// what the product needs the website's settings (Portal) to say, for the readiness line
		websiteSettings: {
			type: 'object',
			required: ['requires'],
			additionalProperties: false,
			properties: { requires: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } } },
		},
		// what the product needs of the website's connections (Portal › Website settings › Data and files): a database and a
		// bucket. A product that says nothing needs a database and no storage
		needs: {
			type: 'object',
			required: ['database', 'storage'],
			additionalProperties: false,
			properties: { database: { type: 'boolean' }, storage: { enum: [...STORAGE_NEEDS] } },
		},
		// the links to other products on the website: what this product offers them and what it needs from them
		links: {
			type: 'object',
			additionalProperties: false,
			properties: {
				offers: {
					type: 'array',
					maxItems: 40,
					items: {
						type: 'object',
						required: ['scope', 'name', 'description'],
						additionalProperties: false,
						properties: { scope: ref('linkScope'), name: ref('name'), description: ref('description') },
					},
				},
				needs: {
					type: 'array',
					maxItems: 20,
					items: {
						type: 'object',
						required: ['product', 'scopes', 'features'],
						additionalProperties: false,
						properties: {
							product: ref('productId'),
							scopes: { type: 'array', minItems: 1, maxItems: 40, uniqueItems: true, items: ref('linkScope') },
							// the features that use the link: the scopes are granted while one is on (none listed: always)
							features: ref('featureKeys'),
							optional: { type: 'boolean' },
						},
					},
				},
			},
		},
		widgetScriptLoading: { enum: [...WIDGET_SCRIPT_LOADING] },
		docsUrl: ref('url'),
		features: {
			type: 'array',
			minItems: 1,
			maxItems: 100,
			items: {
				type: 'object',
				required: ['key', 'name', 'description', 'dependsOn', 'settings'],
				additionalProperties: false,
				properties: {
					key: ref('featureKey'),
					name: ref('name'),
					description: ref('description'),
					dependsOn: ref('featureKeys'),
					// what the feature needs the website's settings (Portal) to say, as dotted paths (`pages.signIn`): the product's
					// setup steps link to the Portal while one is empty
					requires: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
					settings: { $ref: SCHEMA_IDS.settingsSchema },
					recommendFor: recommendForSchema,
				},
			},
		},
		permissions: {
			type: 'array',
			maxItems: 200,
			items: {
				type: 'object',
				required: ['key', 'name', 'feature'],
				additionalProperties: false,
				properties: { key: ref('permissionKey'), name: ref('name'), feature: ref('featureKey') },
			},
		},
		widgets: {
			type: 'array',
			maxItems: 50,
			items: {
				type: 'object',
				required: ['key', 'feature', 'kind'],
				additionalProperties: false,
				properties: {
					key: ref('widgetKey'),
					// one feature, or several when the widget works while any of them is on (Accounts' sign-in)
					feature: {
						anyOf: [
							ref('featureKey'),
							{ type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: ref('featureKey') },
						],
					},
					kind: { type: 'string', enum: [...WIDGET_KINDS] },
				},
			},
		},
	},
});
