/**
 * @ss/contracts — versioned schemas and validators binding the Portal and every product: the manifest and settings
 * schemas, the Product ↔ Portal wire shapes, business.json, cross-product shapes, ids and RFC 9457 problems.
 * Additive changes only within v1; breaking changes ship as v2 schema ids.
 * @module
 */
export * from './types.js';
export * from './constants.js';
export * from './schemas/index.js';
export {
	createValidator,
	getDefaultValidator,
	problemsFromAjv,
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
	validateNotice,
	validateDataRightsRequest,
	validateActivityCopy,
} from './validate.js';
export { RULES, checkManifest, checkSettingsRules, findCycles, manifestPriceList } from './semantics.js';
export { BUSINESS_JSON_TEMPLATE, isTimeZone, validateBusinessJson } from './business.js';
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
export { deepFreeze, isUtcTimestamp, isServiceUrl, isPathOrServiceUrl } from './util.js';

/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {import('./errors.js').ProblemFactory} ProblemFactory */
/** @typedef {import('./validate.js').Validator} Validator */
/** @typedef {import('./ids.js').DomainResult} DomainResult */
/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */
/** @typedef {import('./types.js').Manifest} Manifest */
/** @typedef {import('./types.js').ManifestFeature} ManifestFeature */
/** @typedef {import('./types.js').ManifestPermission} ManifestPermission */
/** @typedef {import('./types.js').ManifestWidget} ManifestWidget */
/** @typedef {import('./types.js').SettingsSchema} SettingsSchema */
/** @typedef {import('./types.js').SettingNode} SettingNode */
/** @typedef {import('./types.js').PriceList} PriceList */
/** @typedef {import('./types.js').PriceListFeature} PriceListFeature */
/** @typedef {import('./types.js').FeatureReport} FeatureReport */
/** @typedef {import('./types.js').StatusResponse} StatusResponse */
/** @typedef {import('./types.js').WebsiteRow} WebsiteRow */
/** @typedef {import('./types.js').WebsitesPage} WebsitesPage */
/** @typedef {import('./types.js').Revocations} Revocations */
/** @typedef {import('./types.js').Directory} Directory */
/** @typedef {import('./types.js').Notice} Notice */
/** @typedef {import('./types.js').BusinessInfo} BusinessInfo */
/** @typedef {import('./types.js').DataRightsRequest} DataRightsRequest */
/** @typedef {import('./types.js').DataRightsExport} DataRightsExport */
/** @typedef {import('./types.js').DataRightsDelete} DataRightsDelete */
/** @typedef {import('./types.js').ActivityCopy} ActivityCopy */
/** @typedef {import('./constants.js').ProductStatus} ProductStatus */
/** @typedef {import('./constants.js').MerchantStatus} MerchantStatus */
/** @typedef {import('./constants.js').AdminRole} AdminRole */
/** @typedef {import('./constants.js').DashboardRole} DashboardRole */
/** @typedef {import('./constants.js').NoticeType} NoticeType */
/** @typedef {import('./constants.js').ProductUnavailableReason} ProductUnavailableReason */
/**
 * @template T
 * @typedef {import('./types.js').ValidationResult<T>} ValidationResult
 */
