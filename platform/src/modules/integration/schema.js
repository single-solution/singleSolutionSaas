/**
 * Collections of the `integration` module. Event payloads are client data (PLAN §1a): they are never stored here.
 * The only payload copies live sealed (`ctx.envelope`) inside queued jobs and, for at most 7 days, in the DLQ.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const EVENTS = 'integration_events';
export const DELIVERIES = 'integration_deliveries';
export const DEAD_LETTERS = 'integration_dead_letters';

/** Routing metadata is kept for 30 days: the dedupe window of `(websiteId, idempotencyKey)`. */
export const EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
/** Delivery logs are kept for 30 days. */
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
			'One record per (event, product): status, attempts, last error code and timestamps. No payload. Logs per website ' +
			'and per app read these.',
		indexes: [
			{ keys: { websiteId: 1, eventId: 1, appId: 1 }, name: 'delivery', unique: true },
			{ keys: { websiteId: 1, createdAt: -1, _id: -1 }, name: 'by_website' },
			{ keys: { appId: 1, createdAt: -1, _id: -1 }, name: 'by_app' },
			{ keys: { status: 1, createdAt: -1 }, name: 'by_status' },
		],
		ttl: { field: 'createdAt', afterSeconds: DELIVERY_RETENTION_SECONDS },
	}),
	defineCollection({
		module: 'integration',
		name: DEAD_LETTERS,
		description:
			'Dead-lettered deliveries (_id = deliveryId) with the event sealed by ctx.envelope (aad websiteId + eventId); ' +
			'removed by TTL at expireAt (≤ 7 days after the first dead-letter) or on replay.',
		indexes: [
			{ keys: { deadAt: -1, _id: -1 }, name: 'by_time' },
			{ keys: { websiteId: 1, deadAt: -1 } },
			{ keys: { appId: 1, deadAt: -1 } },
		],
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
]);
