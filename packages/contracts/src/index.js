/**
 * @ss/contracts — versioned schemas and validators binding the Portal and every product (SSPS v1).
 * Additive changes only within v1; breaking changes ship as v2 schema ids.
 * @module
 */
import './types.js';

export * from './schemas/index.js';
export {
	createValidator,
	getDefaultValidator,
	problemsFromAjv,
	validateManifest,
	validateEntitlementDocument,
	validateEvent,
	validatePlacement,
	validateGraphEntity,
	validateFeatureConfig,
} from './validate.js';
export {
	MANIFEST_RULES,
	EVENT_SUBSCRIBE_SCOPE,
	EVENT_PUBLISH_SCOPE,
	eventGlobMatches,
	eventNamespace,
	checkManifest,
	checkFeatureSchema,
	featureValueError,
	resolveFeature,
	findCycles,
	isUtcTimestamp,
	jsonEqual,
} from './manifest-semantics.js';
export { DOCUMENT_RULES, checkEntitlementDocument, checkPlacement, isTimeZone } from './document-semantics.js';
export { PROBLEM_CODES, problem, createProblemFactory } from './errors.js';
export {
	ID_PREFIXES,
	ID_ALPHABET,
	ID_RANDOM_BYTES,
	idPattern,
	encodeBase32,
	createId,
	isId,
	parseId,
	normaliseDomain,
	hostMatchesDomain,
} from './ids.js';
export { deepFreeze } from './util.js';

/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */
/**
 * @template T
 * @typedef {import('./types.js').ValidationResult<T>} ValidationResult
 */
/** @typedef {import('./types.js').Manifest} Manifest */
/** @typedef {import('./types.js').ManifestElement} ManifestElement */
/** @typedef {import('./types.js').ManifestPlan} ManifestPlan */
/** @typedef {import('./types.js').FeatureSchema} FeatureSchema */
/** @typedef {import('./types.js').FeatureNode} FeatureNode */
/** @typedef {import('./types.js').EntitlementDocument} EntitlementDocument */
/** @typedef {import('./types.js').EventEnvelope} EventEnvelope */
/** @typedef {import('./types.js').Placement} Placement */
/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {import('./errors.js').ProblemFactory} ProblemFactory */
/** @typedef {import('./validate.js').Validator} Validator */
/** @typedef {import('./ids.js').DomainResult} DomainResult */
