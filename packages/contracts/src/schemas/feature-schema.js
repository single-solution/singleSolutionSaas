/**
 * Meta-rules for element feature schemas (PLAN Part E §6): the allowed JSON Schema 2020-12 subset plus the
 * annotation keywords `x-ui`, `x-plan`, `x-lock`, `x-experiment`, `x-kind`, and the quota/rate metadata `x-period`,
 * `x-hardStop`, `x-unit` (quota) and `x-per`, `x-unit` (rate), and `x-placement` (placement features).
 *
 * The `placement` kind (F.18) is the one exception to "no open objects": a top-level `type: 'object'` feature with
 * `x-kind: 'placement'` and no `properties`, whose values are validated against the full placement v1 schema (every
 * member, combinators included). `x-placement.members` narrows the members an element supports and
 * `x-plan.<plan>.members` the members a plan may set (its plan bound).
 *
 * A feature schema is always an object schema whose top-level properties are the element's features. Every top-level
 * feature needs `type`, `title` and `default`. Combinators (`anyOf`/`oneOf`/`allOf`/`not`/`if`), `$ref`, and
 * open objects are deliberately not allowed so the Portal can render a form for any schema without special cases.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { PATTERNS, commonRef as ref } from './common.js';

/** JSON types a feature may declare (one per node). */
export const FEATURE_TYPES = Object.freeze(/** @type {const} */ (['string', 'integer', 'number', 'boolean', 'array', 'object']));

/**
 * Feature kinds (PLAN §6.2): flag, quota, limit, rate, config, and `placement` (F.18): a top-level object feature whose
 * value is a placement v1 object, validated against the placement schema rather than declared `properties`.
 */
export const FEATURE_KINDS = Object.freeze(/** @type {const} */ (['flag', 'quota', 'limit', 'rate', 'config', 'placement']));

/** Members of a placement v1 object (`x-placement.members`, `x-plan.<plan>.members`). */
export const PLACEMENT_MEMBERS = Object.freeze(
	/** @type {const} */ ([
		'paths',
		'selectors',
		'pageTypes',
		'devices',
		'referrers',
		'schedule',
		'consent',
		'triggers',
		'frequency',
		'audience',
	]),
);

/** Reset periods of a quota (`x-period`). */
export const QUOTA_PERIODS = Object.freeze(/** @type {const} */ (['hour', 'day', 'week', 'month']));

/** Windows of a rate (`x-per`). */
export const RATE_WINDOWS = Object.freeze(/** @type {const} */ (['second', 'minute', 'hour']));

/** `format` values a feature may use. */
export const FEATURE_FORMATS = Object.freeze(
	/** @type {const} */ (['email', 'uri', 'uri-reference', 'date-time', 'date', 'time', 'duration', 'hostname', 'uuid', 'regex']),
);

/** Annotation keywords added to the subset. */
export const FEATURE_EXTENSION_KEYWORDS = Object.freeze(
	/** @type {const} */ ([
		'x-ui',
		'x-plan',
		'x-lock',
		'x-experiment',
		'x-kind',
		'x-period',
		'x-hardStop',
		'x-unit',
		'x-per',
		'x-placement',
	]),
);

/** Every keyword allowed in a feature schema node. */
export const FEATURE_KEYWORDS = Object.freeze([
	'type',
	'title',
	'description',
	'default',
	'enum',
	'const',
	'examples',
	'deprecated',
	'readOnly',
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
	'minLength',
	'maxLength',
	'pattern',
	'format',
	'items',
	'minItems',
	'maxItems',
	'uniqueItems',
	'properties',
	'required',
	'additionalProperties',
	...FEATURE_EXTENSION_KEYWORDS,
]);

const count = { type: 'integer', minimum: 0 };
const placementMembers = {
	type: 'array',
	uniqueItems: true,
	maxItems: 10,
	items: { type: 'string', enum: [...PLACEMENT_MEMBERS] },
};
const nodeRef = { $ref: '#/$defs/node' };

const nodeProperties = {
	type: { type: 'string', enum: [...FEATURE_TYPES] },
	title: { type: 'string', minLength: 1, maxLength: 120 },
	description: { type: 'string', maxLength: 2000 },
	default: {},
	enum: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true },
	const: {},
	examples: { type: 'array', maxItems: 20 },
	deprecated: { type: 'boolean' },
	readOnly: { type: 'boolean' },
	minimum: { type: 'number' },
	maximum: { type: 'number' },
	exclusiveMinimum: { type: 'number' },
	exclusiveMaximum: { type: 'number' },
	multipleOf: { type: 'number', exclusiveMinimum: 0 },
	minLength: count,
	maxLength: count,
	pattern: { type: 'string', format: 'regex', maxLength: 500 },
	format: { type: 'string', enum: [...FEATURE_FORMATS] },
	items: nodeRef,
	minItems: count,
	maxItems: count,
	uniqueItems: { type: 'boolean' },
	properties: {
		type: 'object',
		maxProperties: 200,
		propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' },
		additionalProperties: nodeRef,
	},
	required: { type: 'array', uniqueItems: true, items: { type: 'string' } },
	additionalProperties: { const: false },
	'x-ui': {
		type: 'object',
		additionalProperties: false,
		properties: {
			widget: { type: 'string', pattern: PATTERNS.slug, maxLength: 40 },
			group: { type: 'string', maxLength: 80 },
			order: { type: 'integer' },
			help: { type: 'string', maxLength: 2000 },
			placeholder: { type: 'string', maxLength: 200 },
			hidden: { type: 'boolean' },
			advanced: { type: 'boolean' },
		},
	},
	'x-plan': {
		type: 'object',
		minProperties: 1,
		propertyNames: ref('planCode'),
		additionalProperties: {
			type: 'object',
			minProperties: 1,
			additionalProperties: false,
			properties: {
				default: {},
				max: { type: ['number', 'boolean'] },
				members: placementMembers,
			},
		},
	},
	'x-placement': {
		type: 'object',
		additionalProperties: false,
		properties: { members: placementMembers },
	},
	'x-lock': { type: 'boolean' },
	'x-experiment': { type: 'boolean' },
	'x-kind': { type: 'string', enum: [...FEATURE_KINDS] },
	'x-period': { type: 'string', enum: [...QUOTA_PERIODS] },
	'x-hardStop': { type: 'boolean' },
	'x-unit': { type: 'string', minLength: 1, maxLength: 40, pattern: PATTERNS.elementKey },
	'x-per': { type: 'string', enum: [...RATE_WINDOWS] },
};

/** Meta-schema every element `features` schema must satisfy. */
export const featureMetaSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.featureSchema,
	title: 'Element feature schema (allowed subset)',
	type: 'object',
	required: ['type', 'properties'],
	additionalProperties: false,
	properties: {
		type: { const: 'object' },
		title: nodeProperties.title,
		description: nodeProperties.description,
		required: nodeProperties.required,
		additionalProperties: nodeProperties.additionalProperties,
		properties: {
			type: 'object',
			maxProperties: 200,
			propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' },
			additionalProperties: { $ref: '#/$defs/feature' },
		},
	},
	$defs: {
		node: { type: 'object', required: ['type'], additionalProperties: false, properties: nodeProperties },
		feature: {
			type: 'object',
			required: ['type', 'title', 'default'],
			additionalProperties: false,
			properties: nodeProperties,
		},
	},
});
