/**
 * Cross-product shapes (PLAN 0.4.11).
 *
 * - Data rights request (`POST /v1/data-rights/export` and `/delete`): `{ user: { id?, email?, phone? } }` with at
 *   least one member. Answers: export `{ records: object }`, delete `{ deleted: integer, anonymised: integer }`.
 * - Activity copy (sent to Accounts after a logged action): `{ websiteId, productId, actor: { kind, id, name?, role? },
 *   action, target, label?, detail?, at }` (PLAN 0.8.10 K9: `label` names the target, for example an order number;
 *   `detail` is plain text). Never message contents, secrets or addresses.
 * - Message defaults (a product's `schemas/messages.json`, served by the kit at `GET /v1/message-defaults` with the
 *   product's id): `{ productId?, messages: [{ key, name, description?, values, required?, urgent?, sensitive?,
 *   channels }] }`. `channels` names every channel the product sends the message on, with its default words in US
 *   English: `email`, `push` and `staff_push` `{ subject, text }`, `sms` `{ text }`, and `whatsapp: null` (WhatsApp sends
 *   only templates the merchant had approved at Meta, so it never has a default). Notifications uses a default when
 *   the website has no template of its own. The words follow the template rules of `@ss/contracts/templates`
 *   (`checkMessageDefaults`).
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';
import { SUBJECT_LIMIT, TEMPLATE_KEY, VALUE_NAME } from '../templates.js';

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

/** Default words of a channel with a subject (email) or a title (browser and staff push). */
const titledWords = Object.freeze({
	type: 'object',
	required: ['subject', 'text'],
	additionalProperties: false,
	properties: {
		subject: { type: 'string', minLength: 1, maxLength: SUBJECT_LIMIT },
		text: { type: 'string', minLength: 1 },
	},
});

/** Most messages one product declares. */
export const MAX_DECLARED_MESSAGES = 200;

/** A product's message defaults (`schemas/messages.json`; the kit's `GET /v1/message-defaults` adds `productId`). */
export const messageDefaultsSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.messageDefaults,
	title: 'Message defaults',
	type: 'object',
	required: ['messages'],
	additionalProperties: false,
	properties: {
		productId: ref('productId'),
		messages: {
			type: 'array',
			maxItems: MAX_DECLARED_MESSAGES,
			items: {
				type: 'object',
				required: ['key', 'name', 'values', 'channels'],
				additionalProperties: false,
				properties: {
					key: { type: 'string', pattern: TEMPLATE_KEY.source },
					name: { type: 'string', minLength: 1, maxLength: 80 },
					description: { type: 'string', maxLength: 500 },
					values: {
						type: 'array',
						maxItems: 50,
						uniqueItems: true,
						items: { type: 'string', pattern: VALUE_NAME.source },
					},
					required: { type: 'boolean' },
					urgent: { type: 'boolean' },
					sensitive: { type: 'boolean' },
					channels: {
						type: 'object',
						minProperties: 1,
						additionalProperties: false,
						properties: {
							email: titledWords,
							sms: {
								type: 'object',
								required: ['text'],
								additionalProperties: false,
								properties: { text: { type: 'string', minLength: 1 } },
							},
							whatsapp: { type: 'null' },
							push: titledWords,
							staff_push: titledWords,
						},
					},
				},
			},
		},
	},
});
