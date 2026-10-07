/**
 * Settings schemas (PLAN 0.4.2, 0.4.8): each feature in a manifest declares its settings as a small JSON Schema 2020-12
 * subset that any dashboard can render as a form without special cases.
 *
 * A settings schema is `{ type: 'object', properties: { <setting>: <node> }, additionalProperties?: false }`. Every
 * setting node has `type`, `title` and `default`, and may add `description`, `minimum` / `maximum` (the hard maximums
 * of limits), `maxLength`, `enum`, `format`, `items` (lists) and `x-ui` (form hints). List items have `type` and may
 * add `minimum`, `maximum`, `maxLength`, `enum` and `format`. Nothing else is allowed.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { PATTERNS } from './common.js';

/** Types a setting may have. */
export const SETTING_TYPES = Object.freeze(/** @type {const} */ (['string', 'integer', 'number', 'boolean', 'array']));

/** Types a list item may have. */
export const SETTING_ITEM_TYPES = Object.freeze(/** @type {const} */ (['string', 'integer', 'number', 'boolean']));

/** `format` values a string setting may use. */
export const SETTING_FORMATS = Object.freeze(
	/** @type {const} */ (['email', 'uri', 'uri-reference', 'date-time', 'date', 'time', 'duration', 'hostname', 'uuid', 'regex']),
);

/** Annotation keywords added to the subset (registered with Ajv). */
export const SETTING_EXTENSION_KEYWORDS = Object.freeze(/** @type {const} */ (['x-ui']));

/** Keywords allowed on a setting node. */
export const SETTING_KEYWORDS = Object.freeze(
	/** @type {const} */ ([
		'type',
		'title',
		'default',
		'description',
		'minimum',
		'maximum',
		'maxLength',
		'enum',
		'format',
		'items',
		'x-ui',
	]),
);

const limits = {
	minimum: { type: 'number' },
	maximum: { type: 'number' },
	maxLength: { type: 'integer', minimum: 0 },
	enum: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true },
	format: { type: 'string', enum: [...SETTING_FORMATS] },
};

/** Meta-schema every feature `settings` schema must satisfy. */
export const settingsMetaSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.settingsSchema,
	title: 'Feature settings schema (allowed subset)',
	type: 'object',
	required: ['type', 'properties'],
	additionalProperties: false,
	properties: {
		type: { const: 'object' },
		additionalProperties: { const: false },
		properties: {
			type: 'object',
			maxProperties: 100,
			propertyNames: { pattern: PATTERNS.settingKey },
			additionalProperties: { $ref: '#/$defs/setting' },
		},
	},
	$defs: {
		setting: {
			type: 'object',
			required: ['type', 'title', 'default'],
			additionalProperties: false,
			properties: {
				type: { type: 'string', enum: [...SETTING_TYPES] },
				title: { type: 'string', minLength: 1, maxLength: 120 },
				default: {},
				description: { type: 'string', maxLength: 2000 },
				...limits,
				items: { $ref: '#/$defs/item' },
				'x-ui': {
					type: 'object',
					additionalProperties: false,
					properties: {
						widget: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
						group: { type: 'string', minLength: 1, maxLength: 80 },
						order: { type: 'integer' },
						help: { type: 'string', maxLength: 2000 },
						placeholder: { type: 'string', maxLength: 200 },
					},
				},
			},
		},
		item: {
			type: 'object',
			required: ['type'],
			additionalProperties: false,
			properties: { type: { type: 'string', enum: [...SETTING_ITEM_TYPES] }, ...limits },
		},
	},
});
