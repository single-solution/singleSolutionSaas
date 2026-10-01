/**
 * Event envelopes for the injector (`ss dev emit`) and certification: a valid sample `data` for every catalogued event
 * type (standard, control, loader and element UI events), envelope construction.
 *
 * Samples are generated from the `@ss/contracts` data schemas ({@link sampleFromSchema}: required members, types,
 * enums, `const`, formats, lengths, bounds and patterns where feasible) and hand-tuned where generation would be
 * poor ({@link HAND_TUNED}).
 * @module
 */
import {
	CONTROL_EVENT_DATA,
	ELEMENT_EVENT_DATA,
	EVENT_CATALOGUE,
	LOADER_EVENT_DATA,
	STANDARD_EVENT_DATA,
	SCHEMA_IDS,
	commonSchema,
	createId,
	eventGlobMatches,
	eventScopeOf,
	isElementUiEvent,
	isEventGlob,
} from '@ss/contracts';

/**
 * What a sample may depend on: the envelope's website (control events name it in their data too).
 * @typedef {{ websiteId?: string }} SampleContext
 */

/** @typedef {(context?: SampleContext) => Record<string, unknown>} SampleFactory */

const DEV_WEBSITE = 'web_devwebsite01';
const DEV_ITEM = 'itm_devitem000001';
const DEV_CUSTOMER = 'cus_devcustomer01';
const SAMPLE_TIME = '2026-10-01T00:00:00Z';

/** Candidate strings tried, in order, against a schema `pattern` (and length bounds) that has no known sample. */
const STRING_CANDIDATES = Object.freeze([
	'sample',
	'sample_1',
	'Sample',
	'sample-1',
	'USD',
	'US',
	'en',
	'1.0.0',
	'/',
	'12:00',
	'+15555550100',
	'dev@example.com',
	'https://shop.example.com/',
	'image/png',
	'a',
	'A',
	'1',
	'x1',
]);

/** Samples for the common `$defs` whose patterns are not worth generating. */
const COMMON_SAMPLES = Object.freeze({
	timestamp: () => SAMPLE_TIME,
	currency: () => 'USD',
	country: () => 'US',
	locale: () => 'en',
	opaqueId: () => 'sample_1',
	subscriptionId: () => createId('sub'),
	websiteId: () => createId('web'),
	merchantId: () => createId('mer'),
	semver: () => '1.0.0',
	slug: () => 'sample',
	elementKey: () => 'sample',
	planCode: () => 'starter',
	eventType: () => 'custom.sample@1',
	eventTypeGlob: () => 'custom.*',
	duration: () => 'PT1H',
	hostname: () => 'shop.example.com',
	env: () => 'test',
});

const COMMON_PREFIX = `${SCHEMA_IDS.common}#/$defs/`;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A string for a string schema: format, enum/const, then pattern candidates, then a padded filler.
 * @param {Record<string, any>} schema
 * @returns {string}
 */
const sampleString = (schema) => {
	const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
	const max = typeof schema.maxLength === 'number' ? schema.maxLength : Number.POSITIVE_INFINITY;
	switch (schema.format) {
		case 'date-time':
			return SAMPLE_TIME;
		case 'date':
			return SAMPLE_TIME.slice(0, 10);
		case 'uri':
		case 'url':
			return 'https://shop.example.com/';
		case 'email':
			return 'dev@example.com';
		case 'duration':
			return 'PT1H';
		case 'uuid':
			return '00000000-0000-4000-8000-000000000000';
		default:
	}
	const fits = (/** @type {string} */ value) => value.length >= min && value.length <= max;
	if (typeof schema.pattern === 'string') {
		const pattern = new RegExp(schema.pattern, 'u');
		const found = STRING_CANDIDATES.find((candidate) => fits(candidate) && pattern.test(candidate));
		if (found !== undefined) return found;
	}
	const base = 'sample';
	return base.length >= min ? base.slice(0, Math.max(1, Math.min(base.length, max))) : base.padEnd(min, 'x');
};

/**
 * A number within the schema's bounds (1 when allowed, else the lower bound).
 * @param {Record<string, any>} schema
 * @param {boolean} integer
 * @returns {number}
 */
const sampleNumber = (schema, integer) => {
	const step = integer ? 1 : 0.5;
	const lower =
		typeof schema.exclusiveMinimum === 'number'
			? schema.exclusiveMinimum + step
			: typeof schema.minimum === 'number'
				? schema.minimum
				: Number.NEGATIVE_INFINITY;
	const upper =
		typeof schema.exclusiveMaximum === 'number'
			? schema.exclusiveMaximum - step
			: typeof schema.maximum === 'number'
				? schema.maximum
				: Number.POSITIVE_INFINITY;
	if (lower <= 1 && upper >= 1) return 1;
	if (lower <= 0 && upper >= 0) return 0;
	return Number.isFinite(lower) ? (integer ? Math.ceil(lower) : lower) : integer ? Math.floor(upper) : upper;
};

/**
 * A minimal instance that is valid against a contracts data schema: required members (plus `dependentRequired` and
 * enough optional members for `minProperties`), the first `enum`/`const`/`anyOf`/`oneOf` branch, formats, length
 * and numeric bounds, `minItems`, and `pattern`s through a list of candidate strings. Common `$defs` references
 * resolve to fixed samples. Not a general JSON Schema generator: `if`/`then`, `not` and `allOf` are ignored.
 * @param {unknown} schema
 * @param {number} [depth]
 * @returns {unknown}
 */
export const sampleFromSchema = (schema, depth = 0) => {
	if (!isRecord(schema) || depth > 12) return {};
	if (typeof schema.$ref === 'string') {
		// `urn:…:common#/$defs/x` from data schemas, `#/$defs/x` inside the common schema itself
		const name = schema.$ref.startsWith(COMMON_PREFIX)
			? schema.$ref.slice(COMMON_PREFIX.length)
			: schema.$ref.startsWith('#/$defs/')
				? schema.$ref.slice('#/$defs/'.length)
				: '';
		if (Object.hasOwn(COMMON_SAMPLES, name)) return COMMON_SAMPLES[/** @type {keyof typeof COMMON_SAMPLES} */ (name)]();
		const definition = /** @type {Record<string, unknown>} */ (commonSchema.$defs)[name];
		return sampleFromSchema(definition, depth + 1);
	}
	if (Object.hasOwn(schema, 'const')) return schema.const;
	if (Array.isArray(schema.enum)) return schema.enum[0];
	if (Array.isArray(schema.anyOf)) return sampleFromSchema(schema.anyOf[0], depth + 1);
	if (Array.isArray(schema.oneOf)) return sampleFromSchema(schema.oneOf[0], depth + 1);
	const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? (schema.properties ? 'object' : undefined)];
	const type = types.find((candidate) => candidate !== 'null') ?? types[0];
	switch (type) {
		case 'string':
			return sampleString(schema);
		case 'integer':
			return sampleNumber(schema, true);
		case 'number':
			return sampleNumber(schema, false);
		case 'boolean':
			return true;
		case 'null':
			return null;
		case 'array': {
			const count = typeof schema.minItems === 'number' ? schema.minItems : 0;
			return Array.from({ length: count }, (_, index) => {
				const item = sampleFromSchema(schema.items, depth + 1);
				return schema.uniqueItems === true && typeof item === 'string' && index > 0 ? `${item}${index}` : item;
			});
		}
		case 'object': {
			const properties = isRecord(schema.properties) ? schema.properties : {};
			/** @type {Set<string>} */
			const keys = new Set(Array.isArray(schema.required) ? schema.required : []);
			const dependent = isRecord(schema.dependentRequired) ? schema.dependentRequired : {};
			const minProperties = typeof schema.minProperties === 'number' ? schema.minProperties : 0;
			for (const name of Object.keys(properties)) {
				if (keys.size >= minProperties) break;
				keys.add(name);
			}
			for (const name of [...keys]) for (const extra of dependent[name] ?? []) keys.add(extra);
			return Object.fromEntries([...keys].map((name) => [name, sampleFromSchema(properties[name], depth + 1)]));
		}
		default:
			return {};
	}
};

const line = { itemId: DEV_ITEM, sku: 'SKU-1', title: 'Sample item', quantity: 1, unitAmount: 2500, totalAmount: 2500 };
const orderNumber = () => String(1000 + Math.floor(Math.random() * 9000));
/** @param {SampleContext} [context] */
const websiteOf = (context) => context?.websiteId ?? DEV_WEBSITE;
/** @param {SampleContext} [context] */
const lifecycle = (context) => ({ subscriptionId: 'sub_devsubscript01', websiteId: websiteOf(context), reason: 'dev' });

/**
 * Hand-tuned samples (realistic values that read well in logs and exercise products' handlers).
 * @type {Readonly<Record<string, SampleFactory>>}
 */
export const HAND_TUNED = Object.freeze({
	'order.placed@1': () => ({
		orderId: createId('ord'),
		number: orderNumber(),
		customerId: DEV_CUSTOMER,
		currency: 'USD',
		lines: [line],
		amounts: { subtotal: 2500, total: 2500 },
	}),
	'order.paid@1': () => ({ orderId: createId('ord'), amount: { amount: 2500, currency: 'USD' }, method: 'card' }),
	'order.completed@1': () => ({ orderId: createId('ord') }),
	'order.cancelled@1': () => ({ orderId: createId('ord'), reason: 'customer request' }),
	'order.refunded@1': () => ({
		orderId: createId('ord'),
		amount: { amount: 2500, currency: 'USD' },
		reason: 'damaged',
		customerId: DEV_CUSTOMER,
		lines: [{ itemId: DEV_ITEM, quantity: 1, unitAmount: 2500, totalAmount: 2500 }],
	}),
	'cart.updated@1': () => ({
		cartId: 'cart_devcart01',
		currency: 'USD',
		lines: [{ itemId: DEV_ITEM, quantity: 2, unitAmount: 2500 }],
		subtotalAmount: 5000,
	}),
	'customer.created@1': () => ({ customerId: createId('cus'), identities: [{ type: 'email', value: 'dev@example.com' }] }),
	'customer.updated@1': () => ({ customerId: DEV_CUSTOMER, changed: ['name'] }),
	'customer.signed_in@1': () => ({ customerId: DEV_CUSTOMER, method: 'password' }),
	'page.viewed@1': () => ({ url: 'https://shop.example.com/', path: '/', title: 'Home' }),
	'item.viewed@1': () => ({ itemId: DEV_ITEM, price: { amount: 2500, currency: 'USD' } }),
	'item.created@1': () => ({
		itemId: DEV_ITEM,
		title: 'Sample item',
		status: 'active',
		brand: 'Dev Brand',
		collections: ['col_devcollection1'],
		attributes: { material: 'cotton' },
		currency: 'USD',
		variants: [{ variantId: 'var_devvariant0001', sku: 'SKU-1', title: 'Default', price: 2500, inventory: 5 }],
	}),
	'item.updated@1': () => ({
		itemId: DEV_ITEM,
		title: 'Sample item (updated)',
		changed: ['title'],
		currency: 'USD',
		variants: [{ variantId: 'var_devvariant0001', sku: 'SKU-1', price: 2000, compareAtPrice: 2500 }],
	}),
	'item.deleted@1': () => ({ itemId: DEV_ITEM, reason: 'discontinued' }),
	'inventory.changed@1': () => ({
		itemId: DEV_ITEM,
		variantId: 'var_devvariant0001',
		sku: 'SKU-1',
		quantity: 5,
		previousQuantity: 0,
		available: 5,
		previousAvailable: 0,
		reason: 'restock',
	}),
	'price.changed@1': () => ({
		itemId: DEV_ITEM,
		variantId: 'var_devvariant0001',
		sku: 'SKU-1',
		price: { amount: 2000, currency: 'USD' },
		previousPrice: { amount: 2500, currency: 'USD' },
		reason: 'sale',
	}),
	'file.uploaded@1': () => ({ fileId: createId('fil'), name: 'photo.png', contentType: 'image/png', size: 20_480 }),
	'entitlement.changed@1': (context) => ({ subscriptionId: 'sub_devsubscript01', websiteId: websiteOf(context), version: 1 }),
	'key.revoked@1': () => ({ keyIds: ['key_devrevoked0001'], revokedAt: SAMPLE_TIME }),
	'resource.changed@1': (context) => ({
		websiteId: websiteOf(context),
		kind: 'database',
		status: 'connected',
		ref: 'res_devdatabase01',
	}),
	'subscription.activated@1': lifecycle,
	'subscription.paused@1': lifecycle,
	'subscription.resumed@1': lifecycle,
	'subscription.cancelled@1': lifecycle,
	'manifest.accepted@1': () => ({ appId: 'app_devapplication1', version: '1.0.0' }),
	'loader.vitals@1': () => ({ lcp: 1200, cls: 0.02, inp: 80, elements: [{ key: 'sample', mountMs: 12 }], sampled: true }),
	'loader.element_failed@1': () => ({ element: 'sample', phase: 'mount', code: 'render_error', message: 'Sample failure' }),
});

/** @param {unknown} schema */
const generated = (schema) =>
	/** @type {SampleFactory} */ (() => /** @type {Record<string, unknown>} */ (sampleFromSchema(schema)));

/**
 * Sample `data` for every catalogued event type (`EVENT_CATALOGUE`: standard, control and loader events), keyed
 * `type@v`, in catalogue order (overridable with `--data`). Element UI events are covered by {@link sampleData}.
 * @type {Readonly<Record<string, SampleFactory>>}
 */
export const SAMPLE_DATA = Object.freeze(
	Object.fromEntries(
		[...Object.keys(STANDARD_EVENT_DATA), ...Object.keys(CONTROL_EVENT_DATA), ...Object.keys(LOADER_EVENT_DATA)].map((type) => [
			type,
			Object.hasOwn(HAND_TUNED, type)
				? /** @type {SampleFactory} */ (HAND_TUNED[type])
				: generated(/** @type {Record<string, unknown>} */ (EVENT_CATALOGUE)[type]),
		]),
	),
);

/**
 * Sample `data` for any event type: the catalogue sample, a catalogued element UI verb (`<element>.shown@1`,
 * `<element>.action@1`), else `{}` (custom and product events).
 * @param {string} type `type@v`
 * @param {SampleContext} [context]
 * @returns {Record<string, unknown>}
 */
export const sampleData = (type, context) => {
	if (Object.hasOwn(SAMPLE_DATA, type)) return /** @type {SampleFactory} */ (SAMPLE_DATA[type])(context);
	const verb = type.slice(type.indexOf('.') + 1);
	if (isElementUiEvent(type) && Object.hasOwn(ELEMENT_EVENT_DATA, verb))
		return /** @type {Record<string, unknown>} */ (
			sampleFromSchema(/** @type {Record<string, unknown>} */ (ELEMENT_EVENT_DATA)[verb])
		);
	return {};
};

/**
 * `order.placed` → `order.placed@1`.
 * @param {string} type
 * @returns {string}
 */
export const withVersion = (type) => (type.includes('@') ? type : `${type}@1`);

/**
 * Build an envelope. Platform-scoped types (`manifest.accepted@1`) get `scope: 'platform'` and no `websiteId`;
 * element UI events name their element in `context.element`.
 * @param {{ type: string, websiteId: string, env: 'live' | 'test', data?: Record<string, unknown>, id?: string, now: number }} input
 * @returns {import('@ss/contracts').EventEnvelope}
 */
export const buildEnvelope = ({ type, websiteId, env, data, id, now }) => {
	const typed = withVersion(type);
	const eventId = id ?? createId('evt');
	const platform = eventScopeOf(typed) === 'platform';
	const element = isElementUiEvent(typed) ? typed.split('.')[0] : undefined;
	return /** @type {import('@ss/contracts').EventEnvelope} */ ({
		id: eventId,
		type: typed,
		...(platform ? { scope: 'platform' } : { websiteId }),
		env,
		occurredAt: new Date(now).toISOString(),
		idempotencyKey: eventId,
		actor: { type: 'system' },
		data: data ?? sampleData(typed, { websiteId }),
		context: { source: 'portal', ...(element ? { element } : {}) },
	});
};

/**
 * A concrete event type for a consumed `events.consumes` entry: the entry itself when exact, else the first catalogued
 * event (catalogue order) matching the glob, or `custom.ss_probe@1` for `custom.*` globs. `null` when no deliverable
 * type matches (e.g. a glob over the product's own namespace).
 * @param {string} entry
 * @returns {string | null}
 */
export const concreteEventType = (entry) => {
	if (!isEventGlob(entry)) return entry;
	const candidates = [...Object.keys(SAMPLE_DATA), 'custom.ss_probe@1'];
	return candidates.find((type) => eventGlobMatches(entry, type)) ?? null;
};
