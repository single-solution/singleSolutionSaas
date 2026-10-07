/**
 * Every v1 schema, plus lookup tables.
 * @module
 */
import { commonSchema } from './common.js';
import { featureMetaSchema } from './feature-schema.js';
import { manifestSchema } from './manifest.js';
import { entitlementDocumentSchema } from './entitlement-document.js';
import {
	eventEnvelopeSchema,
	customEventDataSchema,
	elementUiEventDataSchema,
	catalogueEventDataSchemas,
	elementEventDataSchemas,
} from './event-envelope.js';
import { placementSchema } from './placement.js';
import { problemSchema } from './problem.js';
import { deepFreeze } from '../util.js';

export * from './schema-ids.js';
export * from './common.js';
export * from './feature-schema.js';
export * from './manifest.js';
export * from './entitlement-document.js';
export * from './event-envelope.js';
export * from './placement.js';
export * from './problem.js';

/** Every built-in schema, in dependency-free registration order. */
export const ALL_SCHEMAS = deepFreeze([
	commonSchema,
	featureMetaSchema,
	manifestSchema,
	entitlementDocumentSchema,
	eventEnvelopeSchema,
	customEventDataSchema,
	elementUiEventDataSchema,
	...catalogueEventDataSchemas(),
	...elementEventDataSchemas(),
	placementSchema,
	problemSchema,
]);
