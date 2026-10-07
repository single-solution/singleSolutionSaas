/**
 * Collections of the `integration` module. Event payloads are client data (PLAN §1a): they are never stored here.
 * The only payload copies live sealed (`ctx.envelope`) inside queued delivery jobs.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const EVENTS = 'integration_events';
export const DELIVERIES = 'integration_deliveries';

/** Routing metadata is kept for 30 days: the dedupe window of `(websiteId, idempotencyKey)`. */
export const EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
/** Delivery records are kept for 30 days. */
export const DELIVERY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const collections = Object.freeze([
	defineCollection({
		module: 'integration',
		name: EVENTS,
		description:
			'Routing metadata of every accepted event (id, type, websiteId, env, source, receivedAt, idempotencyKey, delivery ' +
			'counts). No payload. The unique (websiteId, idempotencyKey) index is the deduplication point.',
		indexes: [
			{ keys: { websiteId: 1, idempotencyKey: 1 }, name: 'dedupe', unique: true },
			{ keys: { websiteId: 1, receivedAt: -1 } },
		],
		ttl: { field: 'receivedAt', afterSeconds: EVENT_RETENTION_SECONDS },
	}),
	defineCollection({
		module: 'integration',
		name: DELIVERIES,
		description:
			'One record per (event, product): status (pending | retrying | delivered | failed), attempts, last error code ' +
			'and timestamps. No payload.',
		indexes: [{ keys: { websiteId: 1, eventId: 1, appId: 1 }, name: 'delivery', unique: true }],
		ttl: { field: 'createdAt', afterSeconds: DELIVERY_RETENTION_SECONDS },
	}),
]);
