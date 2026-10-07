/**
 * Entitlement document payload (PLAN §8): the signed, versioned effective state of one subscription (website × product).
 * This is the payload only; the signature envelope belongs to the protocol package. It never carries secrets:
 * resources are referenced by opaque `ref`s, never by connection strings or keys.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { FEATURE_SOURCES, PATTERNS, RESOURCE_STATUSES, commonRef as ref } from './common.js';

/** Runtime states of a subscription. */
export const RUNTIME_STATES = Object.freeze(
	/** @type {const} */ (['active', 'paused', 'suspended', 'spend_cap', 'quota_exhausted', 'resource_missing']),
);

const reason = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-z][a-z0-9_.:-]*$' };

/** JWS algorithms a website's own identity issuer may sign customer tokens with (PLAN §5.3). */
export const IDENTITY_ALGORITHMS = Object.freeze(/** @type {const} */ (['EdDSA', 'ES256', 'RS256']));

/** At most this many issuer public keys travel inline in a document. */
export const IDENTITY_MAX_KEYS = 5;

/** Claim names a claim map may point at (`sub`, `email`, `https://example.com/claims/phone`). */
export const CLAIM_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_.:/-]{0,199}$';

const b64url = (/** @type {number} */ max) => ({ type: 'string', minLength: 1, maxLength: max, pattern: '^[A-Za-z0-9_-]+$' });
const claimName = { type: 'string', pattern: CLAIM_NAME_PATTERN };

/**
 * A public signature key of an identity issuer (JWK, RFC 7517): Ed25519 (`OKP`), P-256 (`EC`) or RSA ≥ 2048 bits.
 * Private members are never allowed (closed object).
 */
export const identityJwkSchema = deepFreeze({
	type: 'object',
	required: ['kty', 'kid'],
	additionalProperties: false,
	properties: {
		kty: { type: 'string', enum: ['OKP', 'EC', 'RSA'] },
		kid: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$' },
		alg: { type: 'string', enum: [...IDENTITY_ALGORITHMS] },
		use: { const: 'sig' },
		crv: { type: 'string', enum: ['Ed25519', 'P-256'] },
		x: b64url(64),
		y: b64url(64),
		n: b64url(1400),
		e: b64url(12),
	},
	allOf: [
		{
			if: { properties: { kty: { const: 'OKP' } } },
			then: {
				required: ['crv', 'x'],
				properties: { crv: { const: 'Ed25519' }, x: true, alg: { const: 'EdDSA' }, y: false, n: false, e: false },
			},
		},
		{
			if: { properties: { kty: { const: 'EC' } } },
			then: {
				required: ['crv', 'x', 'y'],
				properties: { crv: { const: 'P-256' }, x: true, y: true, alg: { const: 'ES256' }, n: false, e: false },
			},
		},
		{
			if: { properties: { kty: { const: 'RSA' } } },
			then: {
				required: ['n', 'e'],
				properties: {
					alg: { const: 'RS256' },
					n: { type: 'string', minLength: 342 },
					e: true,
					crv: false,
					x: false,
					y: false,
				},
			},
		},
	],
});

/**
 * Bring-your-own customer identity (PLAN §5.3): the website's own issuer, its public keys inline, the expected
 * audience and where the subject / e-mail / phone live in its tokens. Products verify `SS-Identity` tokens with it.
 */
export const identitySectionSchema = deepFreeze({
	type: 'object',
	required: ['issuer', 'jwks', 'claimMap'],
	additionalProperties: false,
	properties: {
		issuer: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[\\x21-\\x7e]+$' },
		jwks: { type: 'array', minItems: 1, maxItems: IDENTITY_MAX_KEYS, items: identityJwkSchema },
		audience: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[\\x21-\\x7e]+$' },
		claimMap: {
			type: 'object',
			required: ['subject'],
			additionalProperties: false,
			properties: { subject: claimName, email: claimName, phone: claimName },
		},
	},
});

/** IANA time zone names (`Europe/Berlin`, `America/Argentina/Buenos_Aires`, `UTC`, `Etc/GMT+5`); the runtime check is `isTimeZone`. */
export const TIME_ZONE_PATTERN = '^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9][A-Za-z0-9_+-]*){0,2}$';

/**
 * Website settings the Portal copies into every document of the website (all optional; filled from the website's
 * settings in the console): `timeZone` (IANA name), `language` (BCP-47 tag, the website's default language) and
 * `currency` (ISO-4217, the store currency). Products use them as defaults (schedules, strings, money formatting)
 * instead of asking the merchant again. Closed object.
 */
export const websiteSectionSchema = deepFreeze({
	type: 'object',
	additionalProperties: false,
	properties: {
		timeZone: { type: 'string', minLength: 1, maxLength: 64, pattern: TIME_ZONE_PATTERN, description: 'IANA time zone name.' },
		language: ref('locale'),
		currency: ref('currency'),
	},
});

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
		identity: identitySectionSchema,
		website: websiteSectionSchema,
	},
});
