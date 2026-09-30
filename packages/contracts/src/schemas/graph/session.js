/**
 * Graph session / visit.
 * @module
 */
import { deepFreeze } from '../../util.js';
import { SCHEMA_IDS } from '../schema-ids.js';
import { commonRef as ref } from '../common.js';
import { entity, text } from './base.js';

const campaign = { type: 'string', minLength: 1, maxLength: 200 };

/** The session schema. */
export const sessionSchema = deepFreeze(
	entity(
		SCHEMA_IDS.graphSession,
		'Graph session v1',
		{
			customerId: ref('opaqueId'),
			anonymousId: ref('opaqueId'),
			startedAt: ref('timestamp'),
			endedAt: ref('timestamp'),
			device: { type: 'string', enum: ['mobile', 'tablet', 'desktop'] },
			locale: ref('locale'),
			country: ref('country'),
			landingPath: { type: 'string', maxLength: 2048, pattern: '^/' },
			referrer: { type: 'string', format: 'uri', maxLength: 2048 },
			campaign: {
				type: 'object',
				additionalProperties: false,
				properties: { source: campaign, medium: campaign, name: campaign, term: campaign, content: campaign },
			},
			pageViews: { type: 'integer', minimum: 0, maximum: 1_000_000 },
			userAgent: text(512),
			custom: ref('custom'),
		},
		['startedAt'],
	),
);
