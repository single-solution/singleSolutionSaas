/**
 * Functional validation API over one cached Ajv instance per validator (JSON Schema 2020-12, strict, allErrors,
 * formats). Results are `{ ok: true, value }` or `{ ok: false, problems: [{ path, message, keyword }] }`.
 * @module
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { ALL_SCHEMAS } from './schemas/index.js';
import { SCHEMA_IDS } from './schemas/schema-ids.js';
import { SETTING_EXTENSION_KEYWORDS } from './schemas/settings-schema.js';
import {
	RULES,
	at,
	checkActivityCopy,
	checkDirectory,
	checkManifest,
	checkPriceReport,
	checkSettingsRules,
	checkStatusResponse,
} from './semantics.js';
import { escapePointerToken, isPlainObject, pointer } from './util.js';

/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */
/**
 * @template T
 * @typedef {import('./types.js').ValidationResult<T>} ValidationResult
 */
/** @typedef {import('./types.js').SettingsSchema} SettingsSchema */
/** @typedef {import('./types.js').Manifest} Manifest */
/** @typedef {import('ajv').ErrorObject} AjvError */
/** @typedef {import('ajv').ValidateFunction} ValidateFunction */

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
 */

/**
 * @typedef {object} Validator
 * @property {(schemaId: string, value: unknown) => ValidationResult<unknown>} validate validate against any registered schema id
 * @property {(schemaId: string) => boolean} has whether a schema id is registered
 * @property {(schema: unknown) => ValidationProblem[]} checkSettingsSchema settings meta-schema, keyword fit, defaults and enum values
 * @property {(schema: SettingsSchema, key: string, value: unknown) => ValidationResult<unknown>} validateSettingValue one setting value
 * @property {(schema: SettingsSchema, values: unknown) => ValidationResult<Record<string, unknown>>} validateSettings
 *   an object of setting values (any subset of the settings; unknown keys refused)
 * @property {(value: unknown) => ValidationResult<Manifest>} validateManifest schema, semantic rules and every settings schema
 * @property {(value: unknown) => ValidationResult<import('./types.js').PriceList>} validatePriceReport
 * @property {(value: unknown) => ValidationResult<import('./types.js').FeatureReport>} validateFeatureReport
 * @property {(value: unknown) => ValidationResult<import('./types.js').StatusResponse>} validateStatusResponse
 * @property {(value: unknown) => ValidationResult<import('./types.js').WebsitesPage>} validateWebsitesPage
 * @property {(value: unknown) => ValidationResult<import('./types.js').Revocations>} validateRevocations
 * @property {(value: unknown) => ValidationResult<import('./types.js').Directory>} validateDirectory
 * @property {(value: unknown) => ValidationResult<import('./types.js').Notice>} validateNotice
 * @property {(value: unknown) => ValidationResult<import('./types.js').DataRightsRequest>} validateDataRightsRequest
 * @property {(value: unknown) => ValidationResult<import('./types.js').ActivityCopy>} validateActivityCopy
 */

/**
 * Create a validator with its own cached Ajv instance holding every built-in schema plus `options.schemas`.
 * @param {ValidatorOptions} [options]
 * @returns {Validator}
 */
export const createValidator = ({ schemas = [] } = {}) => {
	const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
	addFormats(ajv);
	for (const keyword of SETTING_EXTENSION_KEYWORDS) ajv.addKeyword({ keyword });
	for (const schema of ALL_SCHEMAS) ajv.addSchema(/** @type {import('ajv').AnySchemaObject} */ (schema));
	for (const schema of schemas) {
		if (typeof schema.$id !== 'string') throw new TypeError('Every extra schema needs a string $id.');
		ajv.addSchema(schema);
	}

	/** @type {WeakMap<object, ValidateFunction>} */
	const compiled = new WeakMap();

	/**
	 * Compile (once per object) a setting node or a settings values schema.
	 * @param {object} key cache key (the schema object it was built from)
	 * @param {() => Record<string, unknown>} build
	 * @returns {ValidateFunction}
	 */
	const compile = (key, build) => {
		let fn = compiled.get(key);
		if (fn === undefined) {
			fn = ajv.compile(build());
			compiled.set(key, fn);
		}
		return fn;
	};

	/**
	 * @param {Record<string, unknown>} node
	 * @returns {ValidateFunction}
	 */
	const compileNode = (node) => compile(node, () => node);

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

	/**
	 * Run a schema, then (only when it passes) its semantic check.
	 * @template T
	 * @param {string} schemaId
	 * @param {(value: T) => ValidationProblem[]} [semantic]
	 * @returns {(value: unknown) => ValidationResult<T>}
	 */
	const validator = (schemaId, semantic) => (value) => {
		const problems = run(schemaId, value);
		const typed = /** @type {T} */ (value);
		return result(typed, problems.length > 0 || semantic === undefined ? problems : semantic(typed));
	};

	/**
	 * Keyword fit, defaults and enum values of a settings schema that passed the meta-schema.
	 * @param {SettingsSchema} schema
	 * @param {Array<string | number>} path
	 * @returns {ValidationProblem[]}
	 */
	const settingsProblems = (schema, path) => {
		const out = checkSettingsRules(schema, path);
		if (out.length > 0) return out;
		for (const [key, node] of Object.entries(schema.properties)) {
			const nodePath = [...path, 'properties', key];
			const fn = compileNode(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node)));
			if (!fn(node.default))
				for (const problem of problemsFromAjv(fn.errors, pointer([...nodePath, 'default'])))
					out.push({ ...problem, keyword: RULES.settingDefault, message: `default ${problem.message}` });
			if (node.enum !== undefined) {
				const { enum: options, ...rest } = node;
				const plain = compile(options, () => /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (rest)));
				for (const [index, option] of options.entries())
					if (!plain(option)) out.push(at([...nodePath, 'enum', index], RULES.settingEnum, 'does not fit the setting'));
			}
		}
		return out;
	};

	/** @type {Validator['checkSettingsSchema']} */
	const checkSettingsSchema = (schema) => {
		const problems = run(SCHEMA_IDS.settingsSchema, schema);
		return problems.length > 0 ? problems : settingsProblems(/** @type {SettingsSchema} */ (schema), []);
	};

	/**
	 * @param {unknown} schema
	 * @returns {schema is SettingsSchema}
	 */
	const usable = (schema) => isPlainObject(schema) && isPlainObject(schema.properties);

	const unusable = Object.freeze([at([], RULES.settingsSchema, 'is not a settings schema')]);

	/** @type {Validator['validateSettingValue']} */
	const validateSettingValue = (schema, key, value) => {
		if (!usable(schema)) return result(value, unusable);
		if (!Object.hasOwn(schema.properties, key)) return result(value, [at([key], 'unknownSetting', 'is not a setting')]);
		const fn = compileNode(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (schema.properties[key])));
		return result(value, fn(value) ? [] : problemsFromAjv(fn.errors, pointer([key])));
	};

	/** @type {Validator['validateSettings']} */
	const validateSettings = (schema, values) => {
		const typed = /** @type {Record<string, unknown>} */ (values);
		if (!usable(schema)) return result(typed, unusable);
		const fn = compile(schema, () => ({ type: 'object', additionalProperties: false, properties: schema.properties }));
		return result(typed, fn(values) ? [] : problemsFromAjv(fn.errors));
	};

	/** @type {Validator['validateManifest']} */
	const validateManifest = (value) => {
		const problems = run(SCHEMA_IDS.manifest, value);
		const manifest = /** @type {Manifest} */ (value);
		if (problems.length > 0) return result(manifest, problems);
		const semantic = checkManifest(manifest);
		for (const [index, feature] of manifest.features.entries())
			semantic.push(...settingsProblems(feature.settings, ['features', index, 'settings']));
		return result(manifest, semantic);
	};

	return Object.freeze({
		validate,
		has,
		checkSettingsSchema,
		validateSettingValue,
		validateSettings,
		validateManifest,
		validatePriceReport: validator(SCHEMA_IDS.priceReport, checkPriceReport),
		validateFeatureReport: /** @type {Validator['validateFeatureReport']} */ (validator(SCHEMA_IDS.featureReport)),
		validateStatusResponse: validator(SCHEMA_IDS.statusResponse, checkStatusResponse),
		validateWebsitesPage: /** @type {Validator['validateWebsitesPage']} */ (validator(SCHEMA_IDS.websitesPage)),
		validateRevocations: /** @type {Validator['validateRevocations']} */ (validator(SCHEMA_IDS.revocations)),
		validateDirectory: validator(SCHEMA_IDS.directory, checkDirectory),
		validateNotice: /** @type {Validator['validateNotice']} */ (validator(SCHEMA_IDS.notice)),
		validateDataRightsRequest: /** @type {Validator['validateDataRightsRequest']} */ (validator(SCHEMA_IDS.dataRightsRequest)),
		validateActivityCopy: validator(SCHEMA_IDS.activityCopy, checkActivityCopy),
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

/** @param {unknown} value */
export const validateManifest = (value) => getDefaultValidator().validateManifest(value);
/** @param {unknown} schema */
export const checkSettingsSchema = (schema) => getDefaultValidator().checkSettingsSchema(schema);
/**
 * @param {SettingsSchema} schema
 * @param {string} key
 * @param {unknown} value
 */
export const validateSettingValue = (schema, key, value) => getDefaultValidator().validateSettingValue(schema, key, value);
/**
 * @param {SettingsSchema} schema
 * @param {unknown} values
 */
export const validateSettings = (schema, values) => getDefaultValidator().validateSettings(schema, values);
/** @param {unknown} value */
export const validatePriceReport = (value) => getDefaultValidator().validatePriceReport(value);
/** @param {unknown} value */
export const validateFeatureReport = (value) => getDefaultValidator().validateFeatureReport(value);
/** @param {unknown} value */
export const validateStatusResponse = (value) => getDefaultValidator().validateStatusResponse(value);
/** @param {unknown} value */
export const validateWebsitesPage = (value) => getDefaultValidator().validateWebsitesPage(value);
/** @param {unknown} value */
export const validateRevocations = (value) => getDefaultValidator().validateRevocations(value);
/** @param {unknown} value */
export const validateDirectory = (value) => getDefaultValidator().validateDirectory(value);
/** @param {unknown} value */
export const validateNotice = (value) => getDefaultValidator().validateNotice(value);
/** @param {unknown} value */
export const validateDataRightsRequest = (value) => getDefaultValidator().validateDataRightsRequest(value);
/** @param {unknown} value */
export const validateActivityCopy = (value) => getDefaultValidator().validateActivityCopy(value);
