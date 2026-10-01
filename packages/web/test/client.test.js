import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createValidator, validateEvent } from '@ss/contracts';
import { createClient } from '../src/client.js';
import { ENDPOINT, KEY, WEBSITE_ID, brokenStorage, counterBytes, fakeWindow, memoryStorage, scriptedFetch } from './helpers.js';

/** @param {Record<string, any>} [overrides] */
const setup = (overrides = {}) => {
	const storage = overrides.storage ?? memoryStorage();
	const fetch = overrides.fetch ?? scriptedFetch({ status: 202 });
	const win = overrides.window ?? fakeWindow();
	const navigator = overrides.navigator ?? {
		language: 'en-US',
		userAgent: 'Vitest/1.0',
		onLine: true,
		sendBeacon: vi.fn(() => true),
	};
	const client = createClient({
		key: KEY,
		endpoint: ENDPOINT,
		websiteId: WEBSITE_ID,
		storage,
		fetch,
		window: win,
		navigator,
		random: () => 0.5,
		randomBytes: counterBytes(),
		defaultConsent: { analytics: true },
		...overrides,
	});
	return { client, storage, fetch, win, navigator };
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'));
});
afterEach(() => {
	vi.useRealTimers();
});

describe('event envelope', () => {
	it('produces envelopes valid against @ss/contracts for standard and custom events', async () => {
		const { client, fetch } = setup();
		expect(client.track('page.viewed', { url: 'https://shop.example.com/products/1', path: '/products/1' }).ok).toBe(true);
		expect(client.track('custom.newsletter_opened@1', { campaign: 'fall' }).ok).toBe(true);
		const cart = {
			cartId: 'c1',
			currency: 'PKR',
			lines: [{ itemId: 'i1', quantity: 2, unitAmount: 1500 }],
			subtotalAmount: 3000,
		};
		expect(client.track('cart.updated@1', cart, { idempotencyKey: 'cart:c1:v3' }).ok).toBe(true);
		await client.flush();
		const events = fetch.calls[0].body.events;
		expect(events).toHaveLength(3);
		for (const event of events) {
			const result = validateEvent(event);
			expect(result.ok, JSON.stringify(result)).toBe(true);
		}
		expect(events[0]).toMatchObject({
			type: 'page.viewed@1',
			websiteId: WEBSITE_ID,
			env: 'test',
			occurredAt: '2026-10-01T10:00:00.000Z',
			actor: { type: 'anonymous' },
			context: {
				source: 'loader',
				locale: 'en-US',
				pageUrl: 'https://shop.example.com/products/1?ref=x',
				referrer: 'https://www.google.com/search',
				userAgent: 'Vitest/1.0',
			},
		});
		expect(events[0].id).toMatch(/^evt_[0-9a-z]{26}$/);
		expect(events[0].idempotencyKey).toBe(events[0].id);
		expect(events[2].idempotencyKey).toBe('cart:c1:v3');
		expect(new Set(events.map((/** @type {any} */ e) => e.id)).size).toBe(3);
		expect(events[0].context.sessionId).toMatch(/^ses_/);
		expect(events[0].actor.id).toBe(events[0].context.anonymousId);
	});

	it('produces valid element events (product events registered with the validator)', async () => {
		const { client, fetch } = setup();
		client.track('notice_bar.shown', {}, { element: 'notice_bar', product: 'notice-bar' });
		await client.flush();
		const [event] = fetch.calls[0].body.events;
		const validator = createValidator({ events: { 'notice_bar.shown@1': { type: 'object' } } });
		expect(validator.validateEvent(event).ok).toBe(true);
		expect(event.context).toMatchObject({ element: 'notice_bar', product: 'notice-bar' });
	});

	it('derives env from the key and omits unusable context fields', async () => {
		const win = fakeWindow({ referrer: '' });
		win.location.href = `https://shop.example.com/${'a'.repeat(2100)}`;
		const { client, fetch } = setup({
			key: 'pk_live_abc',
			window: win,
			navigator: { onLine: true, language: 'not a locale', userAgent: '' },
		});
		client.track('page.viewed', { url: 'https://shop.example.com/', path: '/' });
		await client.flush();
		const [event] = fetch.calls[0].body.events;
		expect(event.env).toBe('live');
		expect(event.context).not.toHaveProperty('pageUrl');
		expect(event.context).not.toHaveProperty('referrer');
		expect(event.context).not.toHaveProperty('locale');
		expect(event.context).not.toHaveProperty('userAgent');
		expect(validateEvent(event).ok).toBe(true);
	});

	it('rejects invalid types, data and options without queueing', () => {
		const { client } = setup();
		expect(client.track('Page.Viewed')).toEqual({ ok: false, reason: 'invalid_type' });
		expect(client.track('noversion')).toEqual({ ok: false, reason: 'invalid_type' });
		expect(client.track(/** @type {any} */ (42))).toEqual({ ok: false, reason: 'invalid_type' });
		expect(client.track('custom.x', /** @type {any} */ ([1]))).toEqual({ ok: false, reason: 'invalid_data' });
		/** @type {any} */
		const circular = {};
		circular.self = circular;
		expect(client.track('custom.x', circular)).toEqual({ ok: false, reason: 'invalid_data' });
		expect(client.track('custom.x', { big: 'x'.repeat(40_000) })).toEqual({ ok: false, reason: 'invalid_data' });
		expect(client.track('custom.x', {}, { idempotencyKey: 'has space' })).toEqual({ ok: false, reason: 'invalid_option' });
		expect(client.track('custom.x', {}, { element: 'Bad-Key' })).toEqual({ ok: false, reason: 'invalid_option' });
		expect(client.track('custom.x', {}, { product: 'X' })).toEqual({ ok: false, reason: 'invalid_option' });
		expect(client.pending()).toBe(0);
	});

	it('validates construction options', () => {
		const base = { endpoint: ENDPOINT, websiteId: WEBSITE_ID, storage: null };
		expect(() => createClient({ ...base, key: 'sk_live_x' })).toThrow(TypeError);
		expect(() => createClient({ ...base, key: KEY, endpoint: '' })).toThrow(/endpoint/);
		expect(() => createClient({ ...base, key: KEY, websiteId: '' })).toThrow(/websiteId/);
	});

	it('notifies onTrack observers and isolates their errors', () => {
		const { client } = setup();
		const seen = vi.fn();
		client.onTrack(() => {
			throw new Error('observer');
		});
		const off = client.onTrack(seen);
		expect(client.track('custom.a').ok).toBe(true);
		off();
		client.track('custom.b');
		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen.mock.calls[0]?.[0].type).toBe('custom.a@1');
	});
});

describe('batching and retries', () => {
	it('sends a partial batch after the flush interval with auth headers', async () => {
		const { client, fetch } = setup();
		client.track('custom.a');
		client.track('custom.b');
		expect(fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(1);
		const { url, init, body } = fetch.calls[0];
		expect(url).toBe(ENDPOINT);
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
		expect(init.headers).not.toHaveProperty('ss-identity');
		expect(body.events.map((/** @type {any} */ e) => e.type)).toEqual(['custom.a@1', 'custom.b@1']);
		expect(client.pending()).toBe(0);
	});

	it('sends full batches immediately and drains the rest', async () => {
		const { client, fetch } = setup({ batchSize: 3 });
		for (let i = 0; i < 7; i += 1) client.track('custom.n', { i });
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch.calls.map((/** @type {any} */ c) => c.body.events.length)).toEqual([3, 3, 1]);
		expect(client.pending()).toBe(0);
	});

	it('retries retryable failures with exponential backoff and keeps idempotency keys', async () => {
		const fetch = scriptedFetch({ status: 503 }, { status: 500 }, { status: 202 });
		const { client } = setup({ fetch });
		client.track('custom.a');
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(749); // backoff 1000 * (0.5 + 0.5/2)
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1500);
		expect(fetch).toHaveBeenCalledTimes(3);
		const keys = fetch.calls.map((/** @type {any} */ c) => c.body.events[0].idempotencyKey);
		expect(new Set(keys).size).toBe(1);
		expect(client.pending()).toBe(0);
	});

	it('honours Retry-After', async () => {
		const fetch = scriptedFetch({ status: 429, headers: { 'retry-after': '5' } }, { status: 202 });
		const { client } = setup({ fetch });
		client.track('custom.a');
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(4999);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('drops permanently rejected batches', async () => {
		const fetch = scriptedFetch({ status: 422 });
		const { client, storage } = setup({ fetch });
		client.track('custom.a');
		await vi.advanceTimersByTimeAsync(1000);
		expect(client.pending()).toBe(0);
		expect(storage.map.has(`ss:${WEBSITE_ID}:q`)).toBe(false);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('drops events after maxAttempts network failures while online', async () => {
		const fetch = scriptedFetch('network');
		const { client } = setup({ fetch, maxAttempts: 3, maxBackoffMs: 10 });
		client.track('custom.a');
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(client.pending()).toBe(0);
	});

	it('does nothing without fetch', async () => {
		const { client } = setup({ fetch: /** @type {any} */ (null) });
		client.track('custom.a');
		await client.flush();
		expect(client.pending()).toBe(1);
	});
});

describe('offline queue', () => {
	it('persists while offline and resumes on the online event', async () => {
		const navigator = { onLine: false, sendBeacon: vi.fn(() => true) };
		const { client, fetch, storage, win } = setup({ navigator });
		client.track('custom.a');
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetch).not.toHaveBeenCalled();
		expect(storage.json(`ss:${WEBSITE_ID}:q`)).toHaveLength(1);
		navigator.onLine = true;
		win.dispatchEvent(new Event('online'));
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(storage.map.has(`ss:${WEBSITE_ID}:q`)).toBe(false);
	});

	it('keeps the queue untouched when a request fails because the device went offline', async () => {
		const navigator = { onLine: true };
		const fetch = vi.fn(async () => {
			navigator.onLine = false;
			throw new TypeError('offline');
		});
		const { client } = setup({ navigator, fetch, maxAttempts: 1 });
		client.track('custom.a');
		await vi.advanceTimersByTimeAsync(1000);
		expect(client.pending()).toBe(1);
	});

	it('reloads the persisted queue on the next page and sends it', async () => {
		const storage = memoryStorage();
		const first = setup({ storage, navigator: { onLine: false } });
		first.client.track('custom.a');
		first.client.track('custom.b');
		first.client.destroy();
		const second = setup({ storage });
		expect(second.client.pending()).toBe(2);
		await vi.advanceTimersByTimeAsync(0);
		expect(second.fetch.calls[0].body.events.map((/** @type {any} */ e) => e.type)).toEqual(['custom.a@1', 'custom.b@1']);
	});

	it('ignores a corrupt persisted queue', () => {
		const storage = memoryStorage();
		storage.setItem(`ss:${WEBSITE_ID}:q`, '{not json');
		expect(setup({ storage }).client.pending()).toBe(0);
		storage.setItem(`ss:${WEBSITE_ID}:q`, JSON.stringify([1, { e: null }]));
		expect(setup({ storage }).client.pending()).toBe(0);
	});

	it('caps the queue by count and bytes, dropping the oldest', () => {
		const { client, storage } = setup({ navigator: { onLine: false }, maxQueue: 5 });
		for (let i = 0; i < 8; i += 1) client.track('custom.n', { i });
		expect(client.pending()).toBe(5);
		expect(storage.json(`ss:${WEBSITE_ID}:q`).map((/** @type {any} */ item) => item.e.data.i)).toEqual([3, 4, 5, 6, 7]);
		const bytes = setup({ navigator: { onLine: false }, maxQueueBytes: 3000 });
		for (let i = 0; i < 20; i += 1) bytes.client.track('custom.n', { i, pad: 'x'.repeat(200) });
		expect(bytes.client.pending()).toBeLessThan(20);
		expect(JSON.stringify(bytes.storage.json(`ss:${WEBSITE_ID}:q`)).length).toBeLessThanOrEqual(3000);
	});

	it('works when storage throws', async () => {
		const { client, fetch } = setup({ storage: brokenStorage() });
		expect(client.track('custom.a').ok).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe('sendBeacon on pagehide', () => {
	it('hands the queue to sendBeacon with body auth', async () => {
		const { client, win, navigator } = setup();
		client.identify({ token: 'idtoken.abc' });
		client.track('custom.a');
		win.dispatchEvent(new Event('pagehide'));
		expect(navigator.sendBeacon).toHaveBeenCalledTimes(1);
		const [url, blob] = navigator.sendBeacon.mock.calls[0];
		expect(url).toBe(ENDPOINT);
		expect(blob.type).toBe('text/plain;charset=utf-8');
		const body = JSON.parse(await blob.text());
		expect(body).toMatchObject({ key: KEY, identity: 'idtoken.abc' });
		expect(body.events).toHaveLength(1);
		expect(client.pending()).toBe(0);
	});

	it('flushes on visibilitychange to hidden and splits payloads at the beacon limit', () => {
		const { client, win, navigator } = setup({ beaconMaxBytes: 2500 });
		for (let i = 0; i < 6; i += 1) client.track('custom.n', { pad: 'x'.repeat(400) });
		client.track('custom.huge', { pad: 'y'.repeat(3000) });
		win.document.dispatchEvent(new Event('visibilitychange'));
		expect(navigator.sendBeacon).not.toHaveBeenCalled();
		win.document.visibilityState = 'hidden';
		win.document.dispatchEvent(new Event('visibilitychange'));
		expect(navigator.sendBeacon.mock.calls.length).toBeGreaterThan(1);
		expect(client.pending()).toBe(1); // the oversized event waits for the next page
	});

	it('keeps events when the beacon is refused or throws', () => {
		const refused = setup({ navigator: { onLine: true, sendBeacon: () => false } });
		refused.client.track('custom.a');
		refused.client.flushBeacon();
		expect(refused.client.pending()).toBe(1);
		const throwing = setup({
			navigator: {
				onLine: true,
				sendBeacon: () => {
					throw new Error('x');
				},
			},
		});
		throwing.client.track('custom.a');
		throwing.client.flushBeacon();
		expect(throwing.client.pending()).toBe(1);
		const none = setup({ navigator: { onLine: true } });
		none.client.track('custom.a');
		none.client.flushBeacon();
		expect(none.client.pending()).toBe(1);
	});
});

describe('consent', () => {
	it('drops events whose category is not granted; necessary is always granted', () => {
		const { client } = setup({ defaultConsent: {} });
		expect(client.track('page.viewed', { url: 'https://a.example.com/', path: '/' })).toEqual({ ok: false, reason: 'consent' });
		expect(client.track('custom.a')).toEqual({ ok: false, reason: 'consent' });
		expect(client.track('custom.a', {}, { category: 'marketing' })).toEqual({ ok: false, reason: 'consent' });
		expect(client.track('order.completed', { orderId: 'o1' }).ok).toBe(true);
		expect(client.consent.get()).toEqual({ necessary: true });
		client.consent.set({ analytics: true, necessary: false, 'Bad Key': true, marketing: /** @type {any} */ ('yes') });
		expect(client.consent.get()).toEqual({ necessary: true, analytics: true });
		expect(client.consent.allows('necessary')).toBe(true);
		expect(client.track('custom.a').ok).toBe(true);
	});

	it('applies custom category rules before the defaults', () => {
		const { client } = setup({ defaultConsent: {}, categories: { 'chat.*': 'functional' } });
		expect(client.track('chat.opened').ok).toBe(false);
		client.consent.set({ functional: true });
		expect(client.track('chat.opened').ok).toBe(true);
		expect(client.track('custom.a').ok).toBe(false);
	});

	it('purges queued events when consent is revoked and notifies subscribers', () => {
		const { client, storage } = setup({ navigator: { onLine: false } });
		client.track('custom.a');
		client.track('order.completed', { orderId: 'o1' });
		const listener = vi.fn();
		client.consent.subscribe(() => {
			throw new Error('isolated');
		});
		const off = client.consent.subscribe(listener);
		client.consent.set({ analytics: false });
		expect(client.pending()).toBe(1);
		expect(listener).toHaveBeenCalledWith({ necessary: true, analytics: false });
		expect(storage.json(`ss:${WEBSITE_ID}:consent`)).toEqual({ analytics: false });
		off();
		client.consent.set({ analytics: true });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(client.consent.set(/** @type {any} */ (null))).toEqual({ necessary: true, analytics: true });
	});

	it('restores stored decisions over defaults', () => {
		const storage = memoryStorage();
		storage.setItem(`ss:${WEBSITE_ID}:consent`, JSON.stringify({ analytics: false, marketing: true }));
		const { client } = setup({ storage });
		expect(client.consent.get()).toEqual({ necessary: true, analytics: false, marketing: true });
	});

	it('persists identifiers only with analytics consent', () => {
		const { client, storage } = setup({ defaultConsent: {} });
		const anon = client.anonymousId();
		client.sessionId();
		expect(storage.map.has(`ss:${WEBSITE_ID}:anon`)).toBe(false);
		expect(storage.map.has(`ss:${WEBSITE_ID}:ses`)).toBe(false);
		client.consent.set({ analytics: true });
		expect(client.anonymousId()).toBe(anon);
		client.sessionId();
		expect(storage.json(`ss:${WEBSITE_ID}:anon`)).toBe(anon);
		expect(storage.json(`ss:${WEBSITE_ID}:ses`).id).toMatch(/^ses_/);
		client.consent.set({ analytics: false });
		expect(storage.map.has(`ss:${WEBSITE_ID}:anon`)).toBe(false);
	});

	it('rotates the session after inactivity', () => {
		const { client } = setup();
		const first = client.sessionId();
		vi.advanceTimersByTime(29 * 60_000);
		expect(client.sessionId()).toBe(first);
		vi.advanceTimersByTime(31 * 60_000);
		expect(client.sessionId()).not.toBe(first);
	});
});

describe('identity', () => {
	it('attaches the federated token and marks the actor as customer', async () => {
		const { client, fetch, storage } = setup();
		expect(client.identify({ token: 'eyJ.token.sig' })).toEqual({ ok: true });
		expect(client.identity()).toBe('eyJ.token.sig');
		expect(storage.json(`ss:${WEBSITE_ID}:idt`)).toBe('eyJ.token.sig');
		client.track('custom.a');
		await client.flush();
		expect(fetch.calls[0].init.headers['ss-identity']).toBe('eyJ.token.sig');
		expect(fetch.calls[0].body.events[0].actor).toEqual({ type: 'customer' });
		expect(validateEvent(fetch.calls[0].body.events[0]).ok).toBe(true);
	});

	it('restores, replaces without persisting, and clears tokens; rejects invalid ones', () => {
		const storage = memoryStorage();
		setup({ storage }).client.identify({ token: 'a.b.c' });
		const { client } = setup({ storage });
		expect(client.identity()).toBe('a.b.c');
		client.identify({ token: 'x.y.z', persist: false });
		expect(storage.map.has(`ss:${WEBSITE_ID}:idt`)).toBe(false);
		expect(client.identity()).toBe('x.y.z');
		expect(client.identify({ token: 'has space' })).toEqual({ ok: false });
		expect(client.identify({ token: '' })).toEqual({ ok: false });
		expect(client.identify({ token: /** @type {any} */ (5) })).toEqual({ ok: false });
		expect(client.identify({ token: null })).toEqual({ ok: true });
		expect(client.identity()).toBeNull();
		expect(client.identify(/** @type {any} */ (undefined))).toEqual({ ok: true });
	});
});

describe('destroy', () => {
	it('stops tracking, timers and listeners', async () => {
		const { client, fetch, win, navigator } = setup();
		client.track('custom.a');
		client.destroy();
		expect(client.track('custom.b')).toEqual({ ok: false, reason: 'destroyed' });
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetch).not.toHaveBeenCalled();
		win.dispatchEvent(new Event('pagehide'));
		expect(navigator.sendBeacon).not.toHaveBeenCalled();
	});

	it('uses browser globals by default', () => {
		const client = createClient({ key: KEY, endpoint: ENDPOINT, websiteId: WEBSITE_ID });
		expect(client.env).toBe('test');
		client.destroy();
	});
});
