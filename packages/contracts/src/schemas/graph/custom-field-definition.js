/**
 * Merchant-defined custom field on a graph or product entity (PLAN Part D §0 L5).
 * @module
 */
import { deepFreeze } from '../../util.js';
import { SCHEMA_IDS } from '../schema-ids.js';
import { commonRef as ref } from '../common.js';
import { entity, text } from './base.js';

/** Custom field value types. */
export const CUSTOM_FIELD_TYPES = Object.freeze(
	/** @type {const} */ ([
		'string',
		'text',
		'number',
		'integer',
		'boolean',
		'date',
		'datetime',
		'enum',
		'multi_enum',
		'url',
		'email',
		'phone',
	]),
);

/** The custom field definition schema. */
export const customFieldDefinitionSchema = deepFreeze({
	...entity(
		SCHEMA_IDS.graphCustomFieldDefinition,
		'Graph custom field definition v1',
		{
			entity: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)?$' },
			key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
			label: text(200),
			description: { type: 'string', maxLength: 2000 },
			type: { type: 'string', enum: [...CUSTOM_FIELD_TYPES] },
			required: { type: 'boolean' },
			options: {
				type: 'array',
				minItems: 1,
				maxItems: 500,
				uniqueItems: true,
				items: {
					type: 'object',
					required: ['value'],
					additionalProperties: false,
					properties: { value: text(100), label: text(200) },
				},
			},
			validation: {
				type: 'object',
				additionalProperties: false,
				properties: {
					min: { type: 'number' },
					max: { type: 'number' },
					minLength: { type: 'integer', minimum: 0 },
					maxLength: { type: 'integer', minimum: 0 },
					pattern: { type: 'string', format: 'regex', maxLength: 500 },
				},
			},
			filterable: { type: 'boolean' },
			localisable: { type: 'boolean' },
			strings: ref('relativePath'),
		},
		['entity', 'key', 'label', 'type'],
	),
	if: { type: 'object', properties: { type: { enum: ['enum', 'multi_enum'] } } },
	then: { required: ['options'], properties: { options: true } },
});
