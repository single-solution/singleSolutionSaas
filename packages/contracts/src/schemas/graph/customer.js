/**
 * Graph customer: identities (email, E.164 phone, external id), consent state, attributes, tags, custom fields.
 * @module
 */
import { deepFreeze } from '../../util.js';
import { SCHEMA_IDS } from '../schema-ids.js';
import { PATTERNS, commonRef as ref } from '../common.js';
import { entity, text } from './base.js';

/** Identity types. */
export const IDENTITY_TYPES = Object.freeze(/** @type {const} */ (['email', 'phone', 'externalId']));

/** The customer schema. */
export const customerSchema = deepFreeze(
	entity(
		SCHEMA_IDS.graphCustomer,
		'Graph customer v1',
		{
			identities: {
				type: 'array',
				maxItems: 50,
				items: {
					type: 'object',
					required: ['type', 'value'],
					additionalProperties: false,
					properties: {
						type: { type: 'string', enum: [...IDENTITY_TYPES] },
						value: text(320),
						issuer: text(200),
						verified: { type: 'boolean' },
						primary: { type: 'boolean' },
					},
					allOf: [
						{
							if: { type: 'object', properties: { type: { const: 'email' } } },
							then: { type: 'object', properties: { value: { type: 'string', format: 'email' } } },
						},
						{
							if: { type: 'object', properties: { type: { const: 'phone' } } },
							then: { type: 'object', properties: { value: { type: 'string', pattern: PATTERNS.e164 } } },
						},
						{
							if: { type: 'object', properties: { type: { const: 'externalId' } } },
							then: { type: 'object', required: ['issuer'], properties: { issuer: true } },
						},
					],
				},
			},
			name: text(200),
			locale: ref('locale'),
			country: ref('country'),
			consent: {
				type: 'object',
				propertyNames: ref('slug'),
				additionalProperties: {
					type: 'object',
					required: ['granted', 'updatedAt'],
					additionalProperties: false,
					properties: { granted: { type: 'boolean' }, updatedAt: ref('timestamp'), recordId: ref('opaqueId') },
				},
			},
			attributes: ref('attributes'),
			tags: ref('tags'),
			custom: ref('custom'),
		},
		['identities'],
	),
);
