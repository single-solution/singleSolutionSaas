/**
 * Shared definitions (`$defs`) referenced by every other schema.
 * Money is always integer minor units with an ISO-4217 code; timestamps are ISO-8601 UTC (`Z`); ids are opaque strings.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { ID_PREFIXES, idPattern } from '../ids.js';

/** Regular-expression sources reused by schemas and semantic checks. */
export const PATTERNS = Object.freeze({
	slug: '^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$',
	elementKey: '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$',
	planCode: '^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$',
	eventType: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+@[1-9][0-9]*$',
	elementEvent: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$',
	semver:
		'^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$',
	utcTimestamp: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$',
	currency: '^[A-Z]{3}$',
	country: '^[A-Z]{2}$',
	locale: '^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
	opaqueId: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$',
	hostname: '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$',
	relativePath: '^(?!/)(?!.*\\.\\.)[A-Za-z0-9_./-]+$',
	moduleRef: '^(?!/)(?!.*\\.\\.)[A-Za-z0-9_./-]+\\.m?js#[A-Za-z_$][A-Za-z0-9_$]*$',
	hookName: '^[a-z][A-Za-z0-9]*$',
	scope: '^[a-z][a-z0-9_]*(?:\\.[a-z0-9_*]+)*(?::[a-z0-9_.*@]+)?$',
	resourceName: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
	time: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
	e164: '^\\+[1-9]\\d{6,14}$',
	jsonPointer: '^(?:/(?:[^~/]|~0|~1)*)*$',
});

/** Largest integer representable exactly in JavaScript; bound for money and counters. */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Standard environments. */
export const ENVIRONMENTS = Object.freeze(/** @type {const} */ (['live', 'test']));

/** Client-provided resource kinds a product can require (PLAN §1a). */
export const RESOURCE_KINDS = Object.freeze(
	/** @type {const} */ (['database', 'storage', 'ai', 'messaging', 'payments', 'analytics']),
);

/** Connection status of a client resource; the one vocabulary for entitlement documents and `resource.changed@1`. */
export const RESOURCE_STATUSES = Object.freeze(/** @type {const} */ (['connected', 'missing', 'failing', 'revoked']));

/** Consumption modes (PLAN Part E §1). */
export const MODES = Object.freeze(/** @type {const} */ (['A', 'B', 'C']));

/** Precedence chain sources (PLAN §9). */
export const FEATURE_SOURCES = Object.freeze(
	/** @type {const} */ ([
		'product_default',
		'plan_default',
		'platform_policy',
		'merchant_default',
		'website_override',
		'admin_override',
		'runtime',
	]),
);

/**
 * Local `$ref` into the common schema.
 * @param {string} name
 * @returns {{ $ref: string }}
 */
export const commonRef = (name) => ({ $ref: `${SCHEMA_IDS.common}#/$defs/${name}` });

const minorUnits = { type: 'integer', minimum: 0, maximum: MAX_SAFE, description: 'Integer amount in the currency minor unit.' };

/** The common schema. */
export const commonSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.common,
	title: 'Common definitions',
	$defs: {
		slug: { type: 'string', minLength: 2, maxLength: 40, pattern: PATTERNS.slug },
		elementKey: { type: 'string', minLength: 1, maxLength: 40, pattern: PATTERNS.elementKey },
		planCode: { type: 'string', minLength: 1, maxLength: 40, pattern: PATTERNS.planCode },
		eventType: { type: 'string', maxLength: 120, pattern: PATTERNS.eventType },
		semver: { type: 'string', maxLength: 64, pattern: PATTERNS.semver },
		timestamp: { type: 'string', format: 'date-time', pattern: PATTERNS.utcTimestamp },
		duration: { type: 'string', format: 'duration', maxLength: 64 },
		currency: { type: 'string', pattern: PATTERNS.currency, description: 'ISO-4217 alphabetic code.' },
		country: { type: 'string', pattern: PATTERNS.country, description: 'ISO-3166-1 alpha-2 code.' },
		locale: { type: 'string', maxLength: 35, pattern: PATTERNS.locale, description: 'BCP-47 language tag.' },
		minorUnits,
		signedMinorUnits: { type: 'integer', minimum: -MAX_SAFE, maximum: MAX_SAFE },
		money: {
			type: 'object',
			required: ['amount', 'currency'],
			additionalProperties: false,
			properties: { amount: minorUnits, currency: { $ref: '#/$defs/currency' } },
		},
		signedMoney: {
			type: 'object',
			required: ['amount', 'currency'],
			additionalProperties: false,
			properties: { amount: { $ref: '#/$defs/signedMinorUnits' }, currency: { $ref: '#/$defs/currency' } },
		},
		opaqueId: { type: 'string', pattern: PATTERNS.opaqueId },
		env: { type: 'string', enum: [...ENVIRONMENTS] },
		hostname: { type: 'string', maxLength: 253, pattern: PATTERNS.hostname },
		relativePath: { type: 'string', maxLength: 256, pattern: PATTERNS.relativePath },
		moduleRef: { type: 'string', maxLength: 256, pattern: PATTERNS.moduleRef },
		resourceKind: { type: 'string', enum: [...RESOURCE_KINDS] },
		jsonPointer: { type: 'string', maxLength: 1024, pattern: PATTERNS.jsonPointer },
		subscriptionId: { type: 'string', pattern: idPattern(ID_PREFIXES.subscription) },
		websiteId: { type: 'string', pattern: idPattern(ID_PREFIXES.website) },
		merchantId: { type: 'string', pattern: idPattern(ID_PREFIXES.merchant) },
		scalar: { type: ['string', 'number', 'boolean', 'null'] },
		attributes: {
			type: 'object',
			maxProperties: 200,
			propertyNames: { maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
			additionalProperties: {
				anyOf: [{ $ref: '#/$defs/scalar' }, { type: 'array', maxItems: 100, items: { $ref: '#/$defs/scalar' } }],
			},
		},
		custom: {
			type: 'object',
			maxProperties: 200,
			propertyNames: { maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
			description: 'Merchant-defined custom fields, validated against custom-field definitions.',
		},
		tags: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
		uniqueStrings: { type: 'array', uniqueItems: true, items: { type: 'string' } },
	},
});
