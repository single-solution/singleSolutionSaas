/**
 * Pure semantic checks for SSPS manifests that JSON Schema cannot express. Every check returns problems (never
 * throws); an empty array means the manifest is semantically valid. Run after schema validation.
 * @module
 */
import { FEATURE_KEYWORDS, FEATURE_TYPES } from './schemas/feature-schema.js';
import { PATTERNS } from './schemas/common.js';
import { CONTROL_EVENT_DATA, LOADER_EVENT_DATA, STANDARD_EVENT_DATA } from './schemas/event-envelope.js';
import { isPlainObject, pointer } from './util.js';

/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */
/** @typedef {import('./types.js').Manifest} Manifest */
/** @typedef {import('./types.js').ManifestElement} ManifestElement */
/** @typedef {import('./types.js').FeatureNode} FeatureNode */

/** Stable ids of the semantic rules (the `keyword` of each problem). */
export const MANIFEST_RULES = Object.freeze({
	duplicateElementKey: 'duplicateElementKey',
	unknownDependency: 'unknownDependency',
	selfDependency: 'selfDependency',
	dependencyCycle: 'dependencyCycle',
	packRequiresModeA: 'packRequiresModeA',
	modeARequiresRenderer: 'modeARequiresRenderer',
	modeARequiresBudget: 'modeARequiresBudget',
	modeBRequiresHeadless: 'modeBRequiresHeadless',
	modeCRequiresApi: 'modeCRequiresApi',
	rendererRequiresHeadless: 'rendererRequiresHeadless',
	rendererRequiresModeA: 'rendererRequiresModeA',
	uiRequiresModeB: 'uiRequiresModeB',
	statefulRequiresModeC: 'statefulRequiresModeC',
	/**
	 * Retired (never reported since v1.x): element `requires.resources` no longer has to be repeated at product level.
	 * Product-level `requires.resources` now means "required by every subscription, whatever elements are enabled";
	 * element-level kinds gate only that element. Kept so consumers matching on the id keep compiling.
	 */
	undeclaredResource: 'undeclaredResource',
	duplicatePlanCode: 'duplicatePlanCode',
	unknownPlan: 'unknownPlan',
	unknownPlanElement: 'unknownPlanElement',
	planMissingDependency: 'planMissingDependency',
	planElementMissing: 'planElementMissing',
	boundType: 'boundType',
	boundRange: 'boundRange',
	planDefaultExceedsMax: 'planDefaultExceedsMax',
	planDefaultInvalid: 'planDefaultInvalid',
	duplicateMeteredUnit: 'duplicateMeteredUnit',
	eventType: 'eventType',
	priceBookEffectiveFrom: 'priceBookEffectiveFrom',
	experimentsDisabled: 'experimentsDisabled',
	eventNotSubscribed: 'eventNotSubscribed',
	publishOutsideNamespace: 'publishOutsideNamespace',
	platformEventNotPublishable: 'platformEventNotPublishable',
	publishScopeMissing: 'publishScopeMissing',
	packEndpoints: 'packEndpoints',
	packAdminLaunch: 'packAdminLaunch',
	packModes: 'packModes',
	packApi: 'packApi',
	packScope: 'packScope',
	packStateRequiresGraph: 'packStateRequiresGraph',
	featureKeyword: 'featureKeyword',
	featureType: 'featureType',
	featureRequired: 'featureRequired',
	featureRange: 'featureRange',
	featureDefault: 'featureDefault',
	featureKind: 'featureKind',
	featureKindMeta: 'featureKindMeta',
	planElementConflict: 'planElementConflict',
	featureOpenObject: 'featureOpenObject',
	featurePattern: 'featurePattern',
});

/**
 * @param {ReadonlyArray<string | number>} tokens
 * @param {string} keyword
 * @param {string} message
 * @returns {ValidationProblem}
 */
const at = (tokens, keyword, message) => Object.freeze({ path: pointer(tokens), keyword, message });

/**
 * Structural equality for JSON values.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export const jsonEqual = (a, b) => {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]));
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
	}
	return false;
};

/**
 * @param {string} pattern
 * @returns {RegExp | null}
 */
const compilePattern = (pattern) => {
	try {
		return new RegExp(pattern, 'u');
	} catch {
		return null;
	}
};

/**
 * @param {FeatureType} type
 * @param {unknown} value
 * @returns {boolean}
 * @typedef {import('./types.js').FeatureType} FeatureType
 */
const hasType = (type, value) => {
	switch (type) {
		case 'integer':
			return Number.isInteger(value);
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'string':
			return typeof value === 'string';
		case 'boolean':
			return typeof value === 'boolean';
		case 'array':
			return Array.isArray(value);
		default:
			return isPlainObject(value);
	}
};

/**
 * Check `value` against a feature node (subset semantics). Returns the first violation message or `null`.
 * @param {FeatureNode} node
 * @param {unknown} value
 * @returns {string | null}
 */
export const featureValueError = (node, value) => {
	if (!hasType(node.type, value)) return `must be ${node.type}`;
	if (node.enum !== undefined && !node.enum.some((option) => jsonEqual(option, value))) return 'must be one of the enum values';
	if ('const' in node && !jsonEqual(node.const, value)) return 'must equal const';
	if (typeof value === 'number') {
		if (node.minimum !== undefined && value < node.minimum) return `must be >= ${node.minimum}`;
		if (node.maximum !== undefined && value > node.maximum) return `must be <= ${node.maximum}`;
		if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) return `must be > ${node.exclusiveMinimum}`;
		if (node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum) return `must be < ${node.exclusiveMaximum}`;
		if (node.multipleOf !== undefined && !Number.isInteger(value / node.multipleOf))
			return `must be a multiple of ${node.multipleOf}`;
	}
	if (typeof value === 'string') {
		const length = [...value].length;
		if (node.minLength !== undefined && length < node.minLength) return `must have at least ${node.minLength} characters`;
		if (node.maxLength !== undefined && length > node.maxLength) return `must have at most ${node.maxLength} characters`;
		const regex = node.pattern === undefined ? null : compilePattern(node.pattern);
		if (regex !== null && !regex.test(value)) return 'must match pattern';
	}
	if (Array.isArray(value)) {
		if (node.minItems !== undefined && value.length < node.minItems) return `must have at least ${node.minItems} items`;
		if (node.maxItems !== undefined && value.length > node.maxItems) return `must have at most ${node.maxItems} items`;
		if (
			node.uniqueItems === true &&
			value.some((item, index) => value.findIndex((other) => jsonEqual(other, item)) !== index)
		) {
			return 'must have unique items';
		}
		const items = node.items;
		if (items !== undefined) {
			for (const [index, item] of value.entries()) {
				const error = featureValueError(items, item);
				if (error !== null) return `item ${index} ${error}`;
			}
		}
	}
	if (isPlainObject(value)) {
		const properties = node.properties ?? {};
		for (const name of node.required ?? []) if (!Object.hasOwn(value, name)) return `must have property '${name}'`;
		for (const [name, child] of Object.entries(value)) {
			const childNode = Object.hasOwn(properties, name) ? properties[name] : undefined;
			if (childNode === undefined) return `must not have property '${name}'`;
			const error = featureValueError(childNode, child);
			if (error !== null) return `property '${name}' ${error}`;
		}
	}
	return null;
};

/**
 * Compare a plan maximum against a value of the feature (number, array length, string length, or boolean flag).
 * @param {FeatureNode} node
 * @param {unknown} value
 * @param {number | boolean} max
 * @returns {boolean} true when value exceeds max
 */
const exceeds = (node, value, max) => {
	if (typeof max === 'boolean') return max === false && value === true;
	if (typeof value === 'number') return value > max;
	if (Array.isArray(value)) return value.length > max;
	if (typeof value === 'string') return [...value].length > max;
	return false;
};

/**
 * Validate that a plan bound / x-plan max has a type and range that fit the feature.
 * @param {FeatureNode} node
 * @param {number | boolean} bound
 * @returns {{ keyword: string, message: string } | null}
 */
const boundError = (node, bound) => {
	if (node.type === 'boolean') {
		return typeof bound === 'boolean'
			? null
			: { keyword: MANIFEST_RULES.boundType, message: 'bound of a boolean feature must be boolean' };
	}
	if (node.type === 'object' || typeof bound !== 'number') {
		return { keyword: MANIFEST_RULES.boundType, message: `bound type does not fit a ${node.type} feature` };
	}
	const upper = node.type === 'array' ? node.maxItems : node.type === 'string' ? node.maxLength : node.maximum;
	const lower = node.type === 'array' ? node.minItems : node.type === 'string' ? node.minLength : node.minimum;
	if (upper !== undefined && bound > upper)
		return { keyword: MANIFEST_RULES.boundRange, message: `bound ${bound} exceeds schema limit ${upper}` };
	if (lower !== undefined && bound < lower)
		return { keyword: MANIFEST_RULES.boundRange, message: `bound ${bound} is below schema limit ${lower}` };
	return null;
};

/**
 * @param {unknown} min
 * @param {unknown} max
 * @returns {boolean}
 */
const inverted = (min, max) => typeof min === 'number' && typeof max === 'number' && min > max;

/**
 * Check one feature node recursively.
 * @param {unknown} node
 * @param {Array<string | number>} path
 * @param {{ top: boolean, planCodes: ReadonlySet<string> | null }} options
 * @param {ValidationProblem[]} out
 */
const checkNode = (node, path, options, out) => {
	if (!isPlainObject(node)) {
		out.push(at(path, MANIFEST_RULES.featureType, 'feature schema node must be an object'));
		return;
	}
	for (const keyword of Object.keys(node)) {
		if (!FEATURE_KEYWORDS.includes(keyword)) {
			out.push(
				at([...path, keyword], MANIFEST_RULES.featureKeyword, `keyword '${keyword}' is not allowed in feature schemas`),
			);
		}
	}
	if (typeof node.type !== 'string' || !(/** @type {readonly string[]} */ (FEATURE_TYPES).includes(node.type))) {
		out.push(at([...path, 'type'], MANIFEST_RULES.featureType, `type must be one of ${FEATURE_TYPES.join(', ')}`));
		return;
	}
	const typed = /** @type {FeatureNode} */ (/** @type {unknown} */ (node));
	if (options.top) {
		for (const required of ['title', 'default']) {
			if (!(required in node))
				out.push(at([...path, required], MANIFEST_RULES.featureRequired, `top-level feature needs '${required}'`));
		}
	}
	for (const [min, max] of [
		['minimum', 'maximum'],
		['exclusiveMinimum', 'exclusiveMaximum'],
		['minLength', 'maxLength'],
		['minItems', 'maxItems'],
	]) {
		if (inverted(node[/** @type {string} */ (min)], node[/** @type {string} */ (max)])) {
			out.push(at([...path, /** @type {string} */ (min)], MANIFEST_RULES.featureRange, `${min} must not exceed ${max}`));
		}
	}
	if (typeof node.pattern === 'string' && compilePattern(node.pattern) === null) {
		out.push(at([...path, 'pattern'], MANIFEST_RULES.featurePattern, 'pattern is not a valid regular expression'));
	}
	const kind = node['x-kind'];
	if (kind === 'flag' && typed.type !== 'boolean')
		out.push(at([...path, 'x-kind'], MANIFEST_RULES.featureKind, "'flag' features must be boolean"));
	if ((kind === 'quota' || kind === 'limit' || kind === 'rate') && typed.type !== 'integer' && typed.type !== 'number') {
		out.push(at([...path, 'x-kind'], MANIFEST_RULES.featureKind, `'${kind}' features must be integer or number`));
	}
	/** @type {Array<[string, ReadonlyArray<string>]>} */
	const kindMeta = [
		['x-period', ['quota']],
		['x-hardStop', ['quota']],
		['x-unit', ['quota', 'rate']],
		['x-per', ['rate']],
	];
	for (const [keyword, kinds] of kindMeta) {
		if (keyword in node && !kinds.includes(String(kind))) {
			out.push(
				at(
					[...path, keyword],
					MANIFEST_RULES.featureKindMeta,
					`'${keyword}' is only allowed with x-kind ${kinds.join(' or ')}`,
				),
			);
		}
	}
	if (kind === 'quota' && !('x-period' in node))
		out.push(at([...path, 'x-period'], MANIFEST_RULES.featureKindMeta, 'quota features need x-period'));
	if (kind === 'rate' && !('x-per' in node))
		out.push(at([...path, 'x-per'], MANIFEST_RULES.featureKindMeta, 'rate features need x-per'));
	if (typed.type === 'object') {
		if (!isPlainObject(node.properties)) {
			out.push(at(path, MANIFEST_RULES.featureOpenObject, 'object features must declare properties'));
		} else {
			for (const name of Array.isArray(node.required) ? node.required : []) {
				if (!Object.hasOwn(node.properties, name)) {
					out.push(at([...path, 'required'], MANIFEST_RULES.featureRequired, `required property '${name}' is not declared`));
				}
			}
			for (const [name, child] of Object.entries(node.properties))
				checkNode(child, [...path, 'properties', name], { ...options, top: false }, out);
		}
	}
	if (typed.type === 'array' && node.items !== undefined)
		checkNode(node.items, [...path, 'items'], { ...options, top: false }, out);
	if ('default' in node) {
		const error = featureValueError(typed, node.default);
		if (error !== null) out.push(at([...path, 'default'], MANIFEST_RULES.featureDefault, `default ${error}`));
	}
	const xPlan = node['x-plan'];
	if (isPlainObject(xPlan)) {
		for (const [code, entry] of Object.entries(xPlan)) {
			const entryPath = [...path, 'x-plan', code];
			if (options.planCodes !== null && !options.planCodes.has(code)) {
				out.push(at(entryPath, MANIFEST_RULES.unknownPlan, `plan '${code}' is not declared in plans`));
			}
			if (!isPlainObject(entry)) continue;
			const max = entry.max;
			if (typeof max === 'number' || typeof max === 'boolean') {
				const error = boundError(typed, max);
				if (error !== null) out.push(at([...entryPath, 'max'], error.keyword, error.message));
			}
			if ('default' in entry) {
				const error = featureValueError(typed, entry.default);
				if (error !== null)
					out.push(at([...entryPath, 'default'], MANIFEST_RULES.planDefaultInvalid, `plan default ${error}`));
				else if ((typeof max === 'number' || typeof max === 'boolean') && exceeds(typed, entry.default, max)) {
					out.push(at([...entryPath, 'default'], MANIFEST_RULES.planDefaultExceedsMax, 'plan default exceeds plan max'));
				}
			}
		}
	}
};

/**
 * Check a feature schema against the allowed subset and internal consistency (ranges, defaults, kinds, x-plan).
 * @param {unknown} schema the element's `features` schema
 * @param {{ path?: Array<string | number>, planCodes?: Iterable<string> }} [options] path prefix and declared plan codes
 * @returns {ValidationProblem[]}
 */
export const checkFeatureSchema = (schema, options = {}) => {
	const path = options.path ?? [];
	const planCodes = options.planCodes === undefined ? null : new Set(options.planCodes);
	/** @type {ValidationProblem[]} */
	const out = [];
	if (!isPlainObject(schema) || schema.type !== 'object' || !isPlainObject(schema.properties)) {
		out.push(at(path, MANIFEST_RULES.featureType, "feature schema must be { type: 'object', properties: { … } }"));
		return out;
	}
	for (const keyword of Object.keys(schema)) {
		if (!['type', 'title', 'description', 'properties', 'required', 'additionalProperties'].includes(keyword)) {
			out.push(
				at(
					[...path, keyword],
					MANIFEST_RULES.featureKeyword,
					`keyword '${keyword}' is not allowed at the feature schema root`,
				),
			);
		}
	}
	for (const name of Array.isArray(schema.required) ? schema.required : []) {
		if (!Object.hasOwn(schema.properties, name))
			out.push(at([...path, 'required'], MANIFEST_RULES.featureRequired, `required feature '${name}' is not declared`));
	}
	for (const [name, node] of Object.entries(schema.properties))
		checkNode(node, [...path, 'properties', name], { top: true, planCodes }, out);
	return out;
};

/**
 * Resolve a feature node by dotted path inside a features schema.
 * @param {import('./types.js').FeatureSchema | undefined} schema
 * @param {ReadonlyArray<string>} segments
 * @returns {FeatureNode | undefined}
 */
export const resolveFeature = (schema, segments) => {
	/** @type {{ properties?: Record<string, FeatureNode> } | undefined} */
	let node = schema;
	for (const segment of segments) {
		const properties = node?.properties;
		node = properties !== undefined && Object.hasOwn(properties, segment) ? properties[segment] : undefined;
		if (node === undefined) return undefined;
	}
	return /** @type {FeatureNode | undefined} */ (node === schema ? undefined : node);
};

/**
 * True when `iso` is a real ISO-8601 UTC timestamp (rejects e.g. Feb 30 and non-`Z` offsets).
 * @param {unknown} iso
 * @returns {boolean}
 */
export const isUtcTimestamp = (iso) => {
	if (typeof iso !== 'string' || !new RegExp(PATTERNS.utcTimestamp).test(iso)) return false;
	const [date = '', time = ''] = iso.slice(0, -1).split('T');
	const [y, mo, d] = date.split('-').map(Number);
	const [h, mi, s] = time.split(':').map((part) => Number.parseInt(part, 10));
	if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined || s === undefined)
		return false;
	const parsed = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	return (
		parsed.getUTCFullYear() === y &&
		parsed.getUTCMonth() === mo - 1 &&
		parsed.getUTCDate() === d &&
		parsed.getUTCHours() === h &&
		parsed.getUTCMinutes() === mi &&
		s <= 59
	);
};

/**
 * Detect dependency cycles; returns each cycle once as a list of keys.
 * @param {ReadonlyMap<string, ReadonlyArray<string>>} graph
 * @returns {string[][]}
 */
export const findCycles = (graph) => {
	/** @type {Map<string, 'visiting' | 'done'>} */
	const state = new Map();
	/** @type {string[][]} */
	const cycles = [];
	/** @type {string[]} */
	const stack = [];
	/** @param {string} key */
	const visit = (key) => {
		state.set(key, 'visiting');
		stack.push(key);
		for (const next of graph.get(key) ?? []) {
			if (!graph.has(next)) continue;
			const seen = state.get(next);
			if (seen === 'visiting') cycles.push([...stack.slice(stack.indexOf(next)), next]);
			else if (seen === undefined) visit(next);
		}
		stack.pop();
		state.set(key, 'done');
	};
	for (const key of graph.keys()) if (!state.has(key)) visit(key);
	return cycles;
};

/** Scope prefix granting subscription to events matching a glob (`events.subscribe:order.*`). */
export const EVENT_SUBSCRIBE_SCOPE = 'events.subscribe:';

/** Scope prefix granting publication of standard events matching a glob (`events.publish:order.*`). */
export const EVENT_PUBLISH_SCOPE = 'events.publish:';

/**
 * True when an event glob covers a `type@v`. `*` matches any run of characters (dots included). A pattern without `@`
 * matches every version; one with `@` matches the full `type@v`.
 * @param {string} pattern e.g. `order.*`, `cart.updated`, `order.placed@1`
 * @param {string} typeAtVersion e.g. `order.placed@1`
 * @returns {boolean}
 */
export const eventGlobMatches = (pattern, typeAtVersion) => {
	const target = pattern.includes('@') ? typeAtVersion : (typeAtVersion.split('@')[0] ?? '');
	const source = pattern
		.split('*')
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*');
	return new RegExp(`^${source}$`).test(target);
};

/**
 * True when a consumed event entry is a glob (`custom.*`, `order.*@1`) rather than one exact `type@v`.
 * @param {string} entry
 * @returns {boolean}
 */
export const isEventGlob = (entry) => entry.includes('*');

/**
 * Event namespace owned by a product: its slug with `-` mapped to `_` (`notice-bar` → `notice_bar`).
 * @param {string} slug
 * @returns {string}
 */
export const eventNamespace = (slug) => slug.replace(/-/g, '_');

/**
 * Glob patterns granted by scopes with the given prefix.
 * @param {ReadonlyArray<string>} scopes
 * @param {string} prefix
 * @returns {string[]}
 */
const scopePatterns = (scopes, prefix) =>
	scopes.filter((scope) => scope.startsWith(prefix)).map((scope) => scope.slice(prefix.length));

/**
 * @param {ManifestElement} element
 * @returns {boolean}
 */
const hasApi = (element) => (element.api?.resources?.length ?? 0) > 0;

/**
 * @param {ManifestElement} element
 * @returns {boolean}
 */
const hasUi = (element) => Boolean(element.renderer) || element.placement === true || (element.budget?.js ?? 0) > 0;

/**
 * Run every semantic rule on a schema-valid manifest.
 * @param {Manifest} manifest
 * @returns {ValidationProblem[]}
 */
export const checkManifest = (manifest) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	const elements = manifest.elements;
	/** @type {Map<string, ManifestElement>} */
	const byKey = new Map();
	for (const [index, element] of elements.entries()) {
		if (byKey.has(element.key))
			out.push(at(['elements', index, 'key'], MANIFEST_RULES.duplicateElementKey, `duplicate element key '${element.key}'`));
		else byKey.set(element.key, element);
	}

	/** @type {Map<string, string[]>} */
	const graph = new Map();
	for (const [index, element] of elements.entries()) {
		for (const [depIndex, dep] of (element.dependsOn ?? []).entries()) {
			if (dep === element.key)
				out.push(
					at(['elements', index, 'dependsOn', depIndex], MANIFEST_RULES.selfDependency, 'element cannot depend on itself'),
				);
			else if (!byKey.has(dep))
				out.push(
					at(['elements', index, 'dependsOn', depIndex], MANIFEST_RULES.unknownDependency, `unknown element '${dep}'`),
				);
		}
		if (!graph.has(element.key))
			graph.set(
				element.key,
				(element.dependsOn ?? []).filter((dep) => dep !== element.key),
			);
	}
	for (const cycle of findCycles(graph)) {
		const first = cycle[0] ?? '';
		const index = elements.findIndex((element) => element.key === first);
		out.push(at(['elements', index, 'dependsOn'], MANIFEST_RULES.dependencyCycle, `dependency cycle: ${cycle.join(' → ')}`));
	}

	/** @type {(key: string, seen?: Set<string>) => Set<string>} */
	const closure = (key, seen = new Set()) => {
		for (const dep of graph.get(key) ?? []) {
			if (!seen.has(dep) && byKey.has(dep)) {
				seen.add(dep);
				closure(dep, seen);
			}
		}
		return seen;
	};

	const planCodes = (manifest.plans ?? []).map((plan) => plan.code);

	const isPack = manifest.product.kind === 'pack';
	const scopes = manifest.scopes ?? [];
	/** @type {Map<string, Set<string>>} */
	const planElements = new Map(
		(manifest.plans ?? []).map((plan) => [plan.code, new Set([...plan.elements, ...(plan.addons ?? [])])]),
	);

	for (const [index, element] of elements.entries()) {
		const base = ['elements', index];
		const modes = new Set(element.modes);
		if (isPack) {
			if (modes.has('C'))
				out.push(at([...base, 'modes'], MANIFEST_RULES.packModes, 'pack elements support modes A and B only'));
			if (hasApi(element))
				out.push(at([...base, 'api'], MANIFEST_RULES.packApi, 'pack elements cannot declare api.resources'));
			if (element.stateful === true && !scopes.some((scope) => /^graph\.[a-z0-9_*]+\.write$/.test(scope))) {
				out.push(
					at(
						[...base, 'stateful'],
						MANIFEST_RULES.packStateRequiresGraph,
						'stateful pack elements need a graph.<entity>.write scope',
					),
				);
			}
		}
		for (const [name, node] of Object.entries(element.features?.properties ?? {})) {
			for (const code of Object.keys(node['x-plan'] ?? {})) {
				if (planElements.get(code)?.has(element.key) === false) {
					out.push(
						at(
							[...base, 'features', 'properties', name, 'x-plan', code],
							MANIFEST_RULES.planElementMissing,
							`plan '${code}' neither includes nor offers element '${element.key}'`,
						),
					);
				}
			}
		}
		if (manifest.product.kind === 'pack' && !modes.has('A'))
			out.push(at([...base, 'modes'], MANIFEST_RULES.packRequiresModeA, 'every element of a pack must support mode A'));
		if (modes.has('A') && !element.renderer)
			out.push(at([...base, 'renderer'], MANIFEST_RULES.modeARequiresRenderer, 'mode A requires a renderer'));
		if (modes.has('A') && (element.budget?.js ?? 0) <= 0)
			out.push(at([...base, 'budget'], MANIFEST_RULES.modeARequiresBudget, 'mode A requires a positive budget.js'));
		if (modes.has('B') && !element.headless)
			out.push(at([...base, 'headless'], MANIFEST_RULES.modeBRequiresHeadless, 'mode B requires a headless core'));
		if (element.renderer && !element.headless)
			out.push(
				at([...base, 'headless'], MANIFEST_RULES.rendererRequiresHeadless, 'a renderer must be built on a headless core'),
			);
		if (element.renderer && !modes.has('A'))
			out.push(at([...base, 'modes'], MANIFEST_RULES.rendererRequiresModeA, 'an element with a renderer must list mode A'));
		if (hasUi(element) && !modes.has('B'))
			out.push(at([...base, 'modes'], MANIFEST_RULES.uiRequiresModeB, 'an element with UI must support mode B'));
		if (!isPack && (element.stateful === true || hasApi(element)) && !modes.has('C')) {
			out.push(at([...base, 'modes'], MANIFEST_RULES.statefulRequiresModeC, 'a stateful element must support mode C'));
		}
		if (
			modes.has('C') &&
			!hasApi(element) &&
			![...closure(element.key)].some((dep) => hasApi(/** @type {ManifestElement} */ (byKey.get(dep))))
		) {
			out.push(
				at([...base, 'api'], MANIFEST_RULES.modeCRequiresApi, 'mode C requires api.resources on the element or a dependency'),
			);
		}
		/** @type {Set<string>} */
		const units = new Set();
		for (const [meterIndex, meter] of (element.price.metered ?? []).entries()) {
			if (units.has(meter.unit))
				out.push(
					at(
						[...base, 'price', 'metered', meterIndex, 'unit'],
						MANIFEST_RULES.duplicateMeteredUnit,
						`duplicate metered unit '${meter.unit}'`,
					),
				);
			units.add(meter.unit);
			for (const code of Object.keys(meter.included ?? {})) {
				if (!planCodes.includes(code))
					out.push(
						at(
							[...base, 'price', 'metered', meterIndex, 'included', code],
							MANIFEST_RULES.unknownPlan,
							`plan '${code}' is not declared in plans`,
						),
					);
			}
		}
		if (element.features !== undefined) {
			out.push(...checkFeatureSchema(element.features, { path: [...base, 'features'], planCodes }));
			if (element.experiments !== true) {
				for (const [name, node] of Object.entries(element.features.properties)) {
					if (node['x-experiment'] === true)
						out.push(
							at(
								[...base, 'features', 'properties', name, 'x-experiment'],
								MANIFEST_RULES.experimentsDisabled,
								'x-experiment requires the element to set experiments: true',
							),
						);
				}
			}
		}
	}

	/** @type {Set<string>} */
	const seenPlans = new Set();
	for (const [planIndex, plan] of (manifest.plans ?? []).entries()) {
		const base = ['plans', planIndex];
		if (seenPlans.has(plan.code))
			out.push(at([...base, 'code'], MANIFEST_RULES.duplicatePlanCode, `duplicate plan code '${plan.code}'`));
		seenPlans.add(plan.code);
		const included = new Set(plan.elements);
		const available = new Set([...plan.elements, ...(plan.addons ?? [])]);
		for (const list of /** @type {const} */ (['elements', 'addons'])) {
			// Included elements need included dependencies; add-ons may depend on included elements or other add-ons.
			const allowed = list === 'elements' ? included : available;
			for (const [elementIndex, key] of (plan[list] ?? []).entries()) {
				const path = [...base, list, elementIndex];
				if (!byKey.has(key)) {
					out.push(at(path, MANIFEST_RULES.unknownPlanElement, `unknown element '${key}'`));
					continue;
				}
				if (list === 'addons' && included.has(key)) {
					out.push(at(path, MANIFEST_RULES.planElementConflict, `'${key}' cannot be both included and an add-on`));
				}
				for (const dep of closure(key)) {
					if (!allowed.has(dep)) {
						out.push(
							at(
								path,
								MANIFEST_RULES.planMissingDependency,
								`'${key}' depends on '${dep}', which the plan does not ${list === 'elements' ? 'include' : 'offer'}`,
							),
						);
					}
				}
			}
		}
	}

	const eventPatterns = { consumes: new RegExp(PATTERNS.eventTypeGlob), publishes: new RegExp(PATTERNS.eventType) };
	for (const direction of /** @type {const} */ (['consumes', 'publishes'])) {
		for (const [index, type] of (manifest.events?.[direction] ?? []).entries()) {
			if (!eventPatterns[direction].test(type))
				out.push(
					at(
						['events', direction, index],
						MANIFEST_RULES.eventType,
						direction === 'consumes'
							? `'${type}' is not a well-formed type@version or event glob`
							: `'${type}' is not a well-formed type@version`,
					),
				);
		}
	}

	const subscribe = scopePatterns(scopes, EVENT_SUBSCRIBE_SCOPE);
	const publish = scopePatterns(scopes, EVENT_PUBLISH_SCOPE);
	const namespace = `${eventNamespace(manifest.product.slug)}.`;
	for (const [index, type] of (manifest.events?.consumes ?? []).entries()) {
		// Control events are delivered by the Portal to every product; no subscribe scope is needed.
		if (Object.hasOwn(CONTROL_EVENT_DATA, type)) continue;
		// A consumed glob is covered when a scope glob matches it literally: scope literals never match `*`, so every
		// `*` of the consumed glob falls inside a scope `*` and every type the glob matches is covered too.
		if (!subscribe.some((pattern) => eventGlobMatches(pattern, type))) {
			out.push(
				at(
					['events', 'consumes', index],
					MANIFEST_RULES.eventNotSubscribed,
					`'${type}' needs an ${EVENT_SUBSCRIBE_SCOPE}<pattern> scope`,
				),
			);
		}
	}
	const platformNamespaces = new Set(
		[...Object.keys(CONTROL_EVENT_DATA), ...Object.keys(LOADER_EVENT_DATA)].map((type) => type.split('.')[0]),
	);
	for (const [index, type] of (manifest.events?.publishes ?? []).entries()) {
		if (platformNamespaces.has(type.split('.')[0])) {
			out.push(
				at(
					['events', 'publishes', index],
					MANIFEST_RULES.platformEventNotPublishable,
					`'${type}' is a platform event; only the Portal or Loader publishes it`,
				),
			);
			continue;
		}
		if (type.startsWith(namespace)) continue;
		if (!Object.hasOwn(STANDARD_EVENT_DATA, type)) {
			out.push(
				at(
					['events', 'publishes', index],
					MANIFEST_RULES.publishOutsideNamespace,
					`'${type}' must be in the product namespace '${namespace}*' or be a standard event`,
				),
			);
		} else if (!publish.some((pattern) => eventGlobMatches(pattern, type))) {
			out.push(
				at(
					['events', 'publishes', index],
					MANIFEST_RULES.publishScopeMissing,
					`'${type}' needs an ${EVENT_PUBLISH_SCOPE}<pattern> scope`,
				),
			);
		}
	}

	if (isPack) {
		if (manifest.endpoints !== undefined)
			out.push(at(['endpoints'], MANIFEST_RULES.packEndpoints, 'element packs have no endpoints'));
		if (manifest.capabilities?.adminLaunch !== undefined) {
			out.push(at(['capabilities', 'adminLaunch'], MANIFEST_RULES.packAdminLaunch, 'element packs have no admin launch'));
		}
		for (const [index, scope] of scopes.entries()) {
			if (!scope.startsWith('graph.') && !scope.startsWith(EVENT_PUBLISH_SCOPE)) {
				out.push(
					at(
						['scopes', index],
						MANIFEST_RULES.packScope,
						`element packs may only hold graph.* and ${EVENT_PUBLISH_SCOPE}* scopes`,
					),
				);
			}
		}
	}

	if (!isUtcTimestamp(manifest.priceBook.effectiveFrom)) {
		out.push(
			at(
				['priceBook', 'effectiveFrom'],
				MANIFEST_RULES.priceBookEffectiveFrom,
				'effectiveFrom must be a real ISO-8601 UTC timestamp',
			),
		);
	}
	return out;
};
