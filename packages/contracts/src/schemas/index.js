/**
 * Every v1 schema, plus lookup tables.
 * @module
 */
import { commonSchema } from './common.js';
import { featureMetaSchema } from './feature-schema.js';
import { manifestSchema } from './manifest.js';
import { entitlementDocumentSchema } from './entitlement-document.js';
import { eventEnvelopeSchema, customEventDataSchema, standardEventDataSchemas } from './event-envelope.js';
import { placementSchema } from './placement.js';
import { problemSchema } from './problem.js';
import {
	customerSchema,
	itemSchema,
	orderSchema,
	sessionSchema,
	fileSchema,
	consentRecordSchema,
	customFieldDefinitionSchema,
} from './graph/index.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { deepFreeze } from '../util.js';

export * from './schema-ids.js';
export * from './common.js';
export * from './feature-schema.js';
export * from './manifest.js';
export * from './entitlement-document.js';
export * from './event-envelope.js';
export * from './placement.js';
export * from './problem.js';
export * from './graph/index.js';

/** Graph entity name → schema id. */
export const GRAPH_ENTITY_SCHEMAS = Object.freeze({
	customer: SCHEMA_IDS.graphCustomer,
	item: SCHEMA_IDS.graphItem,
	order: SCHEMA_IDS.graphOrder,
	session: SCHEMA_IDS.graphSession,
	file: SCHEMA_IDS.graphFile,
	'consent-record': SCHEMA_IDS.graphConsentRecord,
	'custom-field-definition': SCHEMA_IDS.graphCustomFieldDefinition,
});

/** @typedef {keyof typeof GRAPH_ENTITY_SCHEMAS} GraphEntityName */

/** Every built-in schema, in dependency-free registration order. */
export const ALL_SCHEMAS = deepFreeze([
	commonSchema,
	featureMetaSchema,
	manifestSchema,
	entitlementDocumentSchema,
	eventEnvelopeSchema,
	customEventDataSchema,
	...standardEventDataSchemas(),
	placementSchema,
	problemSchema,
	customerSchema,
	itemSchema,
	orderSchema,
	sessionSchema,
	fileSchema,
	consentRecordSchema,
	customFieldDefinitionSchema,
]);
