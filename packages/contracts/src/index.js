/**
 * @ss/contracts — versioned schemas and validators binding the Portal and every product: the manifest and settings
 * schemas, the Product ↔ Portal wire shapes, business.json, cross-product shapes (with the message defaults products
 * declare), the website Setup sheet (`ss.blueprint/1`) with the business profile of its advisor (`./profile`), ids,
 * RFC 9457 problems, phone numbers and the template rules (`./templates`).
 * Additive changes only within v1; breaking changes ship as v2 schema ids.
 * @module
 */
export * from './types.js';
export { ADMIN_ROLES, IMPORT_LIMITS, PRODUCT_UNAVAILABLE_REASONS } from './constants.js';
export { BLUEPRINT_SCHEMA, BUILD_TEXT_MAX } from './schemas/blueprint.js';
export { PATTERNS } from './schemas/common.js';
export {
	validateManifest,
	checkSettingsSchema,
	validateSettingValue,
	validatePriceReport,
	validateFeatureReport,
	validateStatusResponse,
	validateWebsitesPage,
	validateRevocations,
	validateDirectory,
	validateDirectoryList,
	validateDataRightsRequest,
	validateActivityCopy,
	validateMessageDefaults,
	validateBusinessProfile,
	validateProductBlueprint,
	validateBlueprint,
} from './validate.js';
export { manifestPriceList } from './semantics.js';
export { BUSINESS_JSON_TEMPLATE, buildBusinessJson, validateBusinessJson } from './business.js';
export { PROFILE_CHOICES, adviseFeatures } from './profile.js';
export {
	DEFAULT_FORMAT,
	FORMAT_FIELDS,
	formatDate,
	formatMoney,
	formatViolation,
	zonedDay,
	zonedDayStart,
	zonedParts,
} from './format.js';
export { PROBLEM_CODES, createProblemFactory } from './errors.js';
export { createId, isId, normalizeDomain } from './ids.js';

/** @typedef {import('./constants.js').ProductUnavailableReason} ProductUnavailableReason */
/** @typedef {import('./constants.js').AdminRole} AdminRole */
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
