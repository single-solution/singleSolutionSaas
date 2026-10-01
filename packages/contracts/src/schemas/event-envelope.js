/**
 * Event envelope v1 (PLAN §5.2, Part E §9) and the standard event data schemas.
 * Money is integer minor units + ISO-4217 currency; when several amounts share a context (cart, order) one `currency`
 * applies to all integer `*Amount` fields; standalone values use a `money` object. Ids are opaque strings.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS, eventDataSchemaId } from './schema-ids.js';
import { PATTERNS, RESOURCE_STATUSES, commonRef as ref } from './common.js';

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

const reasonCode = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-z][a-z0-9_.:-]*$' };
const subscriptionLifecycle = data({ subscriptionId: ref('subscriptionId'), websiteId: ref('websiteId'), reason: reasonCode }, [
	'subscriptionId',
	'websiteId',
]);
const ms = { type: 'number', minimum: 0, maximum: 3_600_000 };

/**
 * Platform control events (Portal → product). Only the Portal publishes these; products may consume them.
 * Resource `status` uses {@link RESOURCE_STATUSES}, the same vocabulary as entitlement documents.
 */
export const CONTROL_EVENT_DATA = deepFreeze({
	'entitlement.changed@1': data(
		{
			subscriptionId: ref('subscriptionId'),
			websiteId: ref('websiteId'),
			version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
			document: {
				type: 'string',
				maxLength: 65_536,
				pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+$',
				description: 'Signed entitlement document as a compact JWS.',
			},
		},
		['subscriptionId', 'websiteId', 'version'],
	),
	'key.revoked@1': data(
		{ keyIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: id }, revokedAt: ref('timestamp') },
		['keyIds', 'revokedAt'],
	),
	'resource.changed@1': data(
		{
			websiteId: ref('websiteId'),
			kind: ref('resourceKind'),
			status: { type: 'string', enum: [...RESOURCE_STATUSES] },
			ref: id,
		},
		['websiteId', 'kind', 'status', 'ref'],
	),
	'subscription.activated@1': subscriptionLifecycle,
	'subscription.paused@1': subscriptionLifecycle,
	'subscription.resumed@1': subscriptionLifecycle,
	'subscription.cancelled@1': subscriptionLifecycle,
	'manifest.accepted@1': data({ appId: id, version: ref('semver') }, ['appId', 'version']),
});

/** Loader events (website → Portal), emitted by the web SDK only. */
export const LOADER_EVENT_DATA = deepFreeze({
	'loader.vitals@1': data(
		{
			lcp: ms,
			cls: { type: 'number', minimum: 0, maximum: 100 },
			inp: ms,
			elements: {
				type: 'array',
				maxItems: 200,
				items: data({ key: ref('elementKey'), mountMs: ms }, ['key', 'mountMs']),
			},
			sampled: { const: true },
		},
		['elements', 'sampled'],
	),
	'loader.element_failed@1': data(
		{
			element: ref('elementKey'),
			code: { type: 'string', minLength: 1, maxLength: 64, pattern: PATTERNS.elementKey },
			message: text(500),
		},
		['element', 'code', 'message'],
	),
});

/** Largest serialized size (UTF-16 code units of `JSON.stringify`) of an element UI event's data. */
export const ELEMENT_UI_EVENT_MAX_BYTES = 8192;

/** Data schema for element UI events (`<element>.<verb>@1`): products define the payload, so only the size is capped. */
export const elementUiEventDataSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: eventDataSchemaId('element-ui'),
	type: 'object',
	maxProperties: 50,
});

const SNAKE = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*';
const ELEMENT_UI_EVENT = new RegExp(`^(${SNAKE})\\.(${SNAKE})@1$`);

/**
 * Namespaces that are never element UI events: standard, control, loader and custom events.
 * @returns {ReadonlySet<string>}
 */
const reservedNamespaces = () =>
	new Set(
		[
			...Object.keys(STANDARD_EVENT_DATA),
			...Object.keys(CONTROL_EVENT_DATA),
			...Object.keys(LOADER_EVENT_DATA),
			'custom.x@1',
		].map((type) => type.split('.')[0] ?? ''),
	);

/** Namespaces reserved for catalogued events. */
export const RESERVED_EVENT_NAMESPACES = Object.freeze([...reservedNamespaces()]);

/**
 * True when `type` has the element UI event shape `<element>.<verb>@1` (both snake_case) outside reserved namespaces.
 * @param {unknown} type
 * @returns {boolean}
 */
export const isElementUiEvent = (type) => {
	if (typeof type !== 'string') return false;
	const match = ELEMENT_UI_EVENT.exec(type);
	return match !== null && match[1] !== undefined && match[1].length <= 40 && !RESERVED_EVENT_NAMESPACES.includes(match[1]);
};

/** Every catalogued event data schema keyed by `type@v`: standard, control and loader. */
export const EVENT_CATALOGUE = deepFreeze({ ...STANDARD_EVENT_DATA, ...CONTROL_EVENT_DATA, ...LOADER_EVENT_DATA });

/**
 * Catalogued event data schemas as standalone schemas with `$id`s.
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
export const catalogueEventDataSchemas = () =>
	Object.entries(EVENT_CATALOGUE).map(([type, schema]) => ({
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		$id: eventDataSchemaId(type),
		...schema,
	}));

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
