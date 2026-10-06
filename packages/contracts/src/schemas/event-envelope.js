/**
 * Event envelope v1 (PLAN §5.2, Part E §9) and the standard event data schemas.
 * Money is integer minor units + ISO-4217 currency; when several amounts share a context (cart, order) one `currency`
 * applies to all integer `*Amount` fields; standalone values use a `money` object. Ids are opaque strings.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS, eventDataSchemaId } from './schema-ids.js';
import { PATTERNS, RESOURCE_STATUSES, commonRef as ref } from './common.js';
import { ITEM_STATUSES } from './graph/item.js';

/** Actor types that can cause an event. */
export const ACTOR_TYPES = Object.freeze(
	/** @type {const} */ (['customer', 'anonymous', 'staff', 'merchant', 'system', 'product']),
);

/**
 * Kinds of website keys an event can be ingested with: `pk` (publishable, used from browsers of the bound domain)
 * and `sk` (secret, servers only). The Portal Event Hub records the kind in `context.keyKind` on delivery.
 */
export const KEY_KINDS = Object.freeze(/** @type {const} */ (['pk', 'sk']));

/**
 * Actor types a website event may carry per ingesting key kind (the Portal refuses others with
 * `actor_not_allowed`): `pk_` keys speak only for shoppers (`customer`, `anonymous`); `sk_` keys for anyone but the
 * platform itself (`product` and `system` are reserved for products' own publishing and the Portal).
 */
export const WEBSITE_KEY_ACTORS = Object.freeze({
	pk: Object.freeze(/** @type {const} */ (['customer', 'anonymous'])),
	sk: Object.freeze(/** @type {const} */ (['customer', 'anonymous', 'staff', 'merchant'])),
});

/**
 * True when a website event ingested with a `kind` key may carry actor type `actorType` ({@link WEBSITE_KEY_ACTORS}).
 * Unknown kinds or actor types are never allowed.
 * @param {unknown} kind `'pk'` or `'sk'`
 * @param {unknown} actorType envelope `actor.type`
 * @returns {boolean}
 */
export const actorAllowedForKeyKind = (kind, actorType) =>
	(kind === 'pk' || kind === 'sk') &&
	typeof actorType === 'string' &&
	/** @type {readonly string[]} */ (WEBSITE_KEY_ACTORS[kind]).includes(actorType);

/** Where an event entered the platform. */
export const EVENT_SOURCES = Object.freeze(/** @type {const} */ (['loader', 'server', 'product', 'portal', 'import', 'webhook']));

/**
 * Event scopes: `website` events (the default) belong to one website and carry `websiteId`; `platform` events concern
 * a product or the platform as a whole (e.g. `manifest.accepted@1`) and carry no `websiteId`.
 */
export const EVENT_SCOPES = Object.freeze(/** @type {const} */ (['website', 'platform']));

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
	required: ['id', 'type', 'env', 'occurredAt', 'idempotencyKey', 'actor', 'data'],
	additionalProperties: false,
	// `websiteId` is required for website-scoped events (the default) and absent from platform-scoped ones
	if: { required: ['scope'], properties: { scope: { const: 'platform' } } },
	then: { properties: { websiteId: false } },
	else: { required: ['websiteId'], properties: { websiteId: true } },
	properties: {
		id,
		type: ref('eventType'),
		scope: { type: 'string', enum: [...EVENT_SCOPES], default: 'website' },
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
				keyKind: {
					type: 'string',
					enum: [...KEY_KINDS],
					description:
						'Kind of website key the event was ingested with (pk or sk). Set by the Portal Event Hub on delivery; producers cannot set it (the Portal strips any value it receives). Absent for events that did not come through a website key (product-published, Portal, imports).',
				},
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

const reasonCode = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-z][a-z0-9_.:-]*$' };
const signedQuantity = { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };

/** Small attribute map of catalog events (`{ color: 'red', sizes: ['S', 'M'] }`); the Graph item allows more. */
const itemAttributes = {
	type: 'object',
	maxProperties: 50,
	propertyNames: { maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
	additionalProperties: {
		anyOf: [
			{ type: ['string', 'number', 'boolean'], maxLength: 500 },
			{ type: 'array', maxItems: 20, items: { type: ['string', 'number', 'boolean'], maxLength: 500 } },
		],
	},
};

/**
 * A sellable variant in a catalog event. Prices are integer minor units in the item's `currency`; `inventory` is the
 * available quantity (negative when oversold).
 */
const itemVariant = data(
	{
		variantId: id,
		sku: text(100),
		title: text(300),
		attributes: itemAttributes,
		price: ref('minorUnits'),
		compareAtPrice: ref('minorUnits'),
		cost: ref('minorUnits'),
		inventory: signedQuantity,
	},
	['variantId', 'price'],
);

/**
 * Catalog item snapshot carried by `item.created@1` / `item.updated@1` (Website Graph item conventions, PLAN §5):
 * `currency` is the one currency of every variant amount and is required with `variants`.
 */
const itemSnapshot = {
	itemId: id,
	title: text(300),
	status: { type: 'string', enum: [...ITEM_STATUSES] },
	brand: text(200),
	collections: { type: 'array', maxItems: 100, uniqueItems: true, items: id },
	attributes: itemAttributes,
	currency: ref('currency'),
	variants: { type: 'array', maxItems: 1000, items: itemVariant },
};

/**
 * Item event data with the {@link itemSnapshot}.
 * @param {Record<string, unknown>} properties
 * @param {string[]} required
 */
const itemData = (properties, required) => ({
	...data({ ...itemSnapshot, ...properties }, required),
	dependentRequired: { variants: ['currency'] },
});

/**
 * Who an order belongs to, as an identity reference (never a profile): the Graph customer id and/or the federated
 * identity (`subject` from the website's own identity issuer, PLAN §5.3) with the identifiers the issuer asserted.
 */
const customerRef = {
	type: 'object',
	minProperties: 1,
	additionalProperties: false,
	properties: {
		customerId: id,
		subject: text(255),
		email: { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+$' },
		phone: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' },
	},
};

/**
 * Optional order context shared by the order lifecycle events after `order.placed@1` (additive within v1): who, what
 * and how much. `lines` and `amounts` are integer minor units in `currency`, which is then required.
 */
const orderContext = {
	number: text(64),
	customerId: id,
	customer: customerRef,
	currency: ref('currency'),
	lines: { type: 'array', minItems: 1, maxItems: 500, items: line },
	amounts: orderAmounts,
};

/**
 * Order event data with the optional {@link orderContext}.
 * @param {Record<string, unknown>} properties
 * @param {string[]} required
 */
const orderData = (properties, required) => ({
	...data({ ...orderContext, ...properties }, required),
	dependentRequired: { lines: ['currency'], amounts: ['currency'] },
});

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
			customer: customerRef,
			currency: ref('currency'),
			lines: { type: 'array', minItems: 1, maxItems: 500, items: line },
			amounts: orderAmounts,
		},
		['orderId', 'currency', 'lines', 'amounts'],
	),
	'order.paid@1': data({ orderId: id, amount: ref('money'), method: text(64), reference: text(200) }, ['orderId', 'amount']),
	'order.completed@1': orderData({ orderId: id }, ['orderId']),
	'order.cancelled@1': orderData({ orderId: id, reason: text(500) }, ['orderId']),
	'order.refunded@1': data(
		{
			orderId: id,
			amount: ref('money'),
			reason: text(500),
			number: text(64),
			customerId: id,
			customer: customerRef,
			// refunded lines: what came back; amounts (when given) are in `amount.currency`
			lines: {
				type: 'array',
				maxItems: 500,
				items: data(
					{
						itemId: id,
						variantId: id,
						sku: text(100),
						title: text(300),
						quantity: { type: 'integer', minimum: 1 },
						unitAmount: ref('minorUnits'),
						totalAmount: ref('minorUnits'),
					},
					['itemId', 'quantity'],
				),
			},
			amounts: data(
				{
					subtotal: ref('minorUnits'),
					discount: ref('minorUnits'),
					shipping: ref('minorUnits'),
					tax: ref('minorUnits'),
					total: ref('minorUnits'),
				},
				['total'],
			),
		},
		['orderId', 'amount'],
	),
	'item.created@1': itemData({}, ['itemId', 'title']),
	'item.updated@1': itemData({ changed: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: text(64) } }, [
		'itemId',
	]),
	'item.deleted@1': data({ itemId: id, reason: reasonCode }, ['itemId']),
	// `quantity` / `previousQuantity` are on hand; `available` / `previousAvailable` are sellable (on hand − reserved)
	'inventory.changed@1': data(
		{
			itemId: id,
			variantId: id,
			sku: text(100),
			locationId: id,
			quantity: signedQuantity,
			previousQuantity: signedQuantity,
			available: signedQuantity,
			previousAvailable: signedQuantity,
			reason: reasonCode,
		},
		['itemId', 'quantity'],
	),
	'price.changed@1': data(
		{
			itemId: id,
			variantId: id,
			sku: text(100),
			priceListId: id,
			price: ref('money'),
			previousPrice: ref('money'),
			compareAtPrice: ref('money'),
			previousCompareAtPrice: ref('money'),
			reason: reasonCode,
		},
		['itemId', 'price'],
	),
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

/** Catalogued event types that are platform-scoped (envelope `scope: 'platform'`, no `websiteId`). */
export const CORE_SCOPED_EVENTS = Object.freeze(/** @type {const} */ (['manifest.accepted@1']));

/**
 * The envelope scope an event type requires: `platform` for {@link CORE_SCOPED_EVENTS}, else `website`.
 * @param {string} type `name@version`
 * @returns {typeof EVENT_SCOPES[number]}
 */
export const eventScopeOf = (type) =>
	/** @type {readonly string[]} */ (CORE_SCOPED_EVENTS).includes(type) ? 'platform' : 'website';

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
			phase: { type: 'string', enum: ['bundle', 'load', 'placement', 'trigger', 'mount', 'render', 'hook', 'destroy'] },
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

/**
 * Catalogued element UI events, keyed by verb: `<element>.shown@1` (the Loader mounted the element; data is empty or
 * names the variant) and `<element>.action@1` (an element action ran, e.g. a service product's stub action,
 * `ss-element-stub@1`). Other verbs use {@link elementUiEventDataSchema}.
 */
export const ELEMENT_EVENT_DATA = deepFreeze({
	'shown@1': data({ variant: { type: 'string', minLength: 1, maxLength: 40, pattern: PATTERNS.elementKey } }, []),
	'action@1': data(
		{
			action: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
			ok: { type: 'boolean' },
		},
		['action'],
	),
});

/**
 * Schema id of a catalogued element UI event verb (`shown@1` → `urn:ss:contracts:v1:event:element.shown@1`).
 * @param {string} verbAtVersion
 * @returns {string}
 */
export const elementEventDataSchemaId = (verbAtVersion) => eventDataSchemaId(`element.${verbAtVersion}`);

/**
 * Catalogued element UI event data schemas as standalone schemas with `$id`s.
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
export const elementEventDataSchemas = () =>
	Object.entries(ELEMENT_EVENT_DATA).map(([verb, schema]) => ({
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		$id: elementEventDataSchemaId(verb),
		...schema,
	}));

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
