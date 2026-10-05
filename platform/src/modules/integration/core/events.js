/**
 * Pure rules of the Event Hub: ingest request parsing (header or body authentication), batch limits, per-event
 * checks for website and product sources, control-event construction and fan-out routing. No I/O.
 * @module
 */
import {
	CONTROL_EVENT_DATA,
	eventEnvelopeSchema,
	EVENT_PUBLISH_SCOPE,
	EVENT_SUBSCRIBE_SCOPE,
	LOADER_EVENT_DATA,
	STANDARD_EVENT_DATA,
	actorAllowedForKeyKind,
	eventGlobMatches,
	eventNamespace,
	eventScopeOf,
	validateEvent,
} from '@ss/contracts';

/** @typedef {import('@ss/contracts').EventEnvelope} EventEnvelope */
/** @typedef {import('@ss/contracts').Manifest} Manifest */

/** Most events in one request. */
export const MAX_EVENTS = 100;
/** Largest serialized `events` array of one request (bytes). */
export const MAX_BATCH_BYTES = 256 * 1024;
/** Largest identity token accepted (bytes). */
export const MAX_IDENTITY_BYTES = 8192;

/**
 * @typedef {{ ok: false, code: 'bad_request' | 'unauthorized' | 'payload_too_large' | 'unsupported_media_type', detail: string }} RequestFailure
 * @typedef {{ status: 'accepted' | 'duplicate' | 'rejected', id: string | null, idempotencyKey: string | null, reason?: string, errors?: Array<{ path: string, message: string }> }} EventResult
 */

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

/**
 * Check the `events` array of a request (count and size).
 * @param {unknown} events
 * @returns {{ ok: true, events: unknown[] } | RequestFailure}
 */
export const checkBatch = (events) => {
	if (!Array.isArray(events)) return { ok: false, code: 'bad_request', detail: 'events must be an array.' };
	if (events.length === 0) return { ok: false, code: 'bad_request', detail: 'events must not be empty.' };
	if (events.length > MAX_EVENTS)
		return { ok: false, code: 'payload_too_large', detail: `At most ${MAX_EVENTS} events per request.` };
	if (byteLength(events) > MAX_BATCH_BYTES)
		return { ok: false, code: 'payload_too_large', detail: `The events exceed ${MAX_BATCH_BYTES} bytes.` };
	return { ok: true, events };
};

/**
 * Parse a website ingest request. Browsers send `application/json` with `Authorization: Bearer <pk>`; beacons send
 * `text/plain` with the credential in the body (`{ key, identity?, events }`). Both forms are accepted for both
 * content types. A header key wins; a body key that differs from it is refused.
 * @param {{ rawBody: string, contentType: string | null, authorization: string | null, identity: string | null }} input
 * @returns {{ ok: true, key: string, identity: string | null, events: unknown[], via: 'header' | 'body' } | RequestFailure}
 */
export const parseIngestRequest = ({ rawBody, contentType, authorization, identity }) => {
	const type = (contentType ?? '').toLowerCase();
	if (!/^(application\/([a-z0-9.+-]+\+)?json|text\/plain)(\s*;|$)/.test(type))
		return { ok: false, code: 'unsupported_media_type', detail: 'Send application/json or text/plain.' };
	/** @type {unknown} */
	let body;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return { ok: false, code: 'bad_request', detail: 'The body is not valid JSON.' };
	}
	if (!isObject(body)) return { ok: false, code: 'bad_request', detail: 'The body must be an object.' };
	const record = /** @type {Record<string, unknown>} */ (body);
	const unknown = Object.keys(record).filter((key) => !['key', 'identity', 'events'].includes(key));
	if (unknown.length > 0) return { ok: false, code: 'bad_request', detail: `Unknown member ${unknown[0]}.` };
	if (record.key !== undefined && typeof record.key !== 'string')
		return { ok: false, code: 'bad_request', detail: 'key must be a string.' };
	if (record.identity !== undefined && record.identity !== null && typeof record.identity !== 'string')
		return { ok: false, code: 'bad_request', detail: 'identity must be a string.' };

	/** @type {string} */
	let key;
	/** @type {'header' | 'body'} */
	let via;
	if (authorization !== null) {
		const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
		if (!match?.[1]) return { ok: false, code: 'unauthorized', detail: 'Send Authorization: Bearer <website key>.' };
		if (record.key !== undefined && record.key !== match[1])
			return { ok: false, code: 'bad_request', detail: 'The body key differs from the Authorization header.' };
		key = match[1];
		via = 'header';
	} else {
		if (typeof record.key !== 'string' || record.key === '')
			return { ok: false, code: 'unauthorized', detail: 'A website key is required.' };
		key = record.key;
		via = 'body';
	}
	const token = identity ?? (typeof record.identity === 'string' ? record.identity : null);
	if (token !== null && (token.length === 0 || Buffer.byteLength(token, 'utf8') > MAX_IDENTITY_BYTES))
		return { ok: false, code: 'bad_request', detail: 'The identity token is invalid.' };
	const batch = checkBatch(record.events);
	if (!batch.ok) return batch;
	return { ok: true, key, identity: token, events: batch.events, via };
};

/**
 * @param {unknown} raw
 * @returns {{ id: string | null, idempotencyKey: string | null }}
 */
export const identify = (raw) => {
	const value = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
	return {
		id: typeof value.id === 'string' && value.id.length <= 128 ? value.id : null,
		idempotencyKey:
			typeof value.idempotencyKey === 'string' && value.idempotencyKey.length <= 255 ? value.idempotencyKey : null,
	};
};

/**
 * @param {ReadonlyArray<{ path: string, message: string }>} problems
 */
const firstErrors = (problems) => problems.slice(0, 5).map(({ path, message }) => ({ path, message }));

/** @param {string} type `type@v` */
export const isControlEvent = (type) => Object.hasOwn(CONTROL_EVENT_DATA, type);

const PLATFORM_NAMESPACES = new Set(
	[...Object.keys(CONTROL_EVENT_DATA), ...Object.keys(LOADER_EVENT_DATA)].map((type) => type.split('.')[0]),
);
const CONTROL_NAMESPACES = new Set(Object.keys(CONTROL_EVENT_DATA).map((type) => type.split('.')[0]));

/**
 * @typedef {{ ok: true, event: EventEnvelope } | { ok: false, reason: string, errors?: Array<{ path: string, message: string }> }} EventCheck
 */

/**
 * Whether the contracts' envelope carries `context.keyKind` (provenance stamped by the Event Hub, F.16). Until it does,
 * the Hub still strips any producer-supplied value but stamps nothing.
 */
export const KEY_KIND_SUPPORTED = Boolean(/** @type {any} */ (eventEnvelopeSchema).properties?.context?.properties?.keyKind);

/**
 * A copy of a raw event without producer-supplied provenance (`context.keyKind` is the Event Hub's to set).
 * @param {unknown} raw
 * @returns {unknown}
 */
export const withoutProvenance = (raw) => {
	if (!isObject(raw)) return raw;
	const event = /** @type {Record<string, unknown>} */ (raw);
	if (!isObject(event.context) || !Object.hasOwn(/** @type {object} */ (event.context), 'keyKind')) return raw;
	const context = { .../** @type {Record<string, unknown>} */ (event.context) };
	delete context.keyKind;
	return { ...event, context };
};

/**
 * Stamp the verified key kind of a website event (`pk` browser, `sk` server) when the contracts support it.
 * @param {EventEnvelope} event
 * @param {'pk' | 'sk'} kind
 * @returns {EventEnvelope}
 */
export const stampKeyKind = (event, kind) =>
	KEY_KIND_SUPPORTED ? /** @type {EventEnvelope} */ ({ ...event, context: { ...(event.context ?? {}), keyKind: kind } }) : event;

/**
 * Check one event sent by a website (key claims bind website and environment).
 * @param {unknown} input
 * @param {{ websiteId: string, env: string, kind: 'pk' | 'sk' }} key
 * @returns {EventCheck}
 */
export const checkWebsiteEvent = (input, key) => {
	// provenance is the Hub's: a producer-supplied `context.keyKind` is dropped, the verified one stamped below
	const raw = withoutProvenance(input);
	const checked = validateEvent(raw);
	if (!checked.ok) {
		const type = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw).type : undefined;
		if (typeof type === 'string' && CONTROL_NAMESPACES.has(type.split('.')[0])) return { ok: false, reason: 'control_event' };
		return { ok: false, reason: 'invalid_event', errors: firstErrors(checked.problems) };
	}
	const event = checked.value;
	if (isControlEvent(event.type)) return { ok: false, reason: 'control_event' };
	if (event.websiteId !== key.websiteId) return { ok: false, reason: 'website_mismatch' };
	if (event.env !== key.env) return { ok: false, reason: 'env_mismatch' };
	// one rule for every producer and consumer: @ss/contracts WEBSITE_KEY_ACTORS
	if (!actorAllowedForKeyKind(key.kind, event.actor.type)) return { ok: false, reason: 'actor_not_allowed' };
	return { ok: true, event: stampKeyKind(event, key.kind) };
};

/**
 * Check one event published by a product against its accepted manifest: envelope, platform namespaces refused,
 * declared in `events.publishes`, product namespace or a standard event covered by an `events.publish:` scope.
 * Product events without a catalogued data schema are checked on the envelope only. Provenance: a producer-supplied
 * `context.keyKind` is dropped (it describes website keys only) and accepted events are marked `context.source:
 * 'product'` with `context.product` = the publisher's slug.
 * @param {unknown} input
 * @param {Manifest} manifest
 * @returns {EventCheck}
 */
export const checkProductEvent = (input, manifest) => {
	const raw = withoutProvenance(input);
	const namespace = `${eventNamespace(manifest.product.slug)}.`;
	const checked = validateEvent(raw);
	const type = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw).type : undefined;
	if (typeof type === 'string' && PLATFORM_NAMESPACES.has(type.split('.')[0])) return { ok: false, reason: 'control_event' };
	const ownUnknown =
		!checked.ok &&
		checked.problems.length === 1 &&
		checked.problems[0]?.keyword === 'eventType' &&
		typeof type === 'string' &&
		type.startsWith(namespace);
	if (!checked.ok && !ownUnknown) return { ok: false, reason: 'invalid_event', errors: firstErrors(checked.problems) };
	const event = /** @type {EventEnvelope} */ (raw);
	if (!(manifest.events?.publishes ?? []).includes(event.type)) return { ok: false, reason: 'not_declared' };
	if (event.context?.product !== undefined && event.context.product !== manifest.product.slug)
		return { ok: false, reason: 'product_mismatch' };
	/** @type {EventEnvelope} */
	const marked = /** @type {EventEnvelope} */ ({
		...event,
		context: { ...(event.context ?? {}), source: 'product', product: manifest.product.slug },
	});
	if (event.type.startsWith(namespace)) return { ok: true, event: marked };
	if (!Object.hasOwn(STANDARD_EVENT_DATA, event.type)) return { ok: false, reason: 'outside_namespace' };
	const publish = scopePatterns(manifest.scopes ?? [], EVENT_PUBLISH_SCOPE);
	if (!publish.some((pattern) => eventGlobMatches(pattern, event.type))) return { ok: false, reason: 'publish_scope_missing' };
	return { ok: true, event: marked };
};

/**
 * Build and validate a Portal control event. Website-scoped types need `websiteId`; platform-scoped types
 * (`eventScopeOf(type) === 'platform'`, e.g. `manifest.accepted@1`) carry `scope: 'platform'` and no `websiteId`.
 * @param {{ type: string, data: unknown, websiteId?: string | null, env: 'live' | 'test', id: string, occurredAt: string }} input
 * @returns {{ ok: true, event: EventEnvelope } | { ok: false, reason: string, errors?: Array<{ path: string, message: string }> }}
 */
export const buildControlEvent = ({ type, data, websiteId = null, env, id, occurredAt }) => {
	if (!isControlEvent(type)) return { ok: false, reason: 'unknown_control_event' };
	const platform = eventScopeOf(type) === 'platform';
	if (platform && websiteId) return { ok: false, reason: 'platform_scoped' };
	if (!platform && !websiteId) return { ok: false, reason: 'website_required' };
	const event = {
		id,
		type,
		...(platform ? { scope: 'platform' } : { websiteId }),
		env,
		occurredAt,
		idempotencyKey: id,
		actor: { type: 'system' },
		data,
		context: { source: 'portal' },
	};
	const checked = validateEvent(event);
	if (!checked.ok) return { ok: false, reason: 'invalid_event', errors: firstErrors(checked.problems) };
	return { ok: true, event: checked.value };
};

/**
 * @param {ReadonlyArray<string>} scopes
 * @param {string} prefix
 */
const scopePatterns = (scopes, prefix) => scopes.filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));

/**
 * @typedef {object} Route
 * @property {string} appId
 * @property {string[]} consumes `events.consumes` of the accepted manifest
 * @property {string[]} subscribe glob patterns of its `events.subscribe:` scopes
 */

/**
 * Routing entry of a subscribed product.
 * @param {string} appId
 * @param {Pick<Manifest, 'events' | 'scopes'>} manifest
 * @returns {Route}
 */
export const routeOf = (appId, manifest) => ({
	appId,
	consumes: [...(manifest.events?.consumes ?? [])],
	subscribe: scopePatterns(manifest.scopes ?? [], EVENT_SUBSCRIBE_SCOPE),
});

/**
 * Products that receive an event: they consume the type (glob rules of `eventGlobMatches`; a version-less entry
 * matches every version) and, unless it is a control event, hold an `events.subscribe:` scope covering it. The
 * publisher never receives its own event.
 * @param {string} type `type@v`
 * @param {ReadonlyArray<Route>} table
 * @param {{ exclude?: string | null }} [options]
 * @returns {string[]} app ids (deduplicated, table order)
 */
export const consumersOf = (type, table, { exclude = null } = {}) => {
	const control = isControlEvent(type);
	const out = new Set(
		table
			.filter(
				(route) =>
					route.appId !== exclude &&
					route.consumes.some((pattern) => eventGlobMatches(pattern, type)) &&
					(control || route.subscribe.some((pattern) => eventGlobMatches(pattern, type))),
			)
			.map((route) => route.appId),
	);
	return [...out];
};

/** App statuses that still receive deliveries. */
export const DELIVERABLE_APP_STATUSES = Object.freeze(['active', 'deprecated']);

/**
 * @param {{ status?: unknown, kind?: unknown } | null | undefined} app
 * @returns {boolean}
 */
export const isDeliverableApp = (app) => !!app && DELIVERABLE_APP_STATUSES.includes(String(app.status)) && app.kind !== 'pack';
