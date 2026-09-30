/**
 * Graph order: lines, amounts (integer minor units, one currency per order) and normalised status.
 * Products may keep richer, merchant-named statuses; the graph status is the shared vocabulary.
 * @module
 */
import { deepFreeze } from '../../util.js';
import { SCHEMA_IDS } from '../schema-ids.js';
import { commonRef as ref } from '../common.js';
import { entity, text } from './base.js';

/** Normalised order statuses. */
export const ORDER_STATUSES = Object.freeze(
	/** @type {const} */ (['pending', 'placed', 'paid', 'fulfilled', 'completed', 'cancelled', 'refunded']),
);

const minor = ref('minorUnits');

/** The order schema. */
export const orderSchema = deepFreeze(
	entity(
		SCHEMA_IDS.graphOrder,
		'Graph order v1',
		{
			number: text(64),
			customerId: ref('opaqueId'),
			status: { type: 'string', enum: [...ORDER_STATUSES] },
			currency: ref('currency'),
			lines: {
				type: 'array',
				minItems: 1,
				maxItems: 500,
				items: {
					type: 'object',
					required: ['itemId', 'quantity', 'unitAmount', 'totalAmount'],
					additionalProperties: false,
					properties: {
						id: ref('opaqueId'),
						itemId: ref('opaqueId'),
						variantId: ref('opaqueId'),
						sku: text(100),
						title: text(300),
						quantity: { type: 'integer', minimum: 1, maximum: 1_000_000 },
						unitAmount: minor,
						discountAmount: minor,
						taxAmount: minor,
						totalAmount: minor,
					},
				},
			},
			amounts: {
				type: 'object',
				required: ['subtotal', 'total'],
				additionalProperties: false,
				properties: { subtotal: minor, discount: minor, shipping: minor, tax: minor, total: minor, refunded: minor },
			},
			placedAt: ref('timestamp'),
			source: ref('slug'),
			tags: ref('tags'),
			custom: ref('custom'),
		},
		['status', 'currency', 'lines', 'amounts'],
	),
);
