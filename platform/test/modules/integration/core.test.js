import { describe, expect, it } from 'vitest';
import {
	attemptsForWindow,
	classifyError,
	classifyStatus,
	decodeCursor,
	deliveryView,
	dlqExpiry,
	encodeCursor,
	parseLimit,
	DLQ_RETENTION_MS,
} from '../../../src/modules/integration/core/delivery.js';
import {
	MAX_BATCH_BYTES,
	MAX_EVENTS,
	buildControlEvent,
	checkBatch,
	checkProductEvent,
	checkWebsiteEvent,
	consumersOf,
	identify,
	isDeliverableApp,
	parseIngestRequest,
	routeOf,
} from '../../../src/modules/integration/core/events.js';
import {
	checkOutboundUrl,
	eventsEndpoint,
	expandIpv6,
	isPrivateAddress,
} from '../../../src/modules/integration/core/outbound.js';

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

describe('outbound guard', () => {
	it.each([
		['10.1.2.3', true],
		['127.0.0.1', true],
		['169.254.169.254', true],
		['172.16.0.1', true],
		['172.32.0.1', false],
		['192.168.1.1', true],
		['100.64.0.1', true],
		['0.0.0.0', true],
		['224.0.0.1', true],
		['255.255.255.255', true],
		['8.8.8.8', false],
		['93.184.216.34', false],
		['::', true],
		['::1', true],
		['::ffff:127.0.0.1', true],
		['::ffff:7f00:1', true],
		['::ffff:8.8.8.8', false],
		['64:ff9b::a00:1', true],
		['2002:0a00:0001::1', true],
		['2002:0808:0808::1', false],
		['fc00::1', true],
		['fd12:3456::1', true],
		['fe80::1', true],
		['fec0::1', true],
		['ff02::1', true],
		['2001:db8::1', true],
		['2001:0::1', true],
		['100::1', true],
		['2606:4700:4700::1111', false],
		['[::1]', true],
		['fe80::1%eth0', true],
		['not-an-ip', true],
	])('isPrivateAddress(%s) = %s', (ip, expected) => {
		expect(isPrivateAddress(ip)).toBe(expected);
	});

	it('expands IPv6 forms', () => {
		expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
		expect(expandIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(expandIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
		expect(expandIpv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
	});

	it('checks delivery URLs', () => {
		expect(checkOutboundUrl('https://app.example.com/.well-known/ss-events')).toMatchObject({ ok: true, allowPrivate: false });
		expect(checkOutboundUrl('https://8.8.8.8/x')).toMatchObject({ ok: true, allowPrivate: false });
		expect(checkOutboundUrl('https://[2606:4700:4700::1111]/x')).toMatchObject({ ok: true });
		/** @type {Array<[string, string]>} */
		const refused = [
			['http://app.example.com/x', 'scheme'],
			['ftp://app.example.com/x', 'scheme'],
			['https://user:pw@app.example.com/x', 'userinfo'],
			['https://127.0.0.1/x', 'private_address'],
			['https://[::1]/x', 'private_address'],
			['https://169.254.169.254/latest', 'private_address'],
			['https://localhost/x', 'private_name'],
			['https://api.localhost/x', 'private_name'],
			['https://printer.local/x', 'private_name'],
			['https://db.internal/x', 'private_name'],
			['https://intranet/x', 'single_label'],
			['not a url', 'invalid_url'],
			['https://app.example.com./x', 'ok'],
		];
		for (const [url, reason] of refused) {
			const result = checkOutboundUrl(url);
			if (reason === 'ok') expect(result.ok).toBe(true);
			else expect(result).toEqual({ ok: false, code: 'ssrf_blocked', reason });
		}
		expect(checkOutboundUrl('http://127.0.0.1:4000/x', { allowHosts: ['127.0.0.1'] })).toMatchObject({
			ok: true,
			allowPrivate: true,
		});
		expect(checkOutboundUrl('http://[::1]:4000/x', { allowHosts: ['::1'] })).toMatchObject({ ok: true, allowPrivate: true });
		expect(checkOutboundUrl('http://localhost:4000/x', { allowHosts: ['LOCALHOST'] })).toMatchObject({ ok: true });
	});

	it('joins the events endpoint', () => {
		expect(eventsEndpoint({ base: 'https://a.example.com/app/', events: '/.well-known/ss-events' })).toBe(
			'https://a.example.com/app/.well-known/ss-events',
		);
		expect(eventsEndpoint({ base: 'https://a.example.com' })).toBeNull();
		expect(eventsEndpoint({ base: 'https://a.example.com', events: 'x' })).toBeNull();
		expect(eventsEndpoint(null)).toBeNull();
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
		expect(isDeliverableApp({ status: 'active', kind: 'service' })).toBe(true);
		expect(isDeliverableApp({ status: 'deprecated', kind: 'service' })).toBe(true);
		expect(isDeliverableApp({ status: 'retired', kind: 'service' })).toBe(false);
		expect(isDeliverableApp({ status: 'active', kind: 'pack' })).toBe(false);
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
			[{ code: 'ssrf_blocked' }, 'ssrf_blocked', true],
			[{ code: 'timeout' }, 'timeout', false],
			[{ code: 'ENOTFOUND' }, 'dns_failed', false],
			[{ code: 'ECONNREFUSED' }, 'connection_refused', false],
			[{ code: 'ECONNRESET' }, 'connection_reset', false],
			[{ code: 'CERT_HAS_EXPIRED' }, 'tls_failed', false],
			[new Error('x'), 'network_error', false],
			['string', 'network_error', false],
		];
		for (const [error, code, permanent] of cases) expect(classifyError(error)).toEqual({ ok: false, code, permanent });
	});

	it('keeps DLQ payloads at most 7 days from the first dead-letter', () => {
		expect(dlqExpiry(1000, null).getTime()).toBe(1000 + DLQ_RETENTION_MS);
		const first = new Date(5);
		expect(dlqExpiry(99_999, first)).toBe(first);
	});

	it('encodes cursors and limits', () => {
		const cursor = encodeCursor({ createdAt: new Date(1234), _id: 'dlv_1' });
		expect(decodeCursor(cursor)).toEqual({ ok: true, after: { at: new Date(1234), id: 'dlv_1' } });
		expect(decodeCursor(null)).toEqual({ ok: true, after: null });
		expect(decodeCursor('')).toEqual({ ok: true, after: null });
		expect(decodeCursor('***')).toEqual({ ok: false });
		expect(decodeCursor(Buffer.from('[1]').toString('base64url'))).toEqual({ ok: false });
		expect(decodeCursor(Buffer.from('{').toString('base64url'))).toEqual({ ok: false });
		expect(parseLimit(undefined)).toBe(50);
		expect(parseLimit('10')).toBe(10);
		expect(parseLimit(7)).toBe(7);
		expect(parseLimit('0')).toBeNull();
		expect(parseLimit('abc')).toBeNull();
		expect(parseLimit('500')).toBeNull();
	});

	it('views deliveries without payloads', () => {
		const view = deliveryView({ _id: 'dlv_1', eventId: 'e', type: 't', status: 'pending', sealed: 'x', data: {} });
		expect(view).toMatchObject({ deliveryId: 'dlv_1', attempts: 0, replays: 0, lastErrorCode: null });
		expect(JSON.stringify(view)).not.toContain('sealed');
	});
});
