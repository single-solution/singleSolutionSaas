/**
 * Portal → product events (`POST /.well-known/ss-events`) and the in-process dispatcher shared with site events
 * (`POST /v1/events`). Deliveries are verified on the raw bytes (`@ss/protocol` `verifyEvent`: signature under the
 * pinned Portal JWKS, ±300 s, replay store), then parsed and checked against the `@ss/contracts` envelope (and the
 * data schema when the type has one), deduplicated on the event `id`, and dispatched to handlers registered with
 * `on(type, handler)` — exact `name@v`, bare `name` (any version) or `*`. A failing handler answers 500 and the id
 * is forgotten, so the Portal's retry is processed again.
 * @module
 */
import { SCHEMA_IDS, getDefaultValidator } from '@ss/contracts';
import { isProtocolError, verifyEvent } from '@ss/protocol';
import { isObject } from './util.js';

/** @typedef {import('@ss/contracts').EventEnvelope} EventEnvelope */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('./stores/types.js').ReplayStore} ReplayStore */
/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {{ source: 'portal' | 'site' | 'internal', website?: import('./keys.js').WebsiteBinding }} EventMeta */
/** @typedef {(event: EventEnvelope, meta: EventMeta) => unknown} EventHandler */

/** Platform control events (Portal → product). Their data shapes are defined here until @ss/contracts ships them. */
export const CONTROL_EVENTS = Object.freeze({
	'entitlement.changed@1': (/** @type {Record<string, unknown>} */ data) =>
		data.version === undefined || Number.isSafeInteger(data.version),
	'key.revoked@1': (/** @type {Record<string, unknown>} */ data) =>
		(typeof data.keyId === 'string' && data.keyId.length > 0) ||
		(Array.isArray(data.keyIds) &&
			data.keyIds.length > 0 &&
			data.keyIds.every((id) => typeof id === 'string' && id.length > 0)),
	'resource.changed@1': (/** @type {Record<string, unknown>} */ data) => typeof data.kind === 'string',
});

const DEDUPE_MS = 7 * 24 * 60 * 60_000;

/**
 * Validate an event envelope (and its data when a schema is known).
 * @param {unknown} value
 * @returns {{ ok: true, event: EventEnvelope } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkEvent = (value) => {
	const validator = getDefaultValidator();
	const envelope = validator.validate(SCHEMA_IDS.eventEnvelope, value);
	if (!envelope.ok) return { ok: false, errors: [...envelope.problems] };
	const event = /** @type {EventEnvelope} */ (value);
	const control = /** @type {Record<string, (data: Record<string, unknown>) => boolean>} */ (CONTROL_EVENTS)[event.type];
	if (control)
		return control(event.data)
			? { ok: true, event }
			: { ok: false, errors: [{ path: '/data', message: `invalid ${event.type} data` }] };
	const full = validator.validateEvent(value);
	if (full.ok) return { ok: true, event };
	// product-defined events without a published schema: the envelope is all we can check
	if (full.problems.length === 1 && full.problems[0]?.keyword === 'eventType') return { ok: true, event };
	return { ok: false, errors: [...full.problems] };
};

/**
 * @param {string} type `name@v`
 * @returns {string}
 */
const nameOf = (type) => type.split('@')[0] ?? type;

/**
 * @param {{ keyResolver: KeyResolver, replay: ReplayStore, now?: () => number, logger: Logger, toleranceSec?: number, trackEffects?: boolean }} options `trackEffects` counts handler runs per event id (for the dev probe)
 */
export const createEvents = ({ keyResolver, replay, now = Date.now, logger, toleranceSec = 300, trackEffects = false }) => {
	/** @type {Map<string, Set<EventHandler>>} */
	const handlers = new Map();
	/** @type {Map<string, number>} successful handler runs per `websiteId|eventId` (dev probes only) */
	const effects = new Map();

	/**
	 * Register a handler; returns an unsubscribe function.
	 * @param {string} type `name@v`, `name` or `*`
	 * @param {EventHandler} handler
	 * @returns {() => void}
	 */
	const on = (type, handler) => {
		if (typeof type !== 'string' || typeof handler !== 'function')
			throw new TypeError('on(type, handler) needs a type and a function');
		const set = handlers.get(type) ?? new Set();
		set.add(handler);
		handlers.set(type, set);
		return () => {
			set.delete(handler);
		};
	};

	/**
	 * Deduplicate on the event id and run matching handlers.
	 * @param {EventEnvelope} event
	 * @param {EventMeta} meta
	 * @returns {Promise<{ duplicate: boolean }>}
	 */
	const dispatch = async (event, meta) => {
		const owner = event.websiteId ?? 'platform';
		const dedupeId = `event-id|${owner}|${event.id}`;
		if (await replay.seen(dedupeId, now() + DEDUPE_MS)) return { duplicate: true };
		const matching = [
			...(handlers.get(event.type) ?? []),
			...(handlers.get(nameOf(event.type)) ?? []),
			...(handlers.get('*') ?? []),
		];
		try {
			for (const handler of matching) await handler(event, meta);
			if (trackEffects && matching.length > 0) {
				const key = `${owner}|${event.id}`;
				effects.set(key, (effects.get(key) ?? 0) + 1);
			}
		} catch (error) {
			await replay.forget(dedupeId).catch(() => {});
			throw error;
		}
		return { duplicate: false };
	};

	/**
	 * Handle a signed Portal delivery.
	 * @param {{ headers: Headers | Record<string, string | string[] | undefined>, rawBody: string | Uint8Array }} request
	 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
	 */
	const handle = async ({ headers, rawBody }) => {
		try {
			await verifyEvent({ headers, rawBody, keyResolver, replayStore: replay, now, toleranceSec });
		} catch (error) {
			logger.warn('event delivery rejected', { reason: isProtocolError(error) ? error.code : 'error' });
			return { status: 401, body: { error: 'unauthorized' } };
		}
		/** @type {unknown} */
		let parsed;
		try {
			parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody));
		} catch {
			return { status: 400, body: { error: 'invalid_event' } };
		}
		const checked = checkEvent(parsed);
		if (!checked.ok) {
			logger.warn('invalid event from the Portal', { type: isObject(parsed) ? parsed.type : undefined });
			return { status: 400, body: { error: 'invalid_event' } };
		}
		try {
			const { duplicate } = await dispatch(checked.event, { source: 'portal' });
			return { status: 200, body: duplicate ? { received: true, duplicate: true } : { received: true } };
		} catch (error) {
			logger.error('event handler failed', { type: checked.event.type, id: checked.event.id, error });
			return { status: 500, body: { error: 'handler_failed' } };
		}
	};

	/**
	 * How many times handlers ran for an event id (0 unless `trackEffects`).
	 * @param {string} websiteId
	 * @param {string} id
	 */
	const effectsOf = (websiteId, id) => effects.get(`${websiteId}|${id}`) ?? 0;

	return Object.freeze({ handle, on, dispatch, effects: effectsOf });
};
