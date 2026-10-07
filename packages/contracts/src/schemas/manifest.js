/**
 * SSPS v1 product manifest (PLAN Part E §3).
 *
 * Per-plan defaults and maxima live only in feature schemas (`x-plan`); plans list elements.
 * Prices (and the credit ledger) are integers in **millicredits** (1 credit = {@link MILLICREDITS_PER_CREDIT} millicredits) so no price is ever
 * a float. A metered price is `perUnit` millicredits for every `per` units (default 1), which expresses any fraction.
 * Rules JSON Schema cannot express (key uniqueness, references, acyclicity, mode rules, plan coverage, event scopes, pack restrictions) live in
 * `manifest-semantics.js`.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { MAX_SAFE, MODES, PATTERNS, commonRef as ref } from './common.js';

/** Millicredits per credit (1 credit = 1000). Millicredits are canonical everywhere: prices and the ledger. */
export const MILLICREDITS_PER_CREDIT = 1000;

/** A string catalog key, or a key prefix ending in `*` (element `stringKeys`). */
export const STRING_KEY_PATTERN = '^[A-Za-z][\\w.-]*\\*?$';

/** Product kinds. */
export const PRODUCT_KINDS = Object.freeze(/** @type {const} */ (['service', 'pack']));

const millicredits = { type: 'integer', minimum: 0, maximum: MAX_SAFE, description: 'Integer millicredits.' };
const path = { type: 'string', maxLength: 200, pattern: '^/[A-Za-z0-9_./~-]*$' };
/**
 * @param {string} pattern
 * @param {number} [max]
 */
const names = (pattern, max = 100) => ({
	type: 'array',
	maxItems: max,
	uniqueItems: true,
	items: { type: 'string', minLength: 1, maxLength: 64, pattern },
});
/** @param {string} description */
const requiresOf = (description) => ({
	type: 'object',
	additionalProperties: false,
	properties: { resources: { type: 'array', uniqueItems: true, items: ref('resourceKind'), description } },
});
const elementRequires = {
	type: 'object',
	additionalProperties: false,
	properties: {
		resources: {
			type: 'array',
			uniqueItems: true,
			items: ref('resourceKind'),
			description:
				'Client resource kinds this element needs; the element is disabled (resource_missing) while one is not connected.',
		},
		optionalResources: {
			type: 'array',
			uniqueItems: true,
			items: ref('resourceKind'),
			description:
				'Client resource kinds this element uses when connected; a missing one never disables it (the kit reports whether it is connected).',
		},
	},
};
const productRequires = requiresOf(
	'Client resource kinds every subscription needs, whatever elements are enabled; while one is not connected every element is disabled (resource_missing). Kinds only some elements need belong on those elements.',
);

const element = {
	type: 'object',
	required: ['key', 'name', 'modes', 'price'],
	additionalProperties: false,
	properties: {
		key: ref('elementKey'),
		name: { type: 'string', minLength: 1, maxLength: 80 },
		description: { type: 'string', maxLength: 2000 },
		modes: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: [...MODES] } },
		stateful: { type: 'boolean', description: 'Element keeps state; Mode C is then mandatory.' },
		price: {
			type: 'object',
			required: ['hourly'],
			additionalProperties: false,
			properties: {
				hourly: millicredits,
				metered: {
					type: 'array',
					maxItems: 20,
					items: {
						type: 'object',
						required: ['unit', 'perUnit'],
						additionalProperties: false,
						properties: {
							unit: { type: 'string', minLength: 1, maxLength: 40, pattern: PATTERNS.elementKey },
							perUnit: millicredits,
							per: { type: 'integer', minimum: 1, maximum: MAX_SAFE, default: 1 },
							included: {
								type: 'object',
								propertyNames: ref('planCode'),
								additionalProperties: { type: 'integer', minimum: 0, maximum: MAX_SAFE },
							},
						},
					},
				},
			},
		},
		dependsOn: { type: 'array', maxItems: 50, uniqueItems: true, items: ref('elementKey') },
		requires: elementRequires,
		features: { $ref: SCHEMA_IDS.featureSchema },
		strings: ref('relativePath'),
		stringKeys: {
			type: 'array',
			minItems: 1,
			maxItems: 100,
			uniqueItems: true,
			items: { type: 'string', minLength: 1, maxLength: 120, pattern: STRING_KEY_PATTERN },
			description:
				'The keys of the product catalogs strings/<lang>.json this element renders: exact keys, or prefixes ending in `*` (default `<key>.*`). The Portal slices them per element and language at compile time.',
		},
		placement: { type: 'boolean' },
		rules: names(PATTERNS.elementKey, 50),
		hooks: names(PATTERNS.hookName, 50),
		customFields: names(PATTERNS.elementKey, 50),
		api: {
			type: 'object',
			additionalProperties: false,
			properties: { resources: names(PATTERNS.resourceName, 100) },
		},
		headless: { anyOf: [ref('moduleRef'), { type: 'null' }] },
		renderer: { anyOf: [ref('moduleRef'), { type: 'null' }] },
		variants: names(PATTERNS.slug, 50),
		slots: names(PATTERNS.slug, 50),
		a11y: {
			type: 'object',
			additionalProperties: false,
			properties: {
				role: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z]+$' },
				labels: { type: 'boolean' },
				keyboard: { type: 'boolean' },
				reducedMotion: { type: 'boolean' },
			},
		},
	},
};

/** The manifest schema. */
export const manifestSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.manifest,
	title: 'SSPS v1 product manifest',
	type: 'object',
	required: ['ssps', 'product', 'elements', 'priceBook'],
	additionalProperties: false,
	properties: {
		ssps: { const: '1' },
		product: {
			type: 'object',
			required: ['slug', 'name', 'kind', 'version', 'category'],
			additionalProperties: false,
			properties: {
				slug: ref('slug'),
				name: { type: 'string', minLength: 1, maxLength: 80 },
				kind: { type: 'string', enum: [...PRODUCT_KINDS] },
				version: ref('semver'),
				category: ref('slug'),
				description: { type: 'string', maxLength: 2000 },
			},
		},
		endpoints: {
			type: 'object',
			required: ['base'],
			additionalProperties: false,
			properties: {
				base: { type: 'string', format: 'uri', maxLength: 500, pattern: '^https://' },
				dashboard: path,
				events: path,
			},
		},
		capabilities: {
			type: 'object',
			additionalProperties: false,
			properties: {
				adminLaunch: { type: 'boolean' },
				identityIssuer: { type: 'boolean' },
			},
		},
		scopes: names(PATTERNS.scope, 200),
		requires: productRequires,
		reads: {
			type: 'array',
			maxItems: 20,
			description:
				"Service products whose public read API the elements call. The Loader passes each element an API client per listed product that is active on the website, bound to its base URL and the website's pk_ key.",
			items: {
				anyOf: [
					ref('slug'),
					{
						type: 'object',
						required: ['product'],
						additionalProperties: false,
						properties: {
							product: ref('slug'),
							scopes: {
								type: 'array',
								minItems: 1,
								maxItems: 10,
								uniqueItems: true,
								items: { type: 'string', pattern: PATTERNS.scope, maxLength: 64 },
							},
						},
					},
				],
			},
		},
		events: {
			type: 'object',
			additionalProperties: false,
			properties: {
				consumes: { type: 'array', maxItems: 200, uniqueItems: true, items: ref('eventTypeGlob') },
				publishes: { type: 'array', maxItems: 200, uniqueItems: true, items: ref('eventType') },
			},
		},
		elements: { type: 'array', minItems: 1, maxItems: 200, items: element },
		plans: {
			type: 'array',
			maxItems: 20,
			items: {
				type: 'object',
				required: ['code', 'elements'],
				additionalProperties: false,
				properties: {
					code: ref('planCode'),
					name: { type: 'string', minLength: 1, maxLength: 80 },
					elements: { type: 'array', uniqueItems: true, items: ref('elementKey'), description: 'Included, on by default.' },
					addons: { type: 'array', uniqueItems: true, items: ref('elementKey'), description: 'Allowed, off by default.' },
					description: { type: 'string', maxLength: 2000 },
				},
			},
		},
		priceBook: {
			type: 'object',
			required: ['version', 'effectiveFrom'],
			additionalProperties: false,
			properties: {
				version: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[0-9A-Za-z][0-9A-Za-z._-]*$' },
				effectiveFrom: ref('timestamp'),
			},
		},
		trialHours: { type: 'integer', minimum: 0, maximum: 8760 },
		retention: {
			type: 'object',
			maxProperties: 200,
			propertyNames: { pattern: '^[a-z][a-z0-9_]*$', maxLength: 64 },
			additionalProperties: ref('duration'),
		},
	},
	if: {
		type: 'object',
		required: ['product'],
		properties: { product: { type: 'object', required: ['kind'], properties: { kind: { const: 'service' } } } },
	},
	then: {
		required: ['endpoints'],
		properties: {
			endpoints: {
				type: 'object',
				required: ['base', 'events'],
				properties: { base: true, events: true },
			},
		},
	},
});
