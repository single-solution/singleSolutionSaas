/**
 * Event envelope v1 (PLAN §5.2, Part E §9) and the standard event data schemas.
 * Money is integer minor units + ISO-4217 currency; when several amounts share a context (cart, order) one `currency`
 * applies to all integer `*Amount` fields; standalone values use a `money` object. Ids are opaque strings.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS, eventDataSchemaId } from './schema-ids.js';
import { PATTERNS, commonRef as ref } from './common.js';

/** Actor types that can cause an event. */
export const ACTOR_TYPES = Object.freeze(
	/** @type {const} */ (['customer', 'anonymous', 'staff', 'merchant', 'system', 'product']),
);

/** Where an event entered the platform. */
export const EVENT_SOURCES = Object.freeze(/** @type {const} */ (['loader', 'server', 'product', 'portal', 'import', 'webhook']));

/** Prefix of merchant-defined events; their data is any object validated elsewhere. */
export const CUSTOM_EVENT_PREFIX = 'custom.';

const id = ref('opaqueId');
/** @param {number} max */
const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });
const url = { type: 'string', format: 'uri', maxLength: 2048 };

/** The envelope schema; `data` is checked against the data schema of `type`. */
export const eventEnvelopeSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.eventEnvelope,
	title: 'Event envelope v1',
	type: 'object',
	required: ['id', 'type', 'websiteId', 'env', 'occurredAt', 'idempotencyKey', 'actor', 'data'],
	additionalProperties: false,
	properties: {
		id,
		type: ref('eventType'),
		websiteId: ref('websiteId'),
		env: ref('env'),
		occurredAt: ref('timestamp'),
		idempotencyKey: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[\\x21-\\x7e]+$' },
		actor: {
			type: 'object',
			required: ['type'],
			additionalProperties: false,
			properties: { type: { type: 'string', enum: [...ACTOR_TYPES] }, id },
		},
		data: { type: 'object' },
		context: {
			type: 'object',
			additionalProperties: false,
			properties: {
				source: { type: 'string', enum: [...EVENT_SOURCES] },
				product: ref('slug'),
				element: ref('elementKey'),
				locale: ref('locale'),
				sessionId: id,
				anonymousId: id,
				requestId: id,
				traceId: id,
				pageUrl: url,
				referrer: url,
				userAgent: text(512),
			},
		},
	},
});

const line = {
	type: 'object',
	required: ['itemId', 'quantity', 'unitAmount'],
	additionalProperties: false,
	properties: {
		itemId: id,
		variantId: id,
		sku: text(100),
		title: text(300),
		quantity: { type: 'integer', minimum: 1, maximum: 1_000_000 },
		unitAmount: ref('minorUnits'),
		totalAmount: ref('minorUnits'),
	},
};

const orderAmounts = {
	type: 'object',
	required: ['subtotal', 'total'],
	additionalProperties: false,
	properties: {
		subtotal: ref('minorUnits'),
		discount: ref('minorUnits'),
		shipping: ref('minorUnits'),
		tax: ref('minorUnits'),
		total: ref('minorUnits'),
	},
};

const identity = {
	type: 'object',
	required: ['type', 'value'],
	additionalProperties: false,
	properties: { type: { type: 'string', enum: ['email', 'phone', 'externalId'] }, value: text(320) },
};

/**
 * @param {Record<string, unknown>} properties
 * @param {string[]} required
 */
const data = (properties, required) => ({ type: 'object', required, additionalProperties: false, properties });

/** Data schemas of standard events v1, keyed by `type@v`. */
export const STANDARD_EVENT_DATA = deepFreeze({
	'customer.created@1': data(
		{ customerId: id, identities: { type: 'array', maxItems: 20, items: identity }, source: text(64) },
		['customerId'],
	),
	'customer.updated@1': data({ customerId: id, changed: { type: 'array', minItems: 1, uniqueItems: true, items: text(64) } }, [
		'customerId',
		'changed',
	]),
	'customer.signed_in@1': data({ customerId: id, method: { type: 'string', pattern: PATTERNS.elementKey, maxLength: 40 } }, [
		'customerId',
		'method',
	]),
	'page.viewed@1': data(
		{
			url,
			path: { type: 'string', maxLength: 2048, pattern: '^/' },
			title: text(500),
			referrer: url,
			pageType: ref('slug'),
		},
		['url', 'path'],
	),
	'item.viewed@1': data({ itemId: id, variantId: id, price: ref('money') }, ['itemId']),
	'cart.updated@1': data(
		{
			cartId: id,
			customerId: id,
			currency: ref('currency'),
			lines: { type: 'array', maxItems: 500, items: line },
			subtotalAmount: ref('minorUnits'),
		},
		['cartId', 'currency', 'lines', 'subtotalAmount'],
	),
	'order.placed@1': data(
		{
			orderId: id,
			number: text(64),
			customerId: id,
			currency: ref('currency'),
			lines: { type: 'array', minItems: 1, maxItems: 500, items: line },
			amounts: orderAmounts,
		},
		['orderId', 'currency', 'lines', 'amounts'],
	),
	'order.paid@1': data({ orderId: id, amount: ref('money'), method: text(64), reference: text(200) }, ['orderId', 'amount']),
	'order.completed@1': data({ orderId: id }, ['orderId']),
	'order.cancelled@1': data({ orderId: id, reason: text(500) }, ['orderId']),
	'order.refunded@1': data(
		{
			orderId: id,
			amount: ref('money'),
			reason: text(500),
			lines: {
				type: 'array',
				maxItems: 500,
				items: data({ itemId: id, variantId: id, quantity: { type: 'integer', minimum: 1 } }, ['itemId', 'quantity']),
			},
		},
		['orderId', 'amount'],
	),
	'inventory.changed@1': data(
		{
			itemId: id,
			variantId: id,
			locationId: id,
			quantity: { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
			previousQuantity: { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
		},
		['itemId', 'quantity'],
	),
	'price.changed@1': data({ itemId: id, variantId: id, priceListId: id, price: ref('money'), previousPrice: ref('money') }, [
		'itemId',
		'price',
	]),
	'file.uploaded@1': data(
		{
			fileId: id,
			name: text(255),
			contentType: { type: 'string', maxLength: 255, pattern: '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$' },
			size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
		},
		['fileId', 'name', 'contentType', 'size'],
	),
});

/** Data schema for `custom.*` events: any object (merchant-defined, validated where declared). */
export const customEventDataSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: eventDataSchemaId('custom.*'),
	type: 'object',
	maxProperties: 200,
});

/**
 * Standard event data schemas as standalone schemas with `$id`s.
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
export const standardEventDataSchemas = () =>
	Object.entries(STANDARD_EVENT_DATA).map(([type, schema]) => ({
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		$id: eventDataSchemaId(type),
		...schema,
	}));
