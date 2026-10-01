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
const requires = {
	type: 'object',
	additionalProperties: false,
	properties: { resources: { type: 'array', uniqueItems: true, items: ref('resourceKind') } },
};

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
		budget: {
			type: 'object',
			required: ['js'],
			additionalProperties: false,
			properties: {
				js: { type: 'integer', minimum: 0, maximum: 1024, description: 'Mode A bundle budget in KB; 0 = no UI.' },
			},
		},
		dependsOn: { type: 'array', maxItems: 50, uniqueItems: true, items: ref('elementKey') },
		requires,
		features: { $ref: SCHEMA_IDS.featureSchema },
		strings: ref('relativePath'),
		placement: { type: 'boolean' },
		rules: names(PATTERNS.elementKey, 50),
		hooks: names(PATTERNS.hookName, 50),
		customFields: names(PATTERNS.elementKey, 50),
		experiments: { type: 'boolean' },
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
				demo: path,
				events: path,
				register: path,
			},
		},
		capabilities: {
			type: 'object',
			additionalProperties: false,
			properties: {
				adminLaunch: { type: 'boolean' },
				sandbox: { type: 'boolean' },
				localEnforcement: {
					type: 'array',
					uniqueItems: true,
					items: { type: 'string', maxLength: 100, pattern: '^(?:flag|quota|limit|rate):[a-z][a-z0-9_.]*$' },
				},
				offlineGrace: ref('duration'),
			},
		},
		scopes: names(PATTERNS.scope, 200),
		requires,
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
				required: ['base', 'register', 'events'],
				properties: { base: true, register: true, events: true },
			},
		},
	},
});
