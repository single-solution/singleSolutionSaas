/**
 * Shared placement schema (PLAN Part D §0 L7): where and when an element renders.
 * Timezones are IANA names (checked semantically); time windows may cross midnight (`start > end`).
 * `audience` is an expression in the shared rules grammar, validated by the rules package.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { PATTERNS, commonRef as ref } from './common.js';

/** Devices a placement can target. */
export const DEVICES = Object.freeze(/** @type {const} */ (['mobile', 'tablet', 'desktop']));

/** Trigger types. */
export const TRIGGER_TYPES = Object.freeze(/** @type {const} */ (['load', 'idle', 'scroll', 'exit', 'selector-click', 'event']));

/** Insert positions relative to a selector. */
export const MOUNT_POSITIONS = Object.freeze(/** @type {const} */ (['before', 'after', 'prepend', 'append', 'replace']));

/** ISO weekdays (Monday first). */
export const WEEKDAYS = Object.freeze(/** @type {const} */ (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']));

const glob = { type: 'string', minLength: 1, maxLength: 500, pattern: '^/[^\\s]*$' };
const selector = { type: 'string', minLength: 1, maxLength: 500 };
/** @param {Record<string, unknown>} items */
const includeExclude = (items) => ({
	type: 'object',
	additionalProperties: false,
	minProperties: 1,
	properties: {
		include: { type: 'array', maxItems: 100, uniqueItems: true, items },
		exclude: { type: 'array', maxItems: 100, uniqueItems: true, items },
	},
});
const ms = { type: 'integer', minimum: 0, maximum: 3_600_000 };
const count = { type: 'integer', minimum: 1, maximum: 10_000 };

/**
 * @param {string} type
 * @param {Record<string, unknown>} [properties]
 * @param {string[]} [required]
 */
const trigger = (type, properties = {}, required = []) => ({
	type: 'object',
	required: ['type', ...required],
	additionalProperties: false,
	properties: { type: { const: type }, ...properties },
});

/** The placement schema. */
export const placementSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.placement,
	title: 'Element placement v1',
	type: 'object',
	additionalProperties: false,
	properties: {
		paths: includeExclude(glob),
		selectors: {
			type: 'array',
			maxItems: 20,
			items: {
				type: 'object',
				required: ['selector'],
				additionalProperties: false,
				properties: { selector, position: { type: 'string', enum: [...MOUNT_POSITIONS], default: 'append' } },
			},
		},
		pageTypes: { type: 'array', maxItems: 50, uniqueItems: true, items: ref('slug') },
		devices: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...DEVICES] } },
		referrers: includeExclude({ type: 'string', minLength: 1, maxLength: 253, pattern: '^(?:\\*\\.)?[a-z0-9.-]+$' }),
		schedule: {
			type: 'object',
			required: ['timezone'],
			additionalProperties: false,
			properties: {
				timezone: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_+/-]*$' },
				from: ref('timestamp'),
				until: ref('timestamp'),
				windows: {
					type: 'array',
					maxItems: 50,
					items: {
						type: 'object',
						required: ['start', 'end'],
						additionalProperties: false,
						properties: {
							days: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...WEEKDAYS] } },
							start: { type: 'string', pattern: PATTERNS.time },
							end: { type: 'string', pattern: PATTERNS.time },
						},
					},
				},
			},
		},
		consent: { type: 'array', maxItems: 20, uniqueItems: true, items: ref('slug') },
		triggers: {
			type: 'array',
			maxItems: 10,
			items: {
				oneOf: [
					trigger('load', { delayMs: ms }),
					trigger('idle', { afterMs: ms }, ['afterMs']),
					trigger('scroll', { percent: { type: 'integer', minimum: 0, maximum: 100 } }, ['percent']),
					trigger('exit'),
					trigger('selector-click', { selector }, ['selector']),
					trigger('event', { event: { anyOf: [ref('eventType'), { type: 'string', pattern: PATTERNS.elementEvent }] } }, [
						'event',
					]),
				],
			},
		},
		frequency: {
			type: 'object',
			minProperties: 1,
			additionalProperties: false,
			properties: {
				maxPerSession: count,
				maxPerDay: count,
				maxPerVisitor: count,
				cooldown: ref('duration'),
				dismissMemory: ref('duration'),
			},
		},
		audience: { type: 'string', minLength: 1, maxLength: 4000 },
	},
});
