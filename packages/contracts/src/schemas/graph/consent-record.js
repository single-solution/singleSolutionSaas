/**
 * Append-only consent record: one captured decision of one subject.
 * @module
 */
import { deepFreeze } from '../../util.js';
import { SCHEMA_IDS } from '../schema-ids.js';
import { commonRef as ref } from '../common.js';
import { entity, text } from './base.js';

/** The consent record schema. */
export const consentRecordSchema = deepFreeze(
	entity(
		SCHEMA_IDS.graphConsentRecord,
		'Graph consent record v1',
		{
			subjectType: { type: 'string', enum: ['customer', 'anonymous'] },
			subjectId: ref('opaqueId'),
			categories: {
				type: 'object',
				minProperties: 1,
				propertyNames: ref('slug'),
				additionalProperties: { type: 'boolean' },
			},
			policyVersion: text(64),
			source: { type: 'string', enum: ['banner', 'form', 'api', 'import', 'staff'] },
			recordedAt: ref('timestamp'),
			locale: ref('locale'),
			country: ref('country'),
		},
		['subjectType', 'subjectId', 'categories', 'policyVersion', 'source', 'recordedAt'],
	),
);
