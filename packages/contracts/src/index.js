/**
 * @ss/contracts — versioned schemas and validators binding the Portal and every product (SSPS v1).
 * Additive changes only within v1; breaking changes ship as v2 schema ids.
 * @module
 */
export * from './types.js';

export * from './schemas/index.js';
export {
	createValidator,
	getDefaultValidator,
	problemsFromAjv,
	validateManifest,
	validateEntitlementDocument,
	validateEvent,
	validatePlacement,
	validateFeatureConfig,
} from './validate.js';
export {
	MANIFEST_RULES,
	EVENT_SUBSCRIBE_SCOPE,
	EVENT_PUBLISH_SCOPE,
	eventGlobMatches,
	isEventGlob,
	eventNamespace,
	checkManifest,
	checkFeatureSchema,
	featureValueError,
	readsOf,
	resolveFeature,
	findCycles,
	isUtcTimestamp,
	jsonEqual,
} from './manifest-semantics.js';
export { DOCUMENT_RULES, checkEntitlementDocument, checkPlacement, isLanguageTag, isTimeZone } from './document-semantics.js';
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

/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {import('./errors.js').ProblemFactory} ProblemFactory */
/** @typedef {import('./validate.js').Validator} Validator */
/** @typedef {import('./ids.js').DomainResult} DomainResult */
