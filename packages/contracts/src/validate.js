/**
 * Functional validation API over one cached Ajv instance per validator (JSON Schema 2020-12, strict, allErrors,
 * formats). Results are `{ ok: true, value }` or `{ ok: false, problems: [{ path, message, keyword }] }`.
 * @module
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { ALL_SCHEMAS } from './schemas/index.js';
import { SCHEMA_IDS, eventDataSchemaId } from './schemas/schema-ids.js';
import { FEATURE_EXTENSION_KEYWORDS } from './schemas/feature-schema.js';
import {
	CUSTOM_EVENT_PREFIX,
	ELEMENT_EVENT_DATA,
	ELEMENT_UI_EVENT_MAX_BYTES,
	elementEventDataSchemaId,
	eventScopeOf,
	isElementUiEvent,
} from './schemas/event-envelope.js';
import { PATTERNS } from './schemas/common.js';
import { checkManifest } from './manifest-semantics.js';
import { checkEntitlementDocument, checkPlacement } from './document-semantics.js';
import { escapePointerToken, isPlainObject } from './util.js';

/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */
/**
 * @template T
 * @typedef {import('./types.js').ValidationResult<T>} ValidationResult
 */
/** @typedef {import('ajv').ErrorObject} AjvError */

// ajv and ajv-formats are CommonJS; under NodeNext their default export is the module object at type level.
const Ajv2020 = /** @type {typeof Ajv2020Module.default} */ (/** @type {unknown} */ (Ajv2020Module));
const addFormats = /** @type {typeof addFormatsModule.default} */ (/** @type {unknown} */ (addFormatsModule));

/**
 * Convert Ajv errors into stable problems (JSON Pointer paths, missing/extra property names appended).
 * @param {ReadonlyArray<AjvError> | null | undefined} errors
 * @param {string} [prefix] pointer prefix for nested validation
 * @returns {ValidationProblem[]}
 */
export const problemsFromAjv = (errors, prefix = '') => {
	/** @type {Map<string, ValidationProblem>} */
	const unique = new Map();
	for (const error of errors ?? []) {
		if (error.keyword === 'if') continue;
		const params = /** @type {Record<string, unknown>} */ (error.params);
		let path = `${prefix}${error.instancePath}`;
		let message = error.message ?? 'is invalid';
		if (error.keyword === 'required' && typeof params.missingProperty === 'string') {
			path = `${path}/${escapePointerToken(params.missingProperty)}`;
			message = 'is required';
		} else if (error.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
			path = `${path}/${escapePointerToken(params.additionalProperty)}`;
			message = 'is not allowed';
		} else if (error.keyword === 'propertyNames' && typeof params.propertyName === 'string') {
			path = `${path}/${escapePointerToken(params.propertyName)}`;
			message = 'has an invalid property name';
		} else if (error.keyword === 'enum' && Array.isArray(params.allowedValues)) {
			message = `must be one of: ${params.allowedValues.map((value) => JSON.stringify(value)).join(', ')}`;
		} else if (error.keyword === 'false schema') {
			message = 'is not allowed';
		} else if (error.keyword === 'const') {
			message = `must equal ${JSON.stringify(params.allowedValue)}`;
		}
		const problem = Object.freeze({ path, message, keyword: error.keyword });
		unique.set(`${path}\u0000${error.keyword}\u0000${message}`, problem);
	}
	return [...unique.values()];
};

/**
 * @template T
 * @param {T} value
 * @param {ReadonlyArray<ValidationProblem>} problems
 * @returns {ValidationResult<T>}
 */
const result = (value, problems) =>
	problems.length === 0
		? Object.freeze({ ok: true, value })
		: Object.freeze({ ok: false, problems: Object.freeze([...problems]) });

/**
 * @typedef {object} ValidatorOptions
 * @property {ReadonlyArray<Record<string, unknown>>} [schemas] extra schemas (each needs a string `$id`)
 * @property {Readonly<Record<string, Record<string, unknown>>>} [events] extra event data schemas keyed by `type@v` (product events)
 */

/**
 * @typedef {object} Validator
 * @property {(schemaId: string, value: unknown) => ValidationResult<unknown>} validate validate against any registered schema id
 * @property {(schemaId: string) => boolean} has whether a schema id is registered
 * @property {(value: unknown) => ValidationResult<import('./types.js').Manifest>} validateManifest schema + semantic checks
 * @property {(value: unknown) => ValidationResult<import('./types.js').EntitlementDocument>} validateEntitlementDocument schema + semantic checks
 * @property {(value: unknown) => ValidationResult<import('./types.js').EventEnvelope>} validateEvent envelope, then `data` by `type@v`
 * @property {(value: unknown) => ValidationResult<import('./types.js').Placement>} validatePlacement schema + semantic checks
 * @property {(featureSchema: import('./types.js').FeatureSchema, value: unknown) => ValidationResult<Record<string, unknown>>} validateFeatureConfig
 *   validate element configuration against its (manifest-validated) feature schema
 */

/**
 * Create a validator with its own cached Ajv instance holding every built-in schema plus `options.schemas`.
 * @param {ValidatorOptions} [options]
 * @returns {Validator}
 */
export const createValidator = ({ schemas = [], events = {} } = {}) => {
	const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
	addFormats(ajv);
	for (const keyword of FEATURE_EXTENSION_KEYWORDS) ajv.addKeyword({ keyword });
	for (const schema of ALL_SCHEMAS) ajv.addSchema(/** @type {import('ajv').AnySchemaObject} */ (schema));
	for (const schema of schemas) {
		if (typeof schema.$id !== 'string') throw new TypeError('Every extra schema needs a string $id.');
		ajv.addSchema(schema);
	}
	const eventPattern = new RegExp(PATTERNS.eventType);
	for (const [type, schema] of Object.entries(events)) {
		if (!eventPattern.test(type) || type.startsWith(CUSTOM_EVENT_PREFIX))
			throw new TypeError(`Invalid product event type: ${type}`);
		ajv.addSchema({ ...schema, $id: eventDataSchemaId(type) });
	}

	/** @type {WeakMap<object, import('ajv').ValidateFunction>} */
	const featureValidators = new WeakMap();

	/**
	 * The schema Ajv compiles for a feature schema: `placement` features become a `$ref` to the placement v1 schema
	 * (members narrowed by `x-placement.members`).
	 * @param {import('./types.js').FeatureSchema} featureSchema
	 */
	const compilable = (featureSchema) => {
		const properties = /** @type {Record<string, Record<string, unknown>>} */ ({ ...featureSchema.properties });
		let changed = false;
		for (const [name, node] of Object.entries(properties)) {
			if (!isPlainObject(node) || node['x-kind'] !== 'placement') continue;
			const rest = Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'properties'));
			const members = isPlainObject(node['x-placement']) ? node['x-placement'].members : undefined;
			properties[name] = {
				...rest,
				$ref: SCHEMA_IDS.placement,
				...(Array.isArray(members) ? { propertyNames: { enum: [...members] } } : {}),
			};
			changed = true;
		}
		return changed ? { ...featureSchema, properties } : featureSchema;
	};

	/**
	 * Semantic placement checks (time zones, schedule windows) of the placement values in a configuration.
	 * @param {import('./types.js').FeatureSchema} featureSchema
	 * @param {unknown} value
	 * @returns {ValidationProblem[]}
	 */
	const placementProblems = (featureSchema, value) => {
		if (!isPlainObject(value)) return [];
		/** @type {ValidationProblem[]} */
		const out = [];
		for (const [name, node] of Object.entries(featureSchema.properties ?? {})) {
			if (!isPlainObject(node) || node['x-kind'] !== 'placement' || !isPlainObject(value[name])) continue;
			const prefix = `/${escapePointerToken(name)}`;
			for (const problem of checkPlacement(/** @type {import('./types.js').Placement} */ (value[name])))
				out.push({ ...problem, path: `${prefix}${problem.path}` });
		}
		return out;
	};

	/**
	 * Compiled validator for an id, or undefined for unknown or malformed ids.
	 * @param {string} schemaId
	 */
	const lookup = (schemaId) => {
		try {
			return ajv.getSchema(schemaId);
		} catch {
			return undefined;
		}
	};

	/** @type {Validator['has']} */
	const has = (schemaId) => lookup(schemaId) !== undefined;

	/**
	 * @param {string} schemaId
	 * @param {unknown} value
	 * @param {string} [prefix]
	 * @returns {ValidationProblem[]}
	 */
	const run = (schemaId, value, prefix = '') => {
		const fn = lookup(schemaId);
		if (fn === undefined) return [{ path: prefix, message: `unknown schema '${schemaId}'`, keyword: 'schema' }];
		return fn(value) ? [] : problemsFromAjv(fn.errors, prefix);
	};

	/** @type {Validator['validate']} */
	const validate = (schemaId, value) => result(value, run(schemaId, value));

	/** @type {Validator['validateFeatureConfig']} */
	const validateFeatureConfig = (featureSchema, value) => {
		let fn = featureValidators.get(featureSchema);
		if (fn === undefined) {
			fn = ajv.compile(/** @type {import('ajv').AnySchemaObject} */ (compilable(featureSchema)));
			featureValidators.set(featureSchema, fn);
		}
		const ok = fn(value);
		return result(
			/** @type {Record<string, unknown>} */ (value),
			ok ? placementProblems(featureSchema, value) : problemsFromAjv(fn.errors),
		);
	};

	/** @type {Validator['validateManifest']} */
	const validateManifest = (value) => {
		const problems = run(SCHEMA_IDS.manifest, value);
		if (problems.length > 0) return result(/** @type {import('./types.js').Manifest} */ (value), problems);
		const manifest = /** @type {import('./types.js').Manifest} */ (value);
		const semantic = checkManifest(manifest);
		if (semantic.length === 0) {
			for (const [index, element] of manifest.elements.entries()) {
				if (element.features === undefined) continue;
				try {
					const defaults = Object.fromEntries(
						Object.entries(element.features.properties).map(([name, node]) => [name, node.default]),
					);
					const checked = validateFeatureConfig(element.features, defaults);
					if (!checked.ok) {
						for (const problem of checked.problems) {
							const [, feature = '', ...rest] = problem.path.split('/');
							const tail = rest.length > 0 ? `/${rest.join('/')}` : '';
							semantic.push({ ...problem, path: `/elements/${index}/features/properties/${feature}/default${tail}` });
						}
					}
				} catch (error) {
					semantic.push({
						path: `/elements/${index}/features`,
						keyword: 'featureCompile',
						message: `feature schema does not compile: ${/** @type {Error} */ (error).message}`,
					});
				}
			}
		}
		return result(manifest, semantic);
	};

	/** @type {Validator['validateEntitlementDocument']} */
	const validateEntitlementDocument = (value) => {
		const problems = run(SCHEMA_IDS.entitlementDocument, value);
		const doc = /** @type {import('./types.js').EntitlementDocument} */ (value);
		return result(doc, problems.length > 0 ? problems : checkEntitlementDocument(doc));
	};

	/** @type {Validator['validateEvent']} */
	const validateEvent = (value) => {
		const problems = run(SCHEMA_IDS.eventEnvelope, value);
		const event = /** @type {import('./types.js').EventEnvelope} */ (value);
		if (problems.length > 0) return result(event, problems);
		const scope = /** @type {import('./types.js').AnyEventEnvelope} */ (event).scope ?? 'website';
		const expectedScope = eventScopeOf(event.type);
		if (scope !== expectedScope) {
			return result(event, [
				{ path: '/scope', keyword: 'eventScope', message: `${event.type} is a ${expectedScope}-scoped event` },
			]);
		}
		let dataId = event.type.startsWith(CUSTOM_EVENT_PREFIX) ? eventDataSchemaId('custom.*') : eventDataSchemaId(event.type);
		// An element UI event is recognised only when the envelope names the emitting element (context.element).
		if (!has(dataId) && isElementUiEvent(event.type) && event.context?.element === event.type.split('.')[0]) {
			if (JSON.stringify(event.data).length > ELEMENT_UI_EVENT_MAX_BYTES) {
				return result(event, [
					{
						path: '/data',
						keyword: 'maxSize',
						message: `must serialize to at most ${ELEMENT_UI_EVENT_MAX_BYTES} characters`,
					},
				]);
			}
			const verb = event.type.slice(event.type.indexOf('.') + 1);
			dataId = Object.hasOwn(ELEMENT_EVENT_DATA, verb) ? elementEventDataSchemaId(verb) : eventDataSchemaId('element-ui');
		}
		if (!has(dataId))
			return result(event, [{ path: '/type', keyword: 'eventType', message: `unknown event type '${event.type}'` }]);
		return result(event, run(dataId, event.data, '/data'));
	};

	/** @type {Validator['validatePlacement']} */
	const validatePlacement = (value) => {
		const problems = run(SCHEMA_IDS.placement, value);
		const placement = /** @type {import('./types.js').Placement} */ (value);
		return result(placement, problems.length > 0 ? problems : checkPlacement(placement));
	};

	return Object.freeze({
		validate,
		has,
		validateManifest,
		validateEntitlementDocument,
		validateEvent,
		validatePlacement,
		validateFeatureConfig,
	});
};

/** @type {Validator | undefined} */
let defaultValidator;

/**
 * The lazily created, process-wide validator with the built-in schemas only.
 * @returns {Validator}
 */
export const getDefaultValidator = () => {
	defaultValidator ??= createValidator();
	return defaultValidator;
};

/**
 * Validate a manifest (schema + semantics) with the default validator.
 * @param {unknown} value
 */
export const validateManifest = (value) => getDefaultValidator().validateManifest(value);

/**
 * Validate an entitlement document payload with the default validator.
 * @param {unknown} value
 */
export const validateEntitlementDocument = (value) => getDefaultValidator().validateEntitlementDocument(value);

/**
 * Validate a standard or custom event (envelope + data) with the default validator.
 * @param {unknown} value
 */
export const validateEvent = (value) => getDefaultValidator().validateEvent(value);

/**
 * Validate a placement with the default validator.
 * @param {unknown} value
 */
export const validatePlacement = (value) => getDefaultValidator().validatePlacement(value);

/**
 * Validate element configuration against a feature schema with the default validator.
 * @param {import('./types.js').FeatureSchema} featureSchema
 * @param {unknown} value
 */
export const validateFeatureConfig = (featureSchema, value) => getDefaultValidator().validateFeatureConfig(featureSchema, value);
