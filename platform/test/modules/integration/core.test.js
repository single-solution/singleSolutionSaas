import { describe, expect, it } from 'vitest';
import { netError } from '@ss/net';
import {
	attemptsForWindow,
	classifyError,
	classifyStatus,
	eventsEndpoint,
} from '../../../src/modules/integration/core/delivery.js';
import {
	MAX_BATCH_BYTES,
	MAX_EVENTS,
	buildControlEvent,
	checkBatch,
	KEY_KIND_SUPPORTED,
	checkProductEvent,
	checkWebsiteEvent,
	withoutProvenance,
	consumersOf,
	identify,
	isDeliverableApp,
	parseIngestRequest,
	routeOf,
} from '../../../src/modules/integration/core/events.js';
const WEBSITE = 'web_0123456789abcdefghjkmnpq';
const KEY = /** @type {const} */ ({ websiteId: WEBSITE, env: 'live', kind: 'pk' });

/** @param {Record<string, unknown>} [over] */
const event = (over = {}) => ({
	id: 'evt_0123456789abcdefghjkmnpq',
	type: 'page.viewed@1',
	websiteId: WEBSITE,
	env: 'live',
	occurredAt: '2026-10-01T10:00:00.000Z',
	idempotencyKey: 'k1',
	actor: { type: 'anonymous', id: 'anon1' },
	data: { url: 'https://shop.example.com/a', path: '/a' },
	...over,
});

describe('events endpoint', () => {
	it('joins the events endpoint', () => {
		expect(eventsEndpoint({ base: 'https://a.example.com/app/', events: '/.well-known/ss-events' })).toBe(
			'https://a.example.com/app/.well-known/ss-events',
		);
		expect(eventsEndpoint({ base: 'https://a.example.com' })).toBeNull();
		expect(eventsEndpoint({ base: 'https://a.example.com', events: 'x' })).toBeNull();
		expect(eventsEndpoint(null)).toBeNull();
		expect(eventsEndpoint({ base: null, events: '/e' })).toBeNull();
	});
});

describe('ingest request parsing', () => {
	const base = { contentType: 'application/json', authorization: null, identity: null };
	it('accepts header and body auth', () => {
		const body = JSON.stringify({ events: [event()] });
		expect(parseIngestRequest({ ...base, rawBody: body, authorization: 'Bearer pk_live_x' })).toMatchObject({
			ok: true,
			key: 'pk_live_x',
			via: 'header',
			identity: null,
		});
		const beacon = JSON.stringify({ key: 'pk_live_x', identity: 'tok', events: [event()] });
		expect(parseIngestRequest({ ...base, contentType: 'text/plain;charset=UTF-8', rawBody: beacon })).toMatchObject({
			ok: true,
			key: 'pk_live_x',
			via: 'body',
			identity: 'tok',
		});
		expect(parseIngestRequest({ ...base, rawBody: beacon, authorization: 'Bearer pk_live_x', identity: 'hdr' })).toMatchObject({
			ok: true,
			identity: 'hdr',
			via: 'header',
		});
	});

	it('refuses malformed requests', () => {
		const ok = JSON.stringify({ key: 'pk_live_x', events: [event()] });
		/** @type {Array<[Partial<Parameters<typeof parseIngestRequest>[0]>, string]>} */
		const cases = [
			[{ contentType: 'application/x-www-form-urlencoded', rawBody: ok }, 'unsupported_media_type'],
			[{ contentType: null, rawBody: ok }, 'unsupported_media_type'],
			[{ rawBody: '{' }, 'bad_request'],
			[{ rawBody: '[]' }, 'bad_request'],
			[{ rawBody: JSON.stringify({ key: 'k', events: [event()], extra: 1 }) }, 'bad_request'],
			[{ rawBody: JSON.stringify({ key: 1, events: [event()] }) }, 'bad_request'],
			[{ rawBody: JSON.stringify({ key: 'k', identity: 3, events: [event()] }) }, 'bad_request'],
			[{ rawBody: JSON.stringify({ key: 'k', identity: '', events: [event()] }) }, 'bad_request'],
			[{ rawBody: JSON.stringify({ key: 'k', identity: 'x'.repeat(9000), events: [event()] }) }, 'bad_request'],
			[{ rawBody: JSON.stringify({ events: [event()] }) }, 'unauthorized'],
			[{ rawBody: JSON.stringify({ key: '', events: [event()] }) }, 'unauthorized'],
			[{ rawBody: ok, authorization: 'Basic abc' }, 'unauthorized'],
			[{ rawBody: ok, authorization: 'Bearer pk_live_other' }, 'bad_request'],
			[{ rawBody: JSON.stringify({ key: 'k', events: [] }) }, 'bad_request'],
			[{ rawBody: JSON.stringify({ key: 'k', events: {} }) }, 'bad_request'],
			[
				{ rawBody: JSON.stringify({ key: 'k', events: Array.from({ length: MAX_EVENTS + 1 }, () => ({})) }) },
				'payload_too_large',
			],
		];
		for (const [input, code] of cases) {
			const result = parseIngestRequest({ ...base, rawBody: '', ...input });
			expect(result).toMatchObject({ ok: false, code });
		}
	});

	it('caps batch size and bytes', () => {
		expect(checkBatch([{}])).toMatchObject({ ok: true });
		expect(checkBatch([{ blob: 'x'.repeat(MAX_BATCH_BYTES) }])).toMatchObject({ ok: false, code: 'payload_too_large' });
		expect(checkBatch(null)).toMatchObject({ ok: false, code: 'bad_request' });
	});

	it('identifies raw events defensively', () => {
		expect(identify(event())).toEqual({ id: 'evt_0123456789abcdefghjkmnpq', idempotencyKey: 'k1' });
		expect(identify('x')).toEqual({ id: null, idempotencyKey: null });
		expect(identify({ id: 'x'.repeat(200), idempotencyKey: 5 })).toEqual({ id: null, idempotencyKey: null });
	});
});

describe('website event checks', () => {
	it('accepts valid events and refuses the rest', () => {
		expect(checkWebsiteEvent(event(), KEY)).toMatchObject({ ok: true });
		// F.16 provenance: the verified key kind is stamped; a producer-supplied value is stripped first
		expect(KEY_KIND_SUPPORTED).toBe(true);
		expect(/** @type {any} */ (checkWebsiteEvent(event(), KEY)).event.context).toEqual({ keyKind: 'pk' });
		const forged = /** @type {any} */ (checkWebsiteEvent(event({ context: { keyKind: 'sk', source: 'server' } }), KEY));
		expect(forged.event.context).toEqual({ keyKind: 'pk', source: 'server' });
		expect(/** @type {any} */ (checkWebsiteEvent(event(), { ...KEY, kind: 'sk' })).event.context.keyKind).toBe('sk');
		expect(withoutProvenance({ context: { keyKind: 'x', locale: 'en' } })).toEqual({ context: { locale: 'en' } });
		expect(withoutProvenance('raw')).toBe('raw');
		expect(checkWebsiteEvent(event({ data: {} }), KEY)).toMatchObject({ ok: false, reason: 'invalid_event' });
		expect(checkWebsiteEvent(event({ type: 'unknown.thing@1' }), KEY)).toMatchObject({ ok: false, reason: 'invalid_event' });
		expect(checkWebsiteEvent('nope', KEY)).toMatchObject({ ok: false, reason: 'invalid_event' });
		expect(checkWebsiteEvent(event({ websiteId: 'web_1123456789abcdefghjkmnpq' }), KEY)).toMatchObject({
			reason: 'website_mismatch',
		});
		expect(checkWebsiteEvent(event({ env: 'test' }), KEY)).toMatchObject({ reason: 'env_mismatch' });
		expect(checkWebsiteEvent(event({ actor: { type: 'staff', id: 's' } }), KEY)).toMatchObject({ reason: 'actor_not_allowed' });
		expect(checkWebsiteEvent(event({ actor: { type: 'staff', id: 's' } }), { ...KEY, kind: 'sk' })).toMatchObject({ ok: true });
		expect(checkWebsiteEvent(event({ actor: { type: 'product' } }), { ...KEY, kind: 'sk' })).toMatchObject({
			reason: 'actor_not_allowed',
		});
		const control = event({
			type: 'key.revoked@1',
			data: { keyIds: ['key_1'], revokedAt: '2026-10-01T10:00:00.000Z' },
		});
		expect(checkWebsiteEvent(control, KEY)).toEqual({ ok: false, reason: 'control_event' });
		expect(checkWebsiteEvent({ ...control, data: {} }, KEY)).toEqual({ ok: false, reason: 'control_event' });
		const errors = /** @type {any} */ (checkWebsiteEvent({ id: 1 }, KEY)).errors;
		expect(errors.length).toBeLessThanOrEqual(5);
	});
});

describe('product event checks', () => {
	const manifest = /** @type {any} */ ({
		product: { slug: 'order-hub' },
		scopes: ['events.publish:order.*'],
		events: { publishes: ['order_hub.synced@1', 'order.placed@1', 'cart.updated@1', 'customer.created@1'] },
	});
	const order = {
		orderId: 'o1',
		currency: 'USD',
		lines: [{ itemId: 'i1', quantity: 1, unitAmount: 100 }],
		amounts: { subtotal: 100, total: 100 },
	};
	it('applies namespace, declaration and publish-scope rules', () => {
		expect(
			checkProductEvent(event({ type: 'order_hub.synced@1', data: { n: 1 }, actor: { type: 'product' } }), manifest),
		).toMatchObject({ ok: true });
		expect(checkProductEvent(event({ type: 'order_hub.other@1', data: {} }), manifest)).toMatchObject({
			reason: 'not_declared',
		});
		expect(checkProductEvent(event({ type: 'other.thing@1', data: {} }), manifest)).toMatchObject({ reason: 'invalid_event' });
		expect(checkProductEvent(event({ type: 'page.viewed@1' }), manifest)).toMatchObject({ reason: 'not_declared' });
		expect(checkProductEvent(event({ type: 'order.placed@1', data: order }), manifest)).toMatchObject({ ok: true });
		// product events carry no key kind; they are marked by source and product
		expect(
			/** @type {any} */ (
				checkProductEvent(event({ type: 'order.placed@1', data: order, context: { keyKind: 'sk' } }), manifest)
			).event.context,
		).toEqual({ source: 'product', product: 'order-hub' });
		expect(
			checkProductEvent(
				event({ type: 'cart.updated@1', data: { cartId: 'c', currency: 'USD', lines: [], subtotalAmount: 0 } }),
				manifest,
			),
		).toMatchObject({
			reason: 'publish_scope_missing',
		});
		expect(
			checkProductEvent(
				event({ type: 'key.revoked@1', data: { keyIds: ['k'], revokedAt: '2026-10-01T10:00:00.000Z' } }),
				manifest,
			),
		).toEqual({ ok: false, reason: 'control_event' });
		expect(checkProductEvent(event({ type: 'loader.vitals@1', data: {} }), manifest)).toEqual({
			ok: false,
			reason: 'control_event',
		});
		expect(
			checkProductEvent(event({ type: 'order_hub.synced@1', data: {}, context: { product: 'other' } }), manifest),
		).toMatchObject({ reason: 'product_mismatch' });
		const weird = { ...manifest, events: { publishes: ['order_hub.synced@1', 'custom.x@1'] }, scopes: undefined };
		expect(checkProductEvent(event({ type: 'custom.x@1', data: {} }), weird)).toMatchObject({ reason: 'outside_namespace' });
		expect(
			checkProductEvent(event({ type: 'order_hub.synced@1', data: {} }), { ...manifest, events: undefined }),
		).toMatchObject({
			reason: 'not_declared',
		});
	});
});

describe('control events and routing', () => {
	it('builds and validates control events', () => {
		const input = {
			websiteId: WEBSITE,
			env: /** @type {const} */ ('live'),
			id: 'evt_0123456789abcdefghjkmnpq',
			occurredAt: '2026-10-01T10:00:00.000Z',
		};
		const platformInput = { env: input.env, id: input.id, occurredAt: input.occurredAt };
		const built = buildControlEvent({
			...platformInput,
			type: 'manifest.accepted@1',
			data: { appId: 'app_1', version: '1.2.0' },
		});
		expect(built).toMatchObject({
			ok: true,
			event: {
				type: 'manifest.accepted@1',
				scope: 'platform',
				actor: { type: 'system' },
				idempotencyKey: input.id,
				context: { source: 'portal' },
			},
		});
		expect(built.ok && built.event).not.toHaveProperty('websiteId');
		// platform-scoped types never carry a website; website-scoped types always do
		expect(buildControlEvent({ ...input, type: 'manifest.accepted@1', data: { appId: 'app_1', version: '1.2.0' } })).toEqual({
			ok: false,
			reason: 'platform_scoped',
		});
		expect(buildControlEvent({ ...platformInput, type: 'key.revoked@1', data: { keyIds: ['key_1'] } })).toEqual({
			ok: false,
			reason: 'website_required',
		});
		expect(
			buildControlEvent({ ...input, type: 'key.revoked@1', data: { keyIds: ['key_1'], revokedAt: input.occurredAt } }),
		).toMatchObject({ ok: true, event: { websiteId: WEBSITE } });
		expect(buildControlEvent({ ...input, type: 'page.viewed@1', data: {} })).toEqual({
			ok: false,
			reason: 'unknown_control_event',
		});
		expect(buildControlEvent({ ...platformInput, type: 'manifest.accepted@1', data: {} })).toMatchObject({
			ok: false,
			reason: 'invalid_event',
		});
	});

	it('routes by consumes globs, versions and subscribe scopes', () => {
		const table = [
			routeOf('app_a', { events: { consumes: ['order.placed@1'] }, scopes: ['events.subscribe:order.*'] }),
			routeOf('app_b', { events: { consumes: ['order.placed@2'] }, scopes: ['events.subscribe:order.*'] }),
			routeOf('app_c', { events: { consumes: ['order.placed@1'] }, scopes: [] }),
			routeOf('app_d', { events: { consumes: ['order.*'] }, scopes: ['events.subscribe:*'] }),
			routeOf('app_e', { events: { consumes: ['entitlement.changed@1'] }, scopes: [] }),
			routeOf('app_f', {}),
			routeOf('app_a', { events: { consumes: ['order.placed@1'] }, scopes: ['events.subscribe:order.placed'] }),
		];
		expect(consumersOf('order.placed@1', table)).toEqual(['app_a', 'app_d']);
		expect(consumersOf('order.placed@2', table)).toEqual(['app_b', 'app_d']);
		expect(consumersOf('order.placed@1', table, { exclude: 'app_a' })).toEqual(['app_d']);
		expect(consumersOf('page.viewed@1', table)).toEqual([]);
		expect(consumersOf('entitlement.changed@1', table)).toEqual(['app_e']);
	});

	it('knows which apps receive deliveries', () => {
		expect(isDeliverableApp({ kind: 'service' })).toBe(true);
		expect(isDeliverableApp({ kind: 'pack' })).toBe(false);
		expect(isDeliverableApp(null)).toBe(false);
	});
});

describe('delivery rules', () => {
	it('spans 24 h of the queue backoff', () => {
		expect(attemptsForWindow()).toBe(34);
		expect(attemptsForWindow({ windowMs: 1 })).toBe(2);
		expect(attemptsForWindow({ windowMs: 0 })).toBe(1);
		expect(attemptsForWindow({ windowMs: Number.MAX_SAFE_INTEGER })).toBe(100);
	});

	it('classifies outcomes', () => {
		expect(classifyStatus(204)).toEqual({ ok: true, status: 204 });
		expect(classifyStatus(500)).toEqual({ ok: false, code: 'http_500', permanent: false, status: 500 });
		expect(classifyStatus(301)).toMatchObject({ ok: false, code: 'http_301' });
		/** @type {Array<[unknown, string, boolean]>} */
		const cases = [
			[netError('ssrf_blocked', 'private_address', 'x'), 'ssrf_blocked', true],
			[netError('bad_url', 'userinfo', 'x'), 'ssrf_blocked', true],
			[netError('timeout', 'deadline', 'x'), 'timeout', false],
			[netError('aborted', 'signal', 'x'), 'aborted', false],
			[netError('too_large', 'body_length', 'x'), 'response_too_large', false],
			[netError('network', 'dns_failed', 'x', 'ENOTFOUND'), 'dns_failed', false],
			[netError('network', 'request_failed', 'x', 'ECONNREFUSED'), 'connection_refused', false],
			[netError('network', 'request_failed', 'x', 'ECONNRESET'), 'connection_reset', false],
			[netError('network', 'request_failed', 'x', 'EPIPE'), 'connection_reset', false],
			[netError('network', 'tls_failed', 'x', 'CERT_HAS_EXPIRED'), 'tls_failed', false],
			[netError('network', 'request_failed', 'x', 'EHOSTUNREACH'), 'network_error', false],
			[new Error('x'), 'network_error', false],
			['string', 'network_error', false],
		];
		for (const [error, code, permanent] of cases) expect(classifyError(error)).toEqual({ ok: false, code, permanent });
	});
});
