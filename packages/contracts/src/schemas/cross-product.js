/**
 * Cross-product shapes (PLAN 0.4.11).
 *
 * - Data rights request (`POST /v1/data-rights/export` and `/delete`): `{ user: { id?, email?, phone? } }` with at
 *   least one member. Answers: export `{ records: object }`, delete `{ deleted: integer, anonymised: integer }`.
 * - Activity copy (sent to Accounts after a logged action): `{ websiteId, productId, actor: { kind, id, name?, role? },
 *   action, target, label?, detail?, at }` (PLAN 0.8.10 K9: `label` names the target, for example an order number;
 *   `detail` is plain text). Never message contents, secrets or addresses.
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';

const draft = 'https://json-schema.org/draft/2020-12/schema';

/** Data rights request body. */
export const dataRightsRequestSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.dataRightsRequest,
	title: 'Data rights request',
	type: 'object',
	required: ['user'],
	additionalProperties: false,
	properties: {
		user: {
			type: 'object',
			minProperties: 1,
			additionalProperties: false,
			properties: {
				id: { type: 'string', minLength: 1, maxLength: 256 },
				email: { type: 'string', format: 'email', maxLength: 320 },
				phone: { type: 'string', minLength: 3, maxLength: 40, pattern: '^\\+?[0-9 ().-]{3,40}$' },
			},
		},
	},
});

/** Activity-log copy sent to Accounts. */
export const activityCopySchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.activityCopy,
	title: 'Activity copy',
	type: 'object',
	required: ['websiteId', 'productId', 'actor', 'action', 'target', 'at'],
	additionalProperties: false,
	properties: {
		websiteId: ref('opaqueId'),
		productId: ref('productId'),
		actor: {
			type: 'object',
			required: ['kind', 'id'],
			additionalProperties: false,
			properties: {
				kind: { type: 'string', pattern: '^[a-z][a-z_]{0,31}$' },
				id: { type: 'string', minLength: 1, maxLength: 256 },
				name: { type: 'string', maxLength: 200 },
				role: { type: 'string', maxLength: 40 },
			},
		},
		action: { type: 'string', pattern: '^[a-z][a-z0-9_.]{0,63}$' },
		target: { type: 'string', minLength: 1, maxLength: 256 },
		label: { type: 'string', maxLength: 200 },
		detail: { type: 'string', maxLength: 2000 },
		at: ref('timestamp'),
	},
});
