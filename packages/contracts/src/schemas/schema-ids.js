/**
 * Stable `$id`s of every schema in @ss/contracts v1. Ids are URNs so no network location is implied or hardcoded.
 * @module
 */

/** Prefix shared by every v1 schema id. */
export const SCHEMA_ID_PREFIX = 'urn:ss:contracts:v1:';

/**
 * Build a v1 schema id from a short name.
 * @param {string} name
 * @returns {string}
 */
export const schemaId = (name) => `${SCHEMA_ID_PREFIX}${name}`;

/** Every schema id, keyed by short name. */
export const SCHEMA_IDS = Object.freeze({
	common: schemaId('common'),
	settingsSchema: schemaId('settings-schema'),
	manifest: schemaId('manifest'),
	priceReport: schemaId('price-report'),
	featureReport: schemaId('feature-report'),
	statusResponse: schemaId('status-response'),
	websitesPage: schemaId('websites-page'),
	revocations: schemaId('revocations'),
	directory: schemaId('directory'),
	notice: schemaId('notice'),
	dataRightsRequest: schemaId('data-rights-request'),
	activityCopy: schemaId('activity-copy'),
	problem: schemaId('problem'),
});
