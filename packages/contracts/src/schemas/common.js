/**
 * Shared definitions (`$defs`) referenced by every other schema. Times are ISO-8601 UTC strings (`Z`); money is integer
 * millicredits; ids are opaque strings.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { MERCHANT_STATUSES, PRODUCT_STATUSES } from '../constants.js';

/** Regular-expression sources reused by schemas and semantic checks. */
export const PATTERNS = Object.freeze({
	productId: '^[a-z][a-z0-9-]{1,30}$',
	featureKey: '^[a-z][a-z0-9_]{0,39}$',
	permissionKey: '^[a-z][a-z0-9_.]{0,63}$',
	widgetKey: '^[a-z][a-z0-9_]{0,39}$',
	settingKey: '^[A-Za-z][A-Za-z0-9_]{0,63}$',
	semver:
		'^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$',
	utcTimestamp: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$',
	country: '^[A-Z]{2}$',
	opaqueId: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$',
	hostname: '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$',
	jsonPointer: '^(?:/(?:[^~/]|~0|~1)*)*$',
});

/** Largest integer representable exactly in JavaScript; bound for money and counters. */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * `$ref` into the common schema.
 * @param {string} name
 * @returns {{ $ref: string }}
 */
export const commonRef = (name) => ({ $ref: `${SCHEMA_IDS.common}#/$defs/${name}` });

/** The common schema. */
export const commonSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.common,
	title: 'Common definitions',
	$defs: {
		productId: { type: 'string', pattern: PATTERNS.productId },
		featureKey: { type: 'string', pattern: PATTERNS.featureKey },
		permissionKey: { type: 'string', pattern: PATTERNS.permissionKey },
		widgetKey: { type: 'string', pattern: PATTERNS.widgetKey },
		semver: { type: 'string', maxLength: 64, pattern: PATTERNS.semver },
		timestamp: { type: 'string', format: 'date-time', pattern: PATTERNS.utcTimestamp },
		country: { type: 'string', pattern: PATTERNS.country, description: 'ISO-3166-1 alpha-2 code.' },
		opaqueId: { type: 'string', pattern: PATTERNS.opaqueId },
		hostname: { type: 'string', maxLength: 253, pattern: PATTERNS.hostname },
		jsonPointer: { type: 'string', maxLength: 1024, pattern: PATTERNS.jsonPointer },
		name: { type: 'string', minLength: 1, maxLength: 120 },
		description: { type: 'string', minLength: 1, maxLength: 500 },
		url: { type: 'string', minLength: 1, maxLength: 2048 },
		version: { type: 'integer', minimum: 1, maximum: MAX_SAFE },
		count: { type: 'integer', minimum: 0, maximum: MAX_SAFE },
		millicredits: { type: 'integer', minimum: 0, maximum: MAX_SAFE, description: 'Integer millicredits.' },
		featureKeys: {
			type: 'array',
			maxItems: 100,
			uniqueItems: true,
			items: { $ref: '#/$defs/featureKey' },
		},
		productStatus: { type: 'string', enum: [...PRODUCT_STATUSES] },
		merchantStatus: { type: 'string', enum: [...MERCHANT_STATUSES] },
		cursor: { type: ['string', 'null'], maxLength: 1024 },
	},
});
