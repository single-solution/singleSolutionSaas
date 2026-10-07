/**
 * Product ↔ Portal wire shapes (PLAN 0.4.12): price report, feature report, status response, websites page,
 * revocations, directory and notice body. The validators in `validate.js` add the semantic rules (unique keys,
 * dependencies, real timestamps, grace consistency).
 * @module
 */
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';
import { commonRef as ref } from './common.js';
import { NOTICE_TYPES } from '../constants.js';

const draft = 'https://json-schema.org/draft/2020-12/schema';

/** `PUT /v1/product/prices` body (also the `prices` of a connect answer). */
export const priceReportSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.priceReport,
	title: 'Price report',
	type: 'object',
	required: ['version', 'features'],
	additionalProperties: false,
	properties: {
		version: ref('version'),
		features: {
			type: 'array',
			maxItems: 100,
			items: {
				type: 'object',
				required: ['key', 'name', 'description', 'dependsOn', 'millicreditsPerHour'],
				additionalProperties: false,
				properties: {
					key: ref('featureKey'),
					name: ref('name'),
					description: ref('description'),
					dependsOn: ref('featureKeys'),
					millicreditsPerHour: ref('millicredits'),
				},
			},
		},
	},
});

/** `PUT /v1/product/websites/:websiteId/features` body. */
export const featureReportSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.featureReport,
	title: 'Feature report',
	type: 'object',
	required: ['version', 'on', 'adminId', 'adminName'],
	additionalProperties: false,
	properties: {
		version: ref('version'),
		on: ref('featureKeys'),
		adminId: ref('opaqueId'),
		adminName: ref('name'),
	},
});

/** `GET /v1/product/websites/:websiteId/status` answer. */
export const statusResponseSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.statusResponse,
	title: 'Status response',
	type: 'object',
	required: [
		'websiteId',
		'merchantId',
		'merchantName',
		'domain',
		'status',
		'graceEndsAt',
		'todayMillicredits',
		'featuresVersion',
		'validUntil',
	],
	additionalProperties: false,
	properties: {
		websiteId: ref('opaqueId'),
		merchantId: ref('opaqueId'),
		merchantName: ref('name'),
		domain: ref('hostname'),
		status: ref('productStatus'),
		graceEndsAt: { anyOf: [ref('timestamp'), { type: 'null' }] },
		todayMillicredits: ref('millicredits'),
		featuresVersion: ref('count'),
		validUntil: ref('timestamp'),
	},
});

/** `GET /v1/product/websites?cursor=` answer (removed products excluded). */
export const websitesPageSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.websitesPage,
	title: 'Websites page',
	type: 'object',
	required: ['items', 'cursor'],
	additionalProperties: false,
	properties: {
		items: {
			type: 'array',
			maxItems: 1000,
			items: {
				type: 'object',
				required: ['websiteId', 'domain', 'merchantId', 'merchantName', 'status'],
				additionalProperties: false,
				properties: {
					websiteId: ref('opaqueId'),
					domain: ref('hostname'),
					merchantId: ref('opaqueId'),
					merchantName: ref('name'),
					status: ref('productStatus'),
				},
			},
		},
		cursor: ref('cursor'),
	},
});

/** `GET /v1/product/revocations?since=` answer. */
export const revocationsSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.revocations,
	title: 'Revocations',
	type: 'object',
	required: ['tokenIds', 'cursor'],
	additionalProperties: false,
	properties: {
		tokenIds: { type: 'array', maxItems: 10_000, items: { type: 'string', minLength: 1, maxLength: 256 } },
		cursor: ref('cursor'),
	},
});

/** `GET /v1/product/directory/:productId` answer. */
export const directorySchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.directory,
	title: 'Directory entry',
	type: 'object',
	required: ['baseUrl'],
	additionalProperties: false,
	properties: { baseUrl: ref('url') },
});

/** Notice body `{ type, websiteId?, subject? }`. */
export const noticeSchema = deepFreeze({
	$schema: draft,
	$id: SCHEMA_IDS.notice,
	title: 'Notice',
	type: 'object',
	required: ['type'],
	additionalProperties: false,
	properties: {
		type: { type: 'string', enum: [...NOTICE_TYPES] },
		websiteId: ref('opaqueId'),
		subject: ref('opaqueId'),
	},
	if: { properties: { type: { const: 'sessions.revoked' } } },
	then: { required: ['subject'], properties: { subject: true, websiteId: false } },
	else: { required: ['websiteId'], properties: { websiteId: true, subject: false } },
});
