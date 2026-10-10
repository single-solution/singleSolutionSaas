/**
 * Events (PLAN 0.8.10 K5; Payments' mechanism of 0.8.4 step 9, moved into the kit for every product that publishes
 * events). Each event `{ id, type: '<product>.<event>', at, data }` (`data` at most 16 kB: ids and small facts, never
 * addresses or message contents) is stored in the merchant database (`ss_<product>_events`, removed 30 days after it
 * happened by a TTL index) and listed by `GET /v1/events?since=&types=&cursor=&limit=` (server token, newest first).
 *
 * When the merchant pasted the Notifications token, each event is forwarded right after the request to Notifications'
 * `POST /v1/events` (the event id as its `Idempotency-Key`), which signs it and sends it to the merchant's webhook URLs.
 * A failed forward is retried on the website's later requests (1 min, 5 min, 30 min, 2 h); without the token an event
 * stays `not_connected` and readable through the API. Nothing runs in the background.
 * @module
 */
import { createId } from '@ss/contracts';
import { paginate, problem } from './http/results.js';
import { countHandlers } from './counts.js';
import { isObject, kitError } from './util.js';

/** @typedef {'pending' | 'sent' | 'not_connected' | 'failed'} Delivery */
/**
 * @typedef {{ id: string, type: string, at: Date, data: Record<string, unknown>, delivery: Delivery, attempts: number,
 *   dueAt: Date, expiresAt: Date }} EventRecord
 */
/** @typedef {{ websiteId: string, merchantId: string | null, after: (task: () => Promise<unknown>) => void }} EventContext */

/** Events are kept this long (TTL). */
export const EVENT_TTL_MS = 30 * 24 * 60 * 60_000;
/** Largest `data` of one event, in bytes of JSON. */
export const EVENT_DATA_MAX_BYTES = 16 * 1024;
/** Events forwarded per request, at most. */
const DRAIN_BATCH = 5;
/** Delivery attempts of one event, and the waits between them. */
const EVENT_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000]);
/** A claimed event is not claimed again for this long. */
const LEASE_MS = 60_000;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,30}(?:\.[a-z][a-z0-9_]{0,30}){1,3}$/;
const COLLECTION = 'events';

/** Merchant database indexes of the events (created when the product publishes events). */
export const EVENT_INDEXES = Object.freeze(
	/** @type {import('./data.js').IndexDefinition[]} */ ([
		{ collection: COLLECTION, keys: { websiteId: 1, id: 1 }, name: 'kit_events_id', unique: true },
		{ collection: COLLECTION, keys: { websiteId: 1, at: -1, id: -1 }, name: 'kit_events_newest' },
		{ collection: COLLECTION, keys: { websiteId: 1, delivery: 1, dueAt: 1 }, name: 'kit_events_due' },
		{ collection: COLLECTION, keys: { expiresAt: 1 }, name: 'kit_events_expiry', expireAfterSeconds: 0 },
	]),
);

const NO_ID = { projection: { _id: 0, websiteId: 0, merchantId: 0, createdAt: 0, updatedAt: 0 } };

/**
 * An event as the API answers it.
 * @param {string} productId
 * @param {EventRecord} event
 */
export const eventView = (productId, event) => ({
	id: event.id,
	type: `${productId}.${event.type}`,
	at: new Date(event.at).toISOString(),
	data: event.data,
	delivery: event.delivery,
});

/**
 * @param {{ productId: string, enabled: boolean, data: import('./data.js').Data,
 *   connections: import('./connections.js').Connections, now: () => number, logger: import('./logger.js').Logger }} options
 */
export const createEvents = ({ productId, enabled, data, connections, now, logger }) => {
	/** Per instance: websites known to have nothing to forward. @type {Set<string>} */
	const clean = new Set();
	const prefix = `${productId}.`;

	/** @param {string} websiteId @param {string | null} merchantId */
	const collectionOf = async (websiteId, merchantId) =>
		(await data.forWebsite(websiteId, merchantId ? { merchantId } : {})).collection(COLLECTION);

	/**
	 * Record an event; it is forwarded through Notifications right after the request.
	 * @param {EventContext} ctx
	 * @param {string} type `<event>` (for example `order.placed`); the product id is added in front
	 * @param {Record<string, unknown>} payload ids and small facts only
	 * @returns {Promise<ReturnType<typeof eventView>>}
	 */
	const emit = async (ctx, type, payload) => {
		if (!enabled) throw kitError('invalid_config', 'this product does not publish events (createProduct({ events: true }))');
		if (!EVENT_NAME.test(type)) throw kitError('invalid_argument', `invalid event type ${type}`);
		if (!isObject(payload) || JSON.stringify(payload).length > EVENT_DATA_MAX_BYTES)
			throw kitError('invalid_argument', 'event data is an object of at most 16 kB of JSON');
		const at = new Date(now());
		/** @type {EventRecord} */
		const event = {
			id: createId('evt'),
			type,
			at,
			data: payload,
			delivery: 'pending',
			attempts: 0,
			dueAt: at,
			expiresAt: new Date(at.getTime() + EVENT_TTL_MS),
		};
		await (await collectionOf(ctx.websiteId, ctx.merchantId)).insertOne({ ...event });
		clean.delete(ctx.websiteId);
		ctx.after(() => drain(ctx.websiteId, ctx.merchantId));
		return eventView(productId, event);
	};

	/**
	 * Right after a request for the website: forward due events through Notifications.
	 * @param {string} websiteId
	 * @param {string | null} merchantId
	 */
	const drain = async (websiteId, merchantId) => {
		if (!enabled || clean.has(websiteId)) return;
		const events = await collectionOf(websiteId, merchantId);
		for (let i = 0; i < DRAIN_BATCH; i += 1) {
			const event = /** @type {EventRecord | null} */ (
				await events.findOneAndUpdate(
					{ websiteId, delivery: 'pending', dueAt: { $lte: new Date(now()) } },
					{ $set: { dueAt: new Date(now() + LEASE_MS) } },
					{ sort: { dueAt: 1 }, returnDocument: 'after', ...NO_ID },
				)
			);
			if (!event) {
				if (i === 0 && (await events.countDocuments({ websiteId, delivery: 'pending' }, { limit: 1 })) === 0)
					clean.add(websiteId);
				return;
			}
			const answer = await connections.callProduct(websiteId, 'notifications', '/v1/events', {
				method: 'POST',
				body: { id: event.id, type: `${prefix}${event.type}`, at: new Date(event.at).toISOString(), data: event.data },
				headers: { 'idempotency-key': event.id },
			});
			/** @type {Partial<EventRecord>} */
			let set;
			if (answer.ok || answer.status === 409) set = { delivery: 'sent', attempts: event.attempts + 1 };
			else if (answer.reason === 'not_connected') set = { delivery: 'not_connected' };
			else {
				const attempts = event.attempts + 1;
				const wait = EVENT_DELAYS_MS[attempts - 1];
				set = wait === undefined ? { delivery: 'failed', attempts } : { attempts, dueAt: new Date(now() + wait) };
				logger.info('event not forwarded; retried on a later request', { websiteId, reason: answer.reason });
			}
			await events.updateOne({ websiteId, id: event.id }, { $set: set });
		}
	};

	/**
	 * The filter of `GET /v1/events` and its counts: `since` (ISO-8601: events after it), `types` (comma-separated full
	 * types, for example `payments.payment.paid`).
	 * @param {any} ctx
	 */
	const filterOf = (ctx) => {
		/** @type {Record<string, unknown>} */
		const filter = { websiteId: ctx.websiteId };
		const since = ctx.query.since;
		if (since !== undefined && since !== '') {
			const at = Date.parse(since);
			if (Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}T/.test(since))
				throw problem('validation_failed', 'since is an ISO-8601 time.', {
					errors: [{ path: '/since', message: 'since is an ISO-8601 time' }],
				});
			filter.at = { $gt: new Date(at) };
		}
		const types = ctx.query.types;
		if (types !== undefined && types !== '') {
			const list = String(types)
				.split(',')
				.map((type) => type.trim());
			if (list.length > 20 || list.some((type) => !type.startsWith(prefix) || !EVENT_NAME.test(type.slice(prefix.length))))
				throw problem('validation_failed', `types lists event types of this product (${prefix}…), separated by commas.`, {
					errors: [{ path: '/types', message: 'types lists event types of this product' }],
				});
			const names = list.map((type) => type.slice(prefix.length));
			filter.type = names.length === 1 ? names[0] : { $in: names };
		}
		return filter;
	};

	/**
	 * `GET /v1/events?since=&types=&cursor=&limit=` (server token): newest first, `{ items, nextCursor, hasMore }`.
	 * @param {any} ctx
	 */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const filter = filterOf(ctx);
		const [time, id] = Array.isArray(page.after) ? page.after : [];
		const keyset =
			typeof time === 'string' && typeof id === 'string'
				? { $or: [{ at: { $lt: new Date(time) } }, { at: new Date(time), id: { $lt: id } }] }
				: {};
		const rows = /** @type {EventRecord[]} */ (
			await (
				await collectionOf(ctx.websiteId, ctx.merchantId)
			)
				.find({ ...filter, ...keyset }, { ...NO_ID, sort: { at: -1, id: -1 }, limit: page.fetchLimit })
				.toArray()
		);
		return page.respond(
			rows.map((event) => eventView(productId, event)),
			(view) => [view.at, view.id],
		);
	};

	const counted = countHandlers({
		source: async (ctx) => ({ collection: await collectionOf(ctx.websiteId, ctx.merchantId), filter: filterOf(ctx) }),
		by: {
			type: { path: 'type', map: (value) => (typeof value === 'string' ? `${prefix}${value}` : null) },
			delivery: 'delivery',
		},
	});

	return Object.freeze({ emit, drain, list, count: counted.count, counts: counted.counts });
};

/** @typedef {ReturnType<typeof createEvents>} Events */
