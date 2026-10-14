/**
 * @ss/contracts — versioned schemas and validators binding the Portal and every product: the manifest and settings
 * schemas, the Product ↔ Portal wire shapes, business.json, cross-product shapes (with the message defaults products
 * declare), the website Setup sheet (`ss.blueprint/1`) with the business profile of its advisor (`./profile`), ids,
 * RFC 9457 problems, phone numbers and the template rules (`./templates`).
 * Additive changes only within v1; breaking changes ship as v2 schema ids.
 * @module
 */
export * from './types.js';
export * from './constants.js';
export { BLUEPRINT_SCHEMA, BLUEPRINT_UNREACHABLE_REASONS, BUILD_TEXT_MAX } from './schemas/blueprint.js';
export { PATTERNS } from './schemas/common.js';
export {
	createValidator,
	validateManifest,
	checkSettingsSchema,
	validateSettingValue,
	validateSettings,
	validatePriceReport,
	validateFeatureReport,
	validateStatusResponse,
	validateWebsitesPage,
	validateRevocations,
	validateDirectory,
	validateDirectoryList,
	validateNotice,
	validateDataRightsRequest,
	validateActivityCopy,
	validateMessageDefaults,
	validateBusinessProfile,
	validateProductBlueprint,
	validateBlueprint,
} from './validate.js';
export { RULES, manifestPriceList } from './semantics.js';
export { BUSINESS_JSON_TEMPLATE, validateBusinessJson } from './business.js';
export {
	PROFILE_CHOICES,
	PROFILE_NONE,
	adviseFeatures,
	featureFit,
	isRecommendTag,
	profileTags,
	ruleHolds,
	ruleProblem,
} from './profile.js';
export {
	DEFAULT_FORMAT,
	FORMAT_FIELDS,
	currencyDigits,
	formatDate,
	formatMoney,
	formatViolation,
	normaliseFormat,
	zonedDay,
	zonedDayStart,
	zonedParts,
} from './format.js';
export { PHONE_COUNTRIES, callingCodeOf, normalisePhone, phoneInCountries, websiteCallingCode } from './phone.js';
export { PROBLEM_CODES, problem, createProblemFactory } from './errors.js';
export { createId, isId, normaliseDomain, hostMatchesDomain } from './ids.js';

/** @typedef {import('./format.js').Format} Format */
/** @typedef {import('./format.js').Viewer} Viewer */
/** @typedef {import('./format.js').DateStyle} DateStyle */
/** @typedef {import('./format.js').ZonedParts} ZonedParts */
/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {import('./errors.js').ProblemFactory} ProblemFactory */
/** @typedef {import('./validate.js').Validator} Validator */
/** @typedef {import('./ids.js').DomainResult} DomainResult */
/** @typedef {import('./profile.js').BusinessProfile} BusinessProfile */
/** @typedef {import('./profile.js').FeatureFit} FeatureFit */
