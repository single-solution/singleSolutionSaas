/**
 * Every v1 schema, plus lookup tables.
 * @module
 */
import { commonSchema } from './common.js';
import { settingsMetaSchema } from './settings-schema.js';
import { manifestSchema } from './manifest.js';
import {
	directorySchema,
	featureReportSchema,
	noticeSchema,
	priceReportSchema,
	revocationsSchema,
	statusResponseSchema,
	websitesPageSchema,
} from './product-api.js';
import { activityCopySchema, dataRightsRequestSchema } from './cross-product.js';
import { problemSchema } from './problem.js';
import { deepFreeze } from '../util.js';

export * from './schema-ids.js';
export * from './common.js';
export * from './settings-schema.js';
export * from './manifest.js';
export * from './product-api.js';
export * from './cross-product.js';
export * from './problem.js';

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
	noticeSchema,
	dataRightsRequestSchema,
	activityCopySchema,
	problemSchema,
]);
