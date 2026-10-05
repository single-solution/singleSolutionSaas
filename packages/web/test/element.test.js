import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createElementApi,
	createStore,
	defineElement,
	err,
	formatString,
	isResult,
	mountHeadless,
	ok,
	parseProblem,
	problem,
	resolveStrings,
} from '../src/element.js';

/** A coupon apply box, written the way a product would write its headless core. */
const applyBox = defineElement({
	key: 'apply_box',
	strings: { label: 'Coupon code', applied: 'Saved {{amount}}', invalid: 'Enter a code' },
	initialState: ({ config }) => ({ status: 'idle', code: '', maxLength: config.maxLength ?? 20 }),
	validate: (input, { config, strings }) => {
		const code = typeof input === 'string' ? input.trim() : '';
		if (code === '') return [{ path: '', code: 'required', message: strings.invalid ?? '' }];
		return code.length > (config.maxLength ?? 20) ? [{ path: '', code: 'too_long', message: 'Too long' }] : [];
	},
	create: ({ store, client, emit, validate }) => ({
		actions: {
			/** @param {string} code */
			setCode: (code) => {
				store.setState({ code });
			},
			apply: async () => {
				const problems = validate(store.getState().code);
				if (problems.length > 0) return err(problem('validation_failed', { errors: problems }));
				store.setState({ status: 'loading' });
				const result = await client.post('/v1/coupons:apply', { code: store.getState().code });
				store.setState({ status: result.ok ? 'ready' : 'error' });
				if (result.ok) emit('applied', { code: store.getState().code });
				return result;
			},
			boom: () => {
				throw new Error('kaput');
			},
			boomValue: () => {
				throw 'not an error';
			},
		},
	}),
});

/** @param {any} [value] */
const fakeClient = (value = { ok: true, value: { discount: 500 } }) => ({ post: vi.fn(async () => value) });

describe('Result helpers', () => {
	it('builds frozen results and recognises them', () => {
		const good = ok(5);
		const bad = err(problem('not_found'));
		expect(good).toEqual({ ok: true, value: 5 });
		expect(Object.isFrozen(good)).toBe(true);
		expect(bad.ok).toBe(false);
		expect(isResult(good)).toBe(true);
		expect(isResult(bad)).toBe(true);
		expect(isResult({ ok: true })).toBe(false);
		expect(isResult({ ok: false, error: 'x' })).toBe(false);
		expect(isResult(null)).toBe(false);
	});

	it('builds problems from codes', () => {
		expect(problem('network_error')).toEqual({ type: 'about:blank', title: 'Network error', status: 0, code: 'network_error' });
		expect(
			problem('custom_code', { status: 418, title: 'Teapot', detail: 'short and stout', requestId: 'r1', errors: [] }),
		).toEqual({
			type: 'about:blank',
			title: 'Teapot',
			status: 418,
			code: 'custom_code',
			detail: 'short and stout',
			requestId: 'r1',
			errors: [],
		});
		expect(problem('unknown').title).toBe('unknown');
	});
});

describe('parseProblem (RFC 9457)', () => {
	it('parses a full problem document', () => {
		const parsed = parseProblem(
			{
				type: 'https://errors.example.dev/quota_exhausted',
				title: 'Quota exhausted',
				status: 429,
				detail: 'Monthly quota used',
				instance: '/v1/x',
				requestId: 'req_1',
				errors: [{ path: '/code', keyword: 'maxLength', message: 'too long' }, { path: '/a', code: 'bad' }, 'junk'],
			},
			429,
		);
		expect(parsed).toEqual({
			type: 'https://errors.example.dev/quota_exhausted',
			title: 'Quota exhausted',
			status: 429,
			code: 'quota_exhausted',
			detail: 'Monthly quota used',
			instance: '/v1/x',
			requestId: 'req_1',
			errors: [
				{ path: '/code', code: 'maxLength', message: 'too long' },
				{ path: '/a', code: 'bad', message: '' },
			],
		});
	});

	it('prefers an explicit code and falls back to the status', () => {
		expect(parseProblem({ type: 'https://e.dev/x/', code: 'element_disabled' }, 403).code).toBe('element_disabled');
		expect(parseProblem({ type: 'https://e.dev/conflict/' }, 409).code).toBe('conflict');
		expect(parseProblem(null, 404)).toMatchObject({ type: 'about:blank', code: 'not_found', title: 'Not found', status: 404 });
		expect(parseProblem('<html>', 502)).toMatchObject({ code: 'internal_error', status: 502 });
		expect(parseProblem({}, 418)).toMatchObject({ code: 'bad_request', title: 'Bad request', status: 418 });
		expect(parseProblem({ status: 9999 }, 500, { requestId: 'hdr' })).toMatchObject({ status: 500, requestId: 'hdr' });
		expect(parseProblem({ title: 'x'.repeat(500) }, 400).title).toHaveLength(200);
	});
});

describe('createStore', () => {
	it('shallow-merges, freezes snapshots and skips no-op updates', () => {
		const store = createStore({ a: 1, b: { c: 2 } });
		const listener = vi.fn();
		const off = store.subscribe(listener);
		const first = store.getState();
		expect(Object.isFrozen(first)).toBe(true);
		expect(store.setState({ a: 1 })).toBe(false);
		expect(store.getState()).toBe(first);
		expect(store.setState({ b: first.b })).toBe(false);
		expect(store.setState((state) => ({ a: state.a + 1 }))).toBe(true);
		expect(store.getState()).toEqual({ a: 2, b: { c: 2 } });
		expect(first.a).toBe(1);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(store.setState(/** @type {any} */ (null))).toBe(false);
		off();
		store.setState({ a: 3 });
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('isolates failing listeners', () => {
		const store = createStore({ n: 0 });
		const good = vi.fn();
		store.subscribe(() => {
			throw new Error('bad listener');
		});
		store.subscribe(good);
		store.setState({ n: 1 });
		expect(good).toHaveBeenCalledWith({ n: 1 });
	});
});

describe('strings', () => {
	it('formats placeholders as text', () => {
		expect(formatString('Saved {{amount}} on {{ item.name }}', { amount: 'Rs 500', 'item.name': '<b>x</b>' })).toBe(
			'Saved Rs 500 on <b>x</b>',
		);
		expect(formatString('Hi {{name}}{{missing}}', { name: null })).toBe('Hi ');
		expect(formatString('{{toString}}')).toBe('');
	});

	it('merges only string overrides', () => {
		expect(resolveStrings({ a: 'A', b: 'B' }, { b: 'b2', c: 5, d: 'D' })).toEqual({ a: 'A', b: 'b2', d: 'D' });
		expect(resolveStrings(undefined, /** @type {any} */ ('nope'))).toEqual({});
	});
});

describe('defineElement', () => {
	it('validates the definition', () => {
		expect(() => defineElement(/** @type {any} */ (null))).toThrow(TypeError);
		expect(() => defineElement(/** @type {any} */ ({ key: 'Bad', create: () => ({}) }))).toThrow(/invalid element key/);
		expect(() => defineElement(/** @type {any} */ ({ key: 'x'.repeat(41), create: () => ({}) }))).toThrow(
			/invalid element key/,
		);
		expect(() => defineElement(/** @type {any} */ ({ key: 'ok_key' }))).toThrow(/create/);
		expect(Object.isFrozen(defineElement({ key: 'ok_key', create: () => {} }))).toBe(true);
	});
});

describe('mountHeadless', () => {
	it('exposes the Part E §4 shape with resolved strings and frozen config', () => {
		const element = mountHeadless(applyBox, {
			config: { maxLength: 8, nested: { list: [1] } },
			strings: { label: 'Voucher' },
			client: fakeClient(),
		});
		expect(Object.keys(element).sort()).toEqual([
			'actions',
			'destroy',
			'isDestroyed',
			'key',
			'state',
			'strings',
			'subscribe',
			'validate',
		]);
		expect(element.key).toBe('apply_box');
		expect(element.state()).toEqual({ status: 'idle', code: '', maxLength: 8 });
		expect(element.strings.label).toBe('Voucher');
		expect(element.strings.applied).toBe('Saved {{amount}}');
		expect(Object.isFrozen(element.state())).toBe(true);
		expect(Object.isFrozen(element.actions)).toBe(true);
	});

	it('runs actions as async Results, emits namespaced events and notifies subscribers', async () => {
		const emit = vi.fn();
		const client = fakeClient();
		const element = mountHeadless(applyBox, { client, emit });
		const states = /** @type {string[]} */ ([]);
		element.subscribe((state) => states.push(state.status));
		const snapshot = element.state();
		await element.actions.setCode?.('FALL10');
		expect(element.state()).not.toBe(snapshot);
		expect(snapshot.code).toBe('');
		const result = await element.actions.apply?.();
		expect(result).toEqual({ ok: true, value: { discount: 500 } });
		expect(states).toEqual(['idle', 'loading', 'ready']);
		expect(client.post).toHaveBeenCalledWith('/v1/coupons:apply', { code: 'FALL10' });
		expect(emit).toHaveBeenCalledWith('apply_box.applied', { code: 'FALL10' });
	});

	it('wraps plain return values and thrown errors', async () => {
		const element = mountHeadless(applyBox, { client: fakeClient() });
		expect(await element.actions.setCode?.('x')).toEqual({ ok: true, value: undefined });
		const thrown = await element.actions.boom?.();
		expect(thrown?.ok).toBe(false);
		expect(thrown?.ok === false && thrown.error).toMatchObject({ code: 'internal_error', detail: 'kaput' });
		const nonError = await element.actions.boomValue?.();
		expect(nonError?.ok === false && nonError.error.detail).toBeUndefined();
	});

	it('validates synchronously and purely, containing validator crashes', async () => {
		const element = mountHeadless(applyBox, { config: { maxLength: 3 } });
		expect(element.validate('  ')).toEqual([{ path: '', code: 'required', message: 'Enter a code' }]);
		expect(element.validate('toolong')).toEqual([{ path: '', code: 'too_long', message: 'Too long' }]);
		expect(element.validate('ab')).toEqual([]);
		const failing = await element.actions.apply?.();
		expect(failing?.ok === false && failing.error.code).toBe('validation_failed');
		const crashing = mountHeadless(
			defineElement({
				key: 'crash',
				create: () => ({}),
				validate: () => {
					throw new Error('x');
				},
			}),
		);
		expect(crashing.validate('a')[0]?.code).toBe('internal_error');
		const odd = mountHeadless(defineElement({ key: 'odd', create: () => ({}), validate: () => /** @type {any} */ ('no') }));
		expect(odd.validate('a')).toEqual([]);
		expect(mountHeadless(defineElement({ key: 'none', create: () => ({}) })).validate('a')).toEqual([]);
	});

	it('rejects invalid emits and survives a failing host', () => {
		/** @type {any} */
		let ctx;
		const element = mountHeadless(
			defineElement({
				key: 'emitter',
				initialState: { n: 0 },
				create: (context) => {
					ctx = context;
				},
			}),
			{
				emit: () => {
					throw new Error('host down');
				},
			},
		);
		expect(ctx.emit('Bad Verb')).toBe(false);
		expect(ctx.emit('ok', /** @type {any} */ ([]))).toBe(false);
		expect(ctx.emit('ok')).toBe(true);
		expect(ctx.identity.token()).toBeNull();
		expect(element.state()).toEqual({ n: 0 });
		expect(element.actions).toEqual({});
	});

	it('destroys once: actions fail, listeners detach, teardown errors are contained', async () => {
		const teardown = vi.fn(() => {
			throw new Error('teardown');
		});
		/** @type {any} */
		let ctx;
		const element = mountHeadless(
			defineElement({
				key: 'lifecycle',
				initialState: { n: 0 },
				create: (context) => {
					ctx = context;
					return {
						actions: { inc: () => context.store.setState((s) => ({ n: s.n + 1 })), notFn: /** @type {any} */ (5) },
						destroy: teardown,
					};
				},
			}),
		);
		expect(Object.keys(element.actions)).toEqual(['inc']);
		const listener = vi.fn();
		const off = element.subscribe(listener);
		await element.actions.inc?.();
		expect(listener).toHaveBeenCalledTimes(1);
		off();
		element.subscribe(listener);
		element.destroy();
		element.destroy();
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(element.isDestroyed()).toBe(true);
		const after = await element.actions.inc?.();
		expect(after?.ok === false && after.error.code).toBe('destroyed');
		ctx.store.setState({ n: 99 });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(ctx.emit('late')).toBe(false);
		expect(element.subscribe(listener)()).toBeUndefined();
	});
});

describe('createElementApi', () => {
	afterEach(() => vi.useRealTimers());

	/** @param {{ status?: number, body?: string, headers?: Record<string, string> }} [response] */
	const respond = ({ status = 200, body = '{"ok":1}', headers = { 'content-type': 'application/json' } } = {}) =>
		/** @type {any} */ (
			vi.fn(async () => ({
				ok: status >= 200 && status < 300,
				status,
				headers: new Headers(headers),
				text: async () => body,
			}))
		);

	it('sends JSON with auth, identity and an Idempotency-Key on POST', async () => {
		const fetch = respond({ status: 201, body: '{"id":"c1"}' });
		const api = createElementApi({
			baseUrl: 'https://api.coupons.example.test/base/',
			key: 'pk_test_x',
			fetch,
			identity: { token: () => 'fed.token' },
			randomBytes: (n) => new Uint8Array(n),
		});
		const result = await api.post('/v1/apply', { code: 'A' }, { query: { lang: 'en', skip: undefined } });
		expect(result).toEqual({ ok: true, value: { id: 'c1' } });
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe('https://api.coupons.example.test/base/v1/apply?lang=en');
		expect(init.method).toBe('POST');
		expect(init.body).toBe('{"code":"A"}');
		expect(init.headers).toMatchObject({
			authorization: 'Bearer pk_test_x',
			'ss-identity': 'fed.token',
			'content-type': 'application/json',
			'idempotency-key': `idk_${'0'.repeat(26)}`,
		});
		await api.post('/v1/apply', undefined, { idempotencyKey: 'mine', headers: { 'x-extra': '1' } });
		expect(fetch.mock.calls[1]?.[1].headers).toMatchObject({ 'idempotency-key': 'mine', 'x-extra': '1' });
		expect(fetch.mock.calls[1]?.[1].headers).not.toHaveProperty('content-type');
	});

	it('does not add Idempotency-Key to other methods', async () => {
		const fetch = respond({ status: 204, body: '' });
		const api = createElementApi({ baseUrl: 'https://api.example.test', key: 'pk_test_x', fetch });
		expect(await api.get('/v1/x')).toEqual({ ok: true, value: null });
		for (const call of [api.put('/v1/x', { a: 1 }), api.patch('/v1/x', { a: 1 }), api.delete('/v1/x')])
			expect((await call).ok).toBe(true);
		for (const [, init] of fetch.mock.calls) expect(init.headers).not.toHaveProperty('idempotency-key');
		expect(fetch.mock.calls.map((/** @type {any[]} */ [, init]) => init.method)).toEqual(['GET', 'PUT', 'PATCH', 'DELETE']);
	});

	it('returns typed problems for HTTP errors', async () => {
		const fetch = respond({
			status: 403,
			body: JSON.stringify({ type: 'https://errors.example.dev/element_disabled', title: 'Element not enabled', status: 403 }),
			headers: { 'content-type': 'application/problem+json', 'x-request-id': 'req_9' },
		});
		const api = createElementApi({ baseUrl: 'https://api.example.test', key: 'pk_test_x', fetch });
		const result = await api.get('/v1/x');
		expect(result).toEqual({
			ok: false,
			error: {
				type: 'https://errors.example.dev/element_disabled',
				title: 'Element not enabled',
				status: 403,
				code: 'element_disabled',
				requestId: 'req_9',
			},
		});
		const html = await createElementApi({
			baseUrl: 'https://api.example.test',
			key: 'k',
			fetch: respond({ status: 502, body: '<html>' }),
		}).get('/x');
		expect(html.ok === false && html.error.code).toBe('internal_error');
		const badJson = await createElementApi({
			baseUrl: 'https://api.example.test',
			key: 'k',
			fetch: respond({ body: '{oops' }),
		}).get('/x');
		expect(badJson.ok === false && badJson.error.code).toBe('invalid_response');
	});

	it('refuses paths that escape the base', async () => {
		const fetch = respond();
		const api = createElementApi({ baseUrl: 'https://api.example.test/v1', key: 'k', fetch });
		for (const path of ['//evil.test/x', 'relative', 'https://evil.test/', '/a\\b', /** @type {any} */ (5)]) {
			const result = await api.get(path);
			expect(result.ok === false && result.error.code).toBe('invalid_request');
		}
		expect(fetch).not.toHaveBeenCalled();
		expect((await api.get('/@evil.test')).ok).toBe(true);
		expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/@evil.test');
	});

	it('maps network failures, timeouts and aborts', async () => {
		const failing = createElementApi({
			baseUrl: 'https://api.example.test',
			key: 'k',
			fetch: async () => {
				throw new TypeError('Failed to fetch');
			},
		});
		expect(await failing.get('/x')).toMatchObject({ ok: false, error: { code: 'network_error', status: 0 } });

		vi.useFakeTimers();
		/** @param {string} _url @param {any} init */
		const hanging = (_url, init) =>
			new Promise((_, reject) =>
				init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
			);
		const slow = createElementApi({
			baseUrl: 'https://api.example.test',
			key: 'k',
			fetch: /** @type {any} */ (hanging),
			timeoutMs: 100,
		});
		const pendingTimeout = slow.get('/x');
		await vi.advanceTimersByTimeAsync(100);
		expect(await pendingTimeout).toMatchObject({ ok: false, error: { code: 'timeout' } });

		const controller = new AbortController();
		const pendingAbort = slow.get('/x', { signal: controller.signal });
		controller.abort();
		expect(await pendingAbort).toMatchObject({ ok: false, error: { code: 'aborted' } });

		const noFetch = createElementApi({ baseUrl: 'https://api.example.test', key: 'k', fetch: /** @type {any} */ (null) });
		expect(await noFetch.get('/x')).toMatchObject({ ok: false, error: { code: 'network_error' } });
	});
});
