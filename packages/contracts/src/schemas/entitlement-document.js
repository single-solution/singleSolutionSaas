/**
 * Entitlement document payload (PLAN §8): the signed, versioned effective state of one subscription (website × product).
 * This is the payload only; the signature envelope belongs to the protocol package. It never carries secrets:
 * resources are referenced by opaque `ref`s, never by connection strings or keys.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { FEATURE_SOURCES, PATTERNS, commonRef as ref } from './common.js';

/** Runtime states of a subscription. */
export const RUNTIME_STATES = Object.freeze(
	/** @type {const} */ (['active', 'paused', 'suspended', 'spend_cap', 'quota_exhausted', 'resource_missing']),
);

/** Connection status of a client resource. */
export const RESOURCE_STATUSES = Object.freeze(/** @type {const} */ (['connected', 'missing', 'failing', 'revoked']));

const reason = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-z][a-z0-9_.:-]*$' };

/** The entitlement document schema. */
export const entitlementDocumentSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.entitlementDocument,
	title: 'Entitlement document payload v1',
	type: 'object',
	required: [
		'subscriptionId',
		'websiteId',
		'merchantId',
		'domain',
		'allowSubdomains',
		'env',
		'productSlug',
		'priceBookVersion',
		'version',
		'issuedAt',
		'validFrom',
		'validUntil',
		'elements',
		'features',
		'config',
		'runtime',
		'resources',
		'dataScope',
		'experiments',
	],
	additionalProperties: false,
	properties: {
		subscriptionId: ref('subscriptionId'),
		websiteId: ref('websiteId'),
		merchantId: ref('merchantId'),
		domain: ref('hostname'),
		allowSubdomains: { type: 'boolean' },
		env: ref('env'),
		productSlug: ref('slug'),
		planCode: ref('planCode'),
		priceBookVersion: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[0-9A-Za-z][0-9A-Za-z._-]*$' },
		version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
		issuedAt: ref('timestamp'),
		validFrom: ref('timestamp'),
		validUntil: ref('timestamp'),
		elements: {
			type: 'object',
			propertyNames: ref('elementKey'),
			additionalProperties: {
				type: 'object',
				required: ['enabled'],
				additionalProperties: false,
				properties: { enabled: { type: 'boolean' }, reason },
			},
		},
		features: {
			type: 'object',
			propertyNames: { pattern: '^[a-z][a-z0-9_]*\\.[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*$', maxLength: 200 },
			additionalProperties: {
				type: 'object',
				required: ['value', 'source', 'locked'],
				additionalProperties: false,
				properties: {
					value: {},
					source: { type: 'string', enum: [...FEATURE_SOURCES] },
					locked: { type: 'boolean' },
					reason,
				},
			},
		},
		config: { type: 'object', propertyNames: ref('elementKey'), additionalProperties: { type: 'object' } },
		runtime: {
			type: 'object',
			required: ['state'],
			additionalProperties: false,
			properties: { state: { type: 'string', enum: [...RUNTIME_STATES] }, reason },
			if: { type: 'object', properties: { state: { const: 'active' } } },
			else: { required: ['reason'], properties: { reason: true } },
		},
		resources: {
			type: 'array',
			maxItems: 20,
			items: {
				type: 'object',
				required: ['kind', 'ref', 'status'],
				additionalProperties: false,
				properties: {
					kind: ref('resourceKind'),
					ref: { type: 'string', maxLength: 128, pattern: PATTERNS.opaqueId },
					status: { type: 'string', enum: [...RESOURCE_STATUSES] },
				},
			},
		},
		dataScope: {
			type: 'object',
			required: ['prefix'],
			additionalProperties: false,
			properties: { prefix: { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-z][a-z0-9_]*_$' } },
		},
		experiments: {
			type: 'array',
			maxItems: 200,
			items: {
				type: 'object',
				required: ['element', 'variant'],
				additionalProperties: false,
				properties: {
					element: ref('elementKey'),
					variant: { type: 'string', minLength: 1, maxLength: 40, pattern: PATTERNS.slug },
				},
			},
		},
	},
});
