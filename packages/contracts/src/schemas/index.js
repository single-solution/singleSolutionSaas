/**
 * Every v1 schema, plus lookup tables.
 * @module
 */
import { commonSchema } from './common.js';
import { settingsMetaSchema } from './settings-schema.js';
import { manifestSchema } from './manifest.js';
import {
	connectionHealthSchema,
	directoryListSchema,
	directorySchema,
	featureReportSchema,
	priceReportSchema,
	revocationsSchema,
	statusResponseSchema,
	websiteConnectionsSchema,
	websitesPageSchema,
} from './product-api.js';
import { activityCopySchema, dataRightsRequestSchema, messageDefaultsSchema } from './cross-product.js';
import { problemSchema } from './problem.js';
import { blueprintSchema, productBlueprintSchema } from './blueprint.js';
import { businessProfileSchema } from './profile.js';
import { websiteSettingsSchema } from './website-settings.js';
import { deepFreeze } from '../util.js';

export * from './schema-ids.js';
export * from './common.js';
export * from './settings-schema.js';
export * from './manifest.js';
export * from './product-api.js';
export * from './cross-product.js';
export * from './problem.js';
export * from './profile.js';
export * from './website-settings.js';
export * from './blueprint.js';

/** Every built-in schema, in dependency-free registration order. */
export const ALL_SCHEMAS = deepFreeze([
	commonSchema,
	settingsMetaSchema,
	manifestSchema,
	priceReportSchema,
	featureReportSchema,
	statusResponseSchema,
	websitesPageSchema,
	revocationsSchema,
	directorySchema,
	directoryListSchema,
	websiteConnectionsSchema,
	connectionHealthSchema,
	dataRightsRequestSchema,
	activityCopySchema,
	messageDefaultsSchema,
	businessProfileSchema,
	websiteSettingsSchema,
	productBlueprintSchema,
	blueprintSchema,
	problemSchema,
]);
