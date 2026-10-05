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
	featureSchema: schemaId('feature-schema'),
	manifest: schemaId('manifest'),
	entitlementDocument: schemaId('entitlement-document'),
	eventEnvelope: schemaId('event-envelope'),
	placement: schemaId('placement'),
	problem: schemaId('problem'),
	graphCustomer: schemaId('graph:customer'),
	graphItem: schemaId('graph:item'),
	graphOrder: schemaId('graph:order'),
	graphSession: schemaId('graph:session'),
	graphFile: schemaId('graph:file'),
	graphConsentRecord: schemaId('graph:consent-record'),
	graphCustomFieldDefinition: schemaId('graph:custom-field-definition'),
});

/**
 * Schema id of a standard event data schema (`order.placed@1` → `urn:ss:contracts:v1:event:order.placed@1`).
 * @param {string} typeAtVersion
 * @returns {string}
 */
export const eventDataSchemaId = (typeAtVersion) => schemaId(`event:${typeAtVersion}`);
