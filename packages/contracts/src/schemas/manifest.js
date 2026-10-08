/**
 * Product manifest (PLAN 0.4.13): `manifest.json` declares only `id`, `name`, `version`, `endpoints` (base,
 * dashboard), `widgetScriptUrl` (or null), `docsUrl`, `features` (key, name, description, dependsOn, settings schema),
 * `permissions` (key, name, feature) and `widgets` (key, feature, visitor or admin). It carries no prices.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';

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
					settings: { $ref: SCHEMA_IDS.settingsSchema },
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
