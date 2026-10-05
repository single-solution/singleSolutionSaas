/**
 * Graph file node backed by the merchant's own storage; `storageRef` is opaque (never a signed URL or credential).
 * @module
 */
import { deepFreeze } from '../../util.js';
import { SCHEMA_IDS } from '../schema-ids.js';
import { commonRef as ref } from '../common.js';
import { entity, text } from './base.js';

/** The file schema. */
export const fileSchema = deepFreeze(
	entity(
		SCHEMA_IDS.graphFile,
		'Graph file v1',
		{
			name: text(255),
			contentType: { type: 'string', maxLength: 255, pattern: '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$' },
			size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
			storageRef: { type: 'string', minLength: 1, maxLength: 1024, pattern: '^[^\\s?#]+$' },
			folder: { type: 'string', maxLength: 1024, pattern: '^/(?:[^/\\s]+/)*$' },
			checksum: {
				type: 'object',
				required: ['algorithm', 'value'],
				additionalProperties: false,
				properties: { algorithm: { type: 'string', enum: ['sha256', 'sha384', 'sha512'] }, value: text(200) },
			},
			width: { type: 'integer', minimum: 1, maximum: 100_000 },
			height: { type: 'integer', minimum: 1, maximum: 100_000 },
			durationMs: { type: 'integer', minimum: 0 },
			alt: { type: 'string', maxLength: 500 },
			tags: ref('tags'),
			custom: ref('custom'),
		},
		['name', 'contentType', 'size', 'storageRef'],
	),
);
