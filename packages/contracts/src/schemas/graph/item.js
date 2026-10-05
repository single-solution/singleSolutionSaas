/**
 * Graph item: type, attributes, variants, media refs and prices in minor units.
 * @module
 */
import { deepFreeze } from '../../util.js';
import { SCHEMA_IDS } from '../schema-ids.js';
import { commonRef as ref } from '../common.js';
import { entity, text } from './base.js';

/** Publication statuses of an item. */
export const ITEM_STATUSES = Object.freeze(/** @type {const} */ (['draft', 'active', 'archived']));

const price = {
	type: 'object',
	required: ['amount', 'currency'],
	additionalProperties: false,
	properties: {
		amount: ref('minorUnits'),
		currency: ref('currency'),
		compareAtAmount: ref('minorUnits'),
		priceListId: ref('opaqueId'),
	},
};
const prices = { type: 'array', maxItems: 100, items: price };
const media = {
	type: 'array',
	maxItems: 100,
	items: {
		type: 'object',
		required: ['fileId'],
		additionalProperties: false,
		properties: { fileId: ref('opaqueId'), role: ref('slug'), alt: { type: 'string', maxLength: 500 } },
	},
};

/** The item schema. */
export const itemSchema = deepFreeze(
	entity(
		SCHEMA_IDS.graphItem,
		'Graph item v1',
		{
			type: ref('slug'),
			title: text(300),
			slug: {
				type: 'string',
				minLength: 1,
				maxLength: 200,
				pattern: '^[\\p{Ll}\\p{Lo}\\p{N}]+(?:-[\\p{Ll}\\p{Lo}\\p{N}]+)*$',
			},
			status: { type: 'string', enum: [...ITEM_STATUSES] },
			externalId: ref('opaqueId'),
			attributes: ref('attributes'),
			variants: {
				type: 'array',
				maxItems: 1000,
				items: {
					type: 'object',
					required: ['id'],
					additionalProperties: false,
					properties: {
						id: ref('opaqueId'),
						sku: text(100),
						barcode: text(64),
						attributes: ref('attributes'),
						prices,
						quantity: { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
						media,
					},
				},
			},
			media,
			prices,
			tags: ref('tags'),
			custom: ref('custom'),
		},
		['type', 'title'],
	),
);
