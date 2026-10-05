/**
 * Problem details (RFC 9457) with `requestId` and field-level `errors[]` (PLAN Part E §5).
 * Extension members are allowed, as the RFC permits.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';

/** The problem schema. */
export const problemSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.problem,
	title: 'Problem details (RFC 9457)',
	type: 'object',
	required: ['type', 'title', 'status'],
	properties: {
		type: { type: 'string', format: 'uri-reference', minLength: 1, maxLength: 500 },
		title: { type: 'string', minLength: 1, maxLength: 200 },
		status: { type: 'integer', minimum: 100, maximum: 599 },
		detail: { type: 'string', maxLength: 4000 },
		instance: { type: 'string', format: 'uri-reference', maxLength: 2000 },
		requestId: ref('opaqueId'),
		errors: {
			type: 'array',
			maxItems: 500,
			items: {
				type: 'object',
				required: ['path', 'message'],
				additionalProperties: false,
				properties: {
					path: ref('jsonPointer'),
					message: { type: 'string', minLength: 1, maxLength: 1000 },
					keyword: { type: 'string', maxLength: 64 },
					code: { type: 'string', maxLength: 64 },
				},
			},
		},
	},
});
