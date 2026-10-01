import { deepEqual } from './hash.js';
import { toMs } from './time.js';
import { assertMillicredits, normaliseRate } from './units.js';

/**
 * Catalog normalisation: turns a validated `@ss/contracts` manifest (SSPS v1) into the canonical shape
 * every other module consumes. The manifest is assumed to have passed contracts validation; this module
 * re-checks only what the commerce core depends on and throws `Error` with `code = 'catalog/<reason>'`.
 *
 * Mapping from the manifest:
 * - element `features` is a JSON Schema object; each top-level property is a feature. Metadata keywords:
 *   `x-kind` (flag|quota|limit|rate|config; inferred as `flag` for booleans, `config` otherwise), `x-lock`
 *   (lockable, default true), `x-experiment`, `x-plan` ({ planCode: { default?, max? } } — the only source of
 *   per-plan bounds), quota `x-period` / `x-hardStop` / `x-unit`, rate `x-per` / `x-unit`.
 * - plans `{ code, name?, description?, elements, addons? }`: `elements` are included and on by default,
 *   `addons` are allowed but off by default; anything else is unavailable on that plan.
 * - element `requires` is `{ resources: [resourceKind] }` (a bare array is accepted too). The product-level
 *   `requires.resources` means "always required": those kinds are added to every element's `requires`, so a
 *   product-level kind that is not connected disables every element (`resource_missing`).
 * - prices are integer millicredits: `price.hourly`, `price.metered[] = { unit, perUnit, per = 1, included }`.
 * - `priceBook` is `{ version, effectiveFrom }`; the Portal may pass the full history as `priceBooks[]`
 *   (each optionally with `base`, `elements` and `metered` overrides, all integer millicredits).
 */

/** @typedef {'flag' | 'quota' | 'limit' | 'rate' | 'config'} FeatureKind */
/** @typedef {'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'} JsonType */
/** @typedef {'hour' | 'day' | 'week' | 'month'} PeriodUnit */
/** @typedef {'second' | 'minute' | 'hour'} RateWindow */
/** @typedef {import('./units.js').Rate} Rate */

/**
 * @typedef {object} FeatureSchemaNode A top-level feature schema node (contracts feature-schema subset).
 * @property {JsonType} type
 * @property {string} [title]
 * @property {unknown} [default]
 * @property {readonly unknown[]} [enum]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {unknown} [items] Nested item schema (not interpreted here).
 * @property {unknown} [properties] Nested property schemas (not interpreted here).
 * @property {unknown} [x-ui] UI hints (ignored).
 * @property {FeatureKind} [x-kind]
 * @property {boolean} [x-lock]
 * @property {boolean} [x-experiment]
 * @property {Readonly<Record<string, { default?: unknown, max?: number | boolean }>>} [x-plan]
 * @property {PeriodUnit} [x-period]
 * @property {boolean} [x-hardStop]
 * @property {string} [x-unit]
 * @property {RateWindow} [x-per]
 */

/**
 * @typedef {object} FeatureDef
 * @property {string} key Fully-qualified key `element.name`.
 * @property {string} element
 * @property {string} name
 * @property {FeatureKind} kind
 * @property {JsonType} jsonType
 * @property {unknown} default Product default value.
 * @property {number | null} min Absolute lower bound for numeric JSON types (quota/limit/rate default 0).
 * @property {number | null} max Absolute upper bound for numeric JSON types.
 * @property {readonly unknown[] | null} enum
 * @property {boolean} lockable `x-lock` (default true).
 * @property {boolean} experiment `x-experiment` (default false).
 * @property {PeriodUnit | null} period Quota period (`x-period`, required on quotas).
 * @property {boolean} hardStop Quota blocks once exhausted (`x-hardStop`, default true).
 * @property {string | null} unit Metered unit (`x-unit`).
 * @property {RateWindow | null} per Rate window (`x-per`, required on rates).
 * @property {Readonly<Record<string, { default?: unknown, max?: number | boolean }>>} plans `x-plan`.
 * @property {FeatureSchemaNode} schema The original schema node (for full validation by callers).
 */

/**
 * @typedef {object} ElementDef
 * @property {string} key
 * @property {string} name
 * @property {readonly string[]} dependsOn Direct dependencies (sorted).
 * @property {readonly string[]} requires Resource kinds that must be connected (sorted): the element's own kinds plus
 *   the product-level (always required) kinds.
 * @property {boolean} defaultEnabled Product default when the subscription has no plan (default false).
 * @property {readonly string[]} features Fully-qualified feature keys (sorted).
 */

/**
 * @typedef {object} PlanDef
 * @property {string} code
 * @property {string} name
 * @property {readonly string[]} elements Included, on by default.
 * @property {readonly string[]} addons Allowed, off by default.
 * @property {readonly string[]} available `elements ∪ addons` (sorted).
 * @property {Readonly<Record<string, unknown>>} defaults Feature defaults from `x-plan`, by feature key.
 * @property {Readonly<Record<string, number | boolean>>} max Plan maxima from `x-plan`, by feature key.
 */

/**
 * @typedef {object} MeteredUnit
 * @property {string} unit
 * @property {string} element
 * @property {Readonly<Record<string, number>>} included Included units per period by plan code.
 * @property {Rate} overage `perUnit` millicredits per `per` units.
 */

/**
 * @typedef {object} PriceBook
 * @property {string} version
 * @property {number} effectiveFrom Epoch ms.
 * @property {number} baseHourly Product base price per hour in millicredits (0 unless a price book sets `base`).
 * @property {Readonly<Record<string, number>>} elements Hourly price per element in millicredits.
 * @property {Readonly<Record<string, MeteredUnit>>} metered Metered units by unit name.
 */

/**
 * @typedef {object} Product
 * @property {string} slug
 * @property {string} version
 * @property {Readonly<Record<string, ElementDef>>} elements
 * @property {Readonly<Record<string, FeatureDef>>} features
 * @property {Readonly<Record<string, PlanDef>>} plans
 * @property {readonly string[]} [requires] Product-level resource kinds, required for every subscription (sorted).
 * @property {readonly PriceBook[]} priceBooks Sorted by `effectiveFrom`, then `version`.
 * @property {readonly string[]} elementOrder Topological order (dependencies first, ties by key).
 */

/**
 * @typedef {object} MeteredInput
 * @property {string} unit
 * @property {string} [element] Only in `priceBooks[].metered` overrides.
 * @property {number} perUnit Integer millicredits per `per` units.
 * @property {number} [per] Default 1.
 * @property {Readonly<Record<string, number>>} [included]
 */

/**
 * @typedef {object} ElementInput
 * @property {string} key
 * @property {string} [name]
 * @property {readonly string[]} [dependsOn]
 * @property {{ resources?: readonly string[] } | readonly string[]} [requires]
 * @property {boolean} [defaultEnabled] Not part of the SSPS manifest; defaults to false.
 * @property {{ hourly?: number, metered?: readonly MeteredInput[] }} [price]
 * @property {{ type?: 'object', properties?: Readonly<Record<string, FeatureSchemaNode>> }} [features]
 */

/**
 * @typedef {object} PlanInput
 * @property {string} code
 * @property {string} [name]
 * @property {string} [description]
 * @property {readonly string[]} elements
 * @property {readonly string[]} [addons]
 */

/**
 * @typedef {object} PriceBookInput
 * @property {string} version
 * @property {import('./time.js').Instant} effectiveFrom
 * @property {number} [base] Integer millicredits per hour.
 * @property {Readonly<Record<string, number>>} [elements] Integer millicredits per hour by element.
 * @property {readonly MeteredInput[]} [metered]
 */

/**
 * @typedef {object} ProductInput
 * @property {{ slug: string, version?: string }} product
 * @property {readonly ElementInput[]} elements
 * @property {{ resources?: readonly string[] } | readonly string[]} [requires] Product-level (always required) kinds.
 * @property {readonly PlanInput[]} [plans]
 * @property {PriceBookInput} [priceBook]
 * @property {readonly PriceBookInput[]} [priceBooks] Full price-book history (Portal-side); overrides `priceBook`.
 */

export const FEATURE_KINDS = /** @type {const} */ (['flag', 'quota', 'limit', 'rate', 'config']);
export const PERIOD_UNITS = /** @type {const} */ (['hour', 'day', 'week', 'month']);
export const RATE_WINDOWS = /** @type {const} */ (['second', 'minute', 'hour']);
const JSON_TYPES = ['string', 'integer', 'number', 'boolean', 'array', 'object'];
/** Defaults used when a schema node omits `default` (contracts requires it; this is a safety net). */
const FALLBACK_DEFAULTS = /** @type {Record<JsonType, (min: number | null) => unknown>} */ ({
	string: () => '',
	integer: (min) => min ?? 0,
	number: (min) => min ?? 0,
	boolean: () => false,
	array: () => [],
	object: () => ({}),
});
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const FEATURE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * @param {string} reason
 * @param {string} message
 * @returns {Error & { code: string }}
 */
const catalogError = (reason, message) => Object.assign(new Error(message), { code: `catalog/${reason}` });

/**
 * True for quota/limit/rate kinds (counted, `null` = unlimited).
 * @param {FeatureKind} kind
 * @returns {boolean}
 */
export const isCountKind = (kind) => kind === 'quota' || kind === 'limit' || kind === 'rate';

/**
 * True when the feature's values are numbers (clampable).
 * @param {Pick<FeatureDef, 'jsonType'>} feature
 * @returns {boolean}
 */
export const isNumericFeature = (feature) => feature.jsonType === 'integer' || feature.jsonType === 'number';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether `value` is a well-typed value for `feature`: JSON type, `enum`, string/array length bounds.
 * Numeric range is not a validity condition — out-of-range numbers are clamped by the resolver.
 * Quota/limit/rate features additionally accept `null` (unlimited).
 * @param {FeatureDef} feature
 * @param {unknown} value
 * @returns {boolean}
 */
export const isValidFeatureValue = (feature, value) => {
	if (value === null) return isCountKind(feature.kind);
	if (feature.enum !== null && !feature.enum.some((option) => deepEqual(option, value))) return false;
	const s = feature.schema;
	switch (feature.jsonType) {
		case 'boolean':
			return typeof value === 'boolean';
		case 'integer':
			return Number.isSafeInteger(value);
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'string': {
			if (typeof value !== 'string') return false;
			const length = [...value].length;
			return length >= (s.minLength ?? 0) && length <= (s.maxLength ?? Number.POSITIVE_INFINITY);
		}
		case 'array':
			return (
				Array.isArray(value) && value.length >= (s.minItems ?? 0) && value.length <= (s.maxItems ?? Number.POSITIVE_INFINITY)
			);
		default:
			return isPlainObject(value);
	}
};

/**
 * Whether a numeric value lies inside the feature's absolute bounds (non-numeric: always true).
 * @param {FeatureDef} feature
 * @param {unknown} value
 * @returns {boolean}
 */
export const withinAbsolute = (feature, value) => {
	if (!isNumericFeature(feature)) return true;
	if (value === null) return feature.max === null;
	const n = /** @type {number} */ (value);
	return (feature.min === null || n >= feature.min) && (feature.max === null || n <= feature.max);
};

/**
 * Whether `value` is within a plan maximum (`undefined` = unbounded). Boolean max `false` forbids `true`;
 * a numeric max bounds numbers, string length (characters) and array length; `null` (unlimited) exceeds
 * any numeric max.
 * @param {FeatureDef} feature
 * @param {unknown} value
 * @param {number | boolean | undefined} max
 * @returns {boolean}
 */
export const withinPlanMax = (feature, value, max) => {
	if (max === undefined) return true;
	if (typeof max === 'boolean') return max || value !== true;
	if (value === null) return !isCountKind(feature.kind);
	if (typeof value === 'number') return value <= max;
	if (typeof value === 'string') return [...value].length <= max;
	if (Array.isArray(value)) return value.length <= max;
	return true;
};

/**
 * Sorted, de-duplicated copy.
 * @param {readonly string[] | undefined} list
 * @returns {string[]}
 */
const sortedUnique = (list) => [...new Set(list ?? [])].sort();

/**
 * Normalises a feature key: accepts `element.name` and `element.features.name`.
 * @param {string} key
 * @returns {string}
 */
export const normaliseFeatureKey = (key) => {
	const parts = key.split('.');
	return parts.length === 3 && parts[1] === 'features' ? `${parts[0]}.${parts[2]}` : key;
};

/**
 * @param {string} element
 * @param {string} name
 * @param {FeatureSchemaNode} node
 * @param {ReadonlySet<string>} planCodes
 * @returns {FeatureDef}
 */
const normaliseFeature = (element, name, node, planCodes) => {
	const key = `${element}.${name}`;
	if (!FEATURE_NAME_PATTERN.test(name))
		throw catalogError('invalid_key', `feature name "${key}" must match ${FEATURE_NAME_PATTERN}`);
	if (!isPlainObject(node) || !JSON_TYPES.includes(node.type))
		throw catalogError('invalid_feature_type', `feature ${key} has no valid JSON type`);
	const kind = node['x-kind'] ?? (node.type === 'boolean' ? 'flag' : 'config');
	if (!FEATURE_KINDS.includes(kind))
		throw catalogError('invalid_feature_kind', `feature ${key} has unknown x-kind ${String(kind)}`);
	if (kind === 'flag' && node.type !== 'boolean') throw catalogError('invalid_feature_kind', `flag ${key} must be boolean`);
	if (isCountKind(kind) && node.type !== 'integer' && node.type !== 'number') {
		throw catalogError('invalid_feature_kind', `${kind} ${key} must be integer or number`);
	}
	if (kind === 'quota' && node['x-period'] === undefined) throw catalogError('invalid_period', `quota ${key} needs x-period`);
	if (kind === 'rate' && node['x-per'] === undefined) throw catalogError('invalid_period', `rate ${key} needs x-per`);
	if (node['x-period'] !== undefined && !PERIOD_UNITS.includes(node['x-period'])) {
		throw catalogError('invalid_period', `feature ${key} has unknown x-period ${node['x-period']}`);
	}
	if (node['x-per'] !== undefined && !RATE_WINDOWS.includes(node['x-per'])) {
		throw catalogError('invalid_period', `feature ${key} has unknown x-per ${node['x-per']}`);
	}
	const numeric = node.type === 'integer' || node.type === 'number';
	const min = numeric ? (node.minimum ?? (isCountKind(kind) ? 0 : null)) : null;
	const max = numeric ? (node.maximum ?? null) : null;
	if (min !== null && max !== null && min > max) throw catalogError('invalid_bounds', `feature ${key} minimum exceeds maximum`);
	const plans = { ...(node['x-plan'] ?? {}) };
	for (const code of Object.keys(plans)) {
		if (!planCodes.has(code)) throw catalogError('unknown_plan', `feature ${key} x-plan references unknown plan ${code}`);
	}
	/** @type {FeatureDef} */
	const feature = {
		key,
		element,
		name,
		kind,
		jsonType: node.type,
		default: node.default === undefined ? FALLBACK_DEFAULTS[node.type](min) : node.default,
		min,
		max,
		enum: node.enum ? [...node.enum] : null,
		lockable: node['x-lock'] !== false,
		experiment: node['x-experiment'] === true,
		period: kind === 'quota' ? /** @type {PeriodUnit} */ (node['x-period']) : null,
		hardStop: kind === 'quota' ? node['x-hardStop'] !== false : false,
		unit: kind === 'quota' || kind === 'rate' ? (node['x-unit'] ?? null) : null,
		per: kind === 'rate' ? /** @type {RateWindow} */ (node['x-per']) : null,
		plans,
		schema: node,
	};
	if (!isValidFeatureValue(feature, feature.default) || !withinAbsolute(feature, feature.default)) {
		throw catalogError('invalid_default', `feature ${key} default is not valid for its schema`);
	}
	for (const [code, entry] of Object.entries(plans)) {
		if (entry.max !== undefined && typeof entry.max !== (feature.jsonType === 'boolean' ? 'boolean' : 'number')) {
			throw catalogError('invalid_plan', `feature ${key} x-plan.${code}.max does not fit a ${feature.jsonType} feature`);
		}
		if (
			entry.default !== undefined &&
			(!isValidFeatureValue(feature, entry.default) ||
				!withinAbsolute(feature, entry.default) ||
				!withinPlanMax(feature, entry.default, entry.max))
		) {
			throw catalogError('invalid_plan', `feature ${key} x-plan.${code}.default is invalid or exceeds the plan max`);
		}
	}
	return feature;
};

/**
 * Detects dependency cycles and returns a deterministic topological order.
 * @param {Readonly<Record<string, ElementDef>>} elements
 * @returns {string[]}
 */
const topologicalOrder = (elements) => {
	/** @type {string[]} */
	const order = [];
	/** @type {Map<string, 'visiting' | 'done'>} */
	const marks = new Map();
	/**
	 * @param {string} key
	 * @param {string[]} path
	 */
	const visit = (key, path) => {
		const mark = marks.get(key);
		if (mark === 'done') return;
		if (mark === 'visiting') throw catalogError('dependency_cycle', `element dependency cycle: ${[...path, key].join(' → ')}`);
		marks.set(key, 'visiting');
		for (const dep of elements[key]?.dependsOn ?? []) visit(dep, [...path, key]);
		marks.set(key, 'done');
		order.push(key);
	};
	for (const key of Object.keys(elements).sort()) visit(key, []);
	return order;
};

/**
 * @param {MeteredInput} input
 * @param {string} element
 * @param {ReadonlySet<string>} planCodes
 * @returns {MeteredUnit}
 */
const normaliseMetered = (input, element, planCodes) => {
	if (!input.unit || !KEY_PATTERN.test(input.unit)) throw catalogError('invalid_key', `metered unit "${input.unit}" is invalid`);
	if (input.perUnit === undefined) throw catalogError('invalid_price', `metered unit ${input.unit} has no perUnit price`);
	const included = { ...(input.included ?? {}) };
	for (const [plan, amount] of Object.entries(included)) {
		if (!planCodes.has(plan)) throw catalogError('unknown_plan', `metered unit ${input.unit} references unknown plan ${plan}`);
		if (!Number.isSafeInteger(amount) || amount < 0)
			throw catalogError('invalid_price', `metered unit ${input.unit} included must be an integer ≥ 0`);
	}
	/** @type {Rate} */
	let overage;
	try {
		overage = normaliseRate({ millicredits: input.perUnit, per: input.per ?? 1 });
	} catch {
		throw catalogError('invalid_price', `metered unit ${input.unit} price must be integer millicredits per integer units`);
	}
	return { unit: input.unit, element, included, overage };
};

/**
 * @param {unknown} amount
 * @param {string} label
 * @returns {number}
 */
const price = (amount, label) => {
	try {
		return assertMillicredits(amount, label);
	} catch {
		throw catalogError('invalid_price', `${label} must be integer millicredits ≥ 0`);
	}
};

/**
 * Resource kinds of a `requires` value (`{ resources }` or a bare array).
 * @param {{ resources?: readonly string[] } | readonly string[] | undefined} requires
 * @returns {readonly string[]}
 */
const resourceKinds = (requires) => {
	if (Array.isArray(requires)) return requires;
	const object = /** @type {{ resources?: readonly string[] } | undefined} */ (requires);
	return object?.resources ?? [];
};

/**
 * Normalises a product definition.
 * @param {ProductInput} input
 * @returns {Product}
 */
export const normaliseProduct = (input) => {
	const slug = input.product?.slug;
	const version = input.product?.version ?? '0.0.0';
	if (!slug) throw catalogError('missing_slug', 'product slug is required');
	if (!Array.isArray(input.elements) || input.elements.length === 0)
		throw catalogError('no_elements', 'product needs at least one element');
	const planInputs = input.plans ?? [];
	const planCodes = new Set(planInputs.map((plan) => plan.code));
	if (planCodes.size !== planInputs.length) throw catalogError('duplicate_plan', 'plan codes must be unique');

	const productRequires = sortedUnique(resourceKinds(input.requires));
	/** @type {Record<string, ElementDef>} */
	const elements = {};
	/** @type {Record<string, FeatureDef>} */
	const features = {};
	/** @type {Record<string, number>} */
	const elementPrices = {};
	/** @type {Record<string, MeteredUnit>} */
	const metered = {};
	for (const el of input.elements) {
		if (!KEY_PATTERN.test(el.key)) throw catalogError('invalid_key', `element key "${el.key}" must match ${KEY_PATTERN}`);
		if (elements[el.key]) throw catalogError('duplicate_element', `duplicate element ${el.key}`);
		const featureKeys = [];
		for (const [name, node] of Object.entries(el.features?.properties ?? {})) {
			const feature = normaliseFeature(el.key, name, node, planCodes);
			features[feature.key] = feature;
			featureKeys.push(feature.key);
		}
		const requires = [...resourceKinds(el.requires), ...productRequires];
		elements[el.key] = {
			key: el.key,
			name: el.name ?? el.key,
			dependsOn: sortedUnique(el.dependsOn),
			requires: sortedUnique(requires),
			defaultEnabled: el.defaultEnabled === true,
			features: featureKeys.sort(),
		};
		elementPrices[el.key] = price(el.price?.hourly ?? 0, `element ${el.key} price.hourly`);
		for (const m of el.price?.metered ?? []) {
			if (metered[m.unit]) throw catalogError('duplicate_unit', `metered unit ${m.unit} declared twice`);
			metered[m.unit] = normaliseMetered(m, el.key, planCodes);
		}
	}
	for (const el of Object.values(elements)) {
		for (const dep of el.dependsOn) {
			if (!elements[dep]) throw catalogError('unknown_dependency', `element ${el.key} depends on unknown element ${dep}`);
		}
	}
	for (const feature of Object.values(features)) {
		if (feature.kind === 'quota' && feature.unit !== null && !metered[feature.unit]) {
			throw catalogError('unknown_unit', `quota ${feature.key} references unknown metered unit ${feature.unit}`);
		}
	}
	const elementOrder = topologicalOrder(elements);

	/** @type {Record<string, PlanDef>} */
	const plans = {};
	for (const plan of planInputs) plans[plan.code] = normalisePlan(plan, elements, features);

	const priceBooks = normalisePriceBooks(input, elements, elementPrices, metered, planCodes);
	return { slug, version, elements, features, plans, requires: productRequires, priceBooks, elementOrder };
};

/**
 * @param {PlanInput} plan
 * @param {Readonly<Record<string, ElementDef>>} elements
 * @param {Readonly<Record<string, FeatureDef>>} features
 * @returns {PlanDef}
 */
const normalisePlan = (plan, elements, features) => {
	if (!plan.code) throw catalogError('invalid_plan', 'plan code is required');
	const included = sortedUnique(plan.elements);
	const addons = sortedUnique(plan.addons);
	for (const key of [...included, ...addons]) {
		if (!elements[key]) throw catalogError('unknown_element', `plan ${plan.code} references unknown element ${key}`);
	}
	if (addons.some((key) => included.includes(key)))
		throw catalogError('invalid_plan', `plan ${plan.code} lists an element as both included and addon`);
	const available = sortedUnique([...included, ...addons]);
	// Included elements need their dependencies included; addons need them at least available.
	for (const key of available) {
		const pool = included.includes(key) ? included : available;
		for (const dep of /** @type {ElementDef} */ (elements[key]).dependsOn) {
			if (!pool.includes(dep))
				throw catalogError('invalid_plan', `plan ${plan.code} offers ${key} without its dependency ${dep}`);
		}
	}
	/** @type {Record<string, unknown>} */
	const defaults = {};
	/** @type {Record<string, number | boolean>} */
	const max = {};
	for (const feature of Object.values(features)) {
		const entry = feature.plans[plan.code];
		if (entry?.default !== undefined) defaults[feature.key] = entry.default;
		if (entry?.max !== undefined) max[feature.key] = entry.max;
	}
	return { code: plan.code, name: plan.name ?? plan.code, elements: included, addons, available, defaults, max };
};

/**
 * @param {ProductInput} input
 * @param {Readonly<Record<string, ElementDef>>} elements
 * @param {Readonly<Record<string, number>>} elementPrices
 * @param {Readonly<Record<string, MeteredUnit>>} metered
 * @param {ReadonlySet<string>} planCodes
 * @returns {PriceBook[]}
 */
const normalisePriceBooks = (input, elements, elementPrices, metered, planCodes) => {
	const books = input.priceBooks ?? (input.priceBook ? [input.priceBook] : []);
	if (books.length === 0) throw catalogError('no_price_book', 'product needs a price book (priceBook or priceBooks)');
	const versions = new Set();
	const normalised = books.map((book) => {
		if (!book.version) throw catalogError('invalid_price_book', 'price book version is required');
		if (versions.has(book.version)) throw catalogError('duplicate_price_book', `duplicate price book version ${book.version}`);
		versions.add(book.version);
		/** @type {Record<string, number>} */
		const prices = { ...elementPrices };
		for (const [key, amount] of Object.entries(book.elements ?? {})) {
			if (!elements[key]) throw catalogError('unknown_element', `price book ${book.version} prices unknown element ${key}`);
			prices[key] = price(amount, `price book ${book.version} element ${key}`);
		}
		/** @type {Record<string, MeteredUnit>} */
		const units = { ...metered };
		for (const m of book.metered ?? []) {
			const element = m.element ?? metered[m.unit]?.element;
			if (!element || !elements[element])
				throw catalogError('unknown_element', `price book ${book.version} unit ${m.unit} has no element`);
			units[m.unit] = normaliseMetered(m, element, planCodes);
		}
		return {
			version: book.version,
			effectiveFrom: toMs(book.effectiveFrom, `price book ${book.version} effectiveFrom`),
			baseHourly: price(book.base ?? 0, `price book ${book.version} base`),
			elements: prices,
			metered: units,
		};
	});
	return normalised.sort(
		(a, b) => a.effectiveFrom - b.effectiveFrom || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
	);
};

/**
 * Looks up a price book by version.
 * @param {Pick<Product, 'priceBooks'>} product
 * @param {string} version
 * @returns {PriceBook | undefined}
 */
export const findPriceBook = (product, version) => product.priceBooks.find((book) => book.version === version);

/**
 * Latest price book whose `effectiveFrom` is ≤ `at` (the one a new subscription would accept).
 * @param {Pick<Product, 'priceBooks'>} product
 * @param {import('./time.js').Instant} at
 * @returns {PriceBook | undefined}
 */
export const currentPriceBook = (product, at) => {
	const ms = toMs(at);
	return product.priceBooks.filter((book) => book.effectiveFrom <= ms).at(-1);
};

/**
 * Transitive dependencies and dependents of an element (both sorted).
 * @param {Pick<Product, 'elements'>} product
 * @param {string} key
 * @returns {{ dependsOn: string[], dependents: string[] }}
 */
export const elementDependencies = (product, key) => {
	if (!product.elements[key]) throw catalogError('unknown_element', `unknown element ${key}`);
	/**
	 * @param {string} start
	 * @param {(k: string) => readonly string[]} next
	 * @returns {string[]}
	 */
	const closure = (start, next) => {
		const seen = new Set();
		const stack = [...next(start)];
		while (stack.length > 0) {
			const k = /** @type {string} */ (stack.pop());
			if (!seen.has(k)) {
				seen.add(k);
				stack.push(...next(k));
			}
		}
		return [...seen].sort();
	};
	const all = Object.values(product.elements);
	return {
		dependsOn: closure(key, (k) => product.elements[k]?.dependsOn ?? []),
		dependents: closure(key, (k) => all.filter((el) => el.dependsOn.includes(k)).map((el) => el.key)),
	};
};

/**
 * Effective defaults for a plan (product defaults overlaid by the plan's `x-plan` defaults). With `plan`
 * `null`/unknown, product defaults only. `available` lists the elements a merchant may enable.
 * @param {Pick<Product, 'elements' | 'features' | 'plans'>} product
 * @param {string | null | undefined} planCode
 * @returns {{ elements: Record<string, boolean>, available: string[], features: Record<string, unknown> }}
 */
export const planDefaults = (product, planCode) => {
	const plan = planCode ? product.plans[planCode] : undefined;
	/** @type {Record<string, boolean>} */
	const elements = {};
	for (const el of Object.values(product.elements)) elements[el.key] = plan ? plan.elements.includes(el.key) : el.defaultEnabled;
	/** @type {Record<string, unknown>} */
	const features = {};
	for (const feature of Object.values(product.features)) {
		features[feature.key] = plan && feature.key in plan.defaults ? plan.defaults[feature.key] : feature.default;
	}
	return { elements, available: plan ? [...plan.available] : Object.keys(product.elements).sort(), features };
};
