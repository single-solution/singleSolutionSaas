/**
 * Widget helpers a product may bundle into its own `widget.js`: one shape for a widget's DOM-free core (state, actions,
 * strings, validation), a tiny immutable store, `Result` helpers, RFC 9457 problem parsing and a JSON API client for
 * the product's `/v1` routes. No DOM access here.
 * @module
 */
import { createId, defaultRandomBytes, isPlainObject } from './util.js';

const WIDGET_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const VERB = /^[a-z][a-z0-9_]*$/;

/**
 * @typedef {object} Problem RFC 9457 problem details as seen by browser code; `code` is always set.
 * @property {string} type
 * @property {string} title
 * @property {number} status HTTP status (0 when no response was received)
 * @property {string} code stable machine code (from the product's problem body, or a client code below)
 * @property {string} [detail]
 * @property {string} [instance]
 * @property {string} [requestId]
 * @property {ReadonlyArray<FieldProblem>} [errors]
 */

/**
 * @typedef {object} FieldProblem a validation finding
 * @property {string} path JSON Pointer of the offending input (`''` = whole input)
 * @property {string} code
 * @property {string} message
 */

/**
 * @template T
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: Problem }} Result
 */

/** Titles of codes produced in the browser (no HTTP exchange) plus the common HTTP fallbacks. */
export const CLIENT_PROBLEMS = Object.freeze({
	network_error: { status: 0, title: 'Network error' },
	timeout: { status: 0, title: 'Request timed out' },
	aborted: { status: 0, title: 'Request aborted' },
	invalid_response: { status: 0, title: 'Invalid response' },
	invalid_request: { status: 0, title: 'Invalid request' },
	destroyed: { status: 0, title: 'Widget destroyed' },
	internal_error: { status: 500, title: 'Internal error' },
	validation_failed: { status: 422, title: 'Validation failed' },
	bad_request: { status: 400, title: 'Bad request' },
	unauthorized: { status: 401, title: 'Authentication required' },
	forbidden: { status: 403, title: 'Forbidden' },
	not_found: { status: 404, title: 'Not found' },
	conflict: { status: 409, title: 'Conflict' },
	rate_limited: { status: 429, title: 'Too many requests' },
	unavailable: { status: 503, title: 'Service unavailable' },
});

/** @type {Record<number, keyof typeof CLIENT_PROBLEMS>} */
const STATUS_CODES = {
	400: 'bad_request',
	401: 'unauthorized',
	403: 'forbidden',
	404: 'not_found',
	409: 'conflict',
	422: 'validation_failed',
	429: 'rate_limited',
	503: 'unavailable',
};

/**
 * @template T
 * @param {T} value
 * @returns {Result<T>}
 */
export const ok = (value) => Object.freeze({ ok: /** @type {const} */ (true), value });

/**
 * @param {Problem} error
 * @returns {Result<never>}
 */
export const err = (error) => Object.freeze({ ok: /** @type {const} */ (false), error });

/**
 * @param {unknown} value
 * @returns {value is Result<unknown>}
 */
export const isResult = (value) =>
	isPlainObject(value) && ((value.ok === true && 'value' in value) || (value.ok === false && isPlainObject(value.error)));

/**
 * Build a problem from a machine code.
 * @param {string} code
 * @param {{ detail?: string, status?: number, title?: string, errors?: ReadonlyArray<FieldProblem>, requestId?: string }} [extra]
 * @returns {Problem}
 */
export const problem = (code, extra = {}) => {
	const known = /** @type {Record<string, { status: number, title: string }>} */ (CLIENT_PROBLEMS)[code];
	/** @type {Problem} */
	const out = {
		type: 'about:blank',
		title: extra.title ?? known?.title ?? code,
		status: extra.status ?? known?.status ?? 0,
		code,
	};
	if (extra.detail !== undefined) out.detail = extra.detail;
	if (extra.errors !== undefined) out.errors = Object.freeze([...extra.errors]);
	if (extra.requestId !== undefined) out.requestId = extra.requestId;
	return Object.freeze(out);
};

/**
 * Normalise an HTTP error body (RFC 9457 `application/problem+json`, or anything else) into a {@link Problem}.
 * `code` comes from the body's `code`, else the last segment of a non-`about:blank` `type`, else the status.
 * @param {unknown} body
 * @param {number} status
 * @param {{ requestId?: string }} [meta]
 * @returns {Problem}
 */
export const parseProblem = (body, status, meta = {}) => {
	const source = isPlainObject(body) ? body : {};
	const str = (/** @type {unknown} */ value, max = 2000) =>
		typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
	const type = str(source.type) ?? 'about:blank';
	const fromType = type === 'about:blank' ? undefined : /([a-z][a-z0-9_]*)\/?$/.exec(type)?.[1];
	const fallback = STATUS_CODES[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
	const code = str(source.code, 64) ?? fromType ?? fallback;
	const effectiveStatus =
		typeof source.status === 'number' && source.status >= 100 && source.status <= 599 ? source.status : status;
	/** @type {Problem} */
	const out = {
		type,
		title:
			str(source.title, 200) ??
			/** @type {Record<string, { title: string }>} */ (CLIENT_PROBLEMS)[code]?.title ??
			`HTTP ${status}`,
		status: effectiveStatus,
		code,
	};
	const detail = str(source.detail);
	if (detail !== undefined) out.detail = detail;
	const instance = str(source.instance);
	if (instance !== undefined) out.instance = instance;
	const requestId = str(source.requestId, 128) ?? meta.requestId;
	if (requestId !== undefined) out.requestId = requestId;
	if (Array.isArray(source.errors)) {
		out.errors = Object.freeze(
			source.errors
				.filter(isPlainObject)
				.slice(0, 100)
				.map((entry) =>
					Object.freeze({
						path: str(entry.path, 1024) ?? '',
						code: str(entry.code, 64) ?? str(entry.keyword, 64) ?? 'invalid',
						message: str(entry.message, 500) ?? '',
					}),
				),
		);
	}
	return Object.freeze(out);
};

/**
 * @template {Record<string, unknown>} S
 * @typedef {object} Store
 * @property {() => Readonly<S>} getState the current immutable snapshot (same object until a change)
 * @property {(patch: Partial<S> | ((state: Readonly<S>) => Partial<S>)) => boolean} setState shallow merge; true when changed
 * @property {(listener: (state: Readonly<S>) => void) => () => void} subscribe
 */

/**
 * A tiny store with shallow-compare updates and frozen snapshots.
 * @template {Record<string, unknown>} S
 * @param {S} initial
 * @returns {Store<S>}
 */
export const createStore = (initial) => {
	let state = Object.freeze({ ...initial });
	/** @type {Set<(state: Readonly<S>) => void>} */
	const listeners = new Set();
	return Object.freeze({
		getState: () => state,
		setState: (patch) => {
			const next = typeof patch === 'function' ? patch(state) : patch;
			if (!isPlainObject(next)) return false;
			const changed = Object.keys(next).some((name) => !Object.is(/** @type {any} */ (state)[name], next[name]));
			if (!changed) return false;
			state = Object.freeze({ ...state, ...next });
			for (const listener of [...listeners]) {
				try {
					listener(state);
				} catch {
					/* one failing subscriber never blocks the others */
				}
			}
			return true;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
};

/**
 * Replace `{{name}}` placeholders with parameter values (text only; unknown placeholders stay empty).
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export const formatString = (template, params = {}) =>
	String(template).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_, name) => {
		const value = Object.hasOwn(params, name) ? params[name] : undefined;
		return value === undefined || value === null ? '' : String(value);
	});

/**
 * Merge a widget's default English texts with the website's overrides (strings only; unknown keys are kept).
 * @param {Record<string, string>} [defaults]
 * @param {Record<string, unknown>} [overrides]
 * @returns {Readonly<Record<string, string>>}
 */
export const resolveStrings = (defaults = {}, overrides = {}) =>
	Object.freeze({
		...defaults,
		.../** @type {Record<string, string>} */ (
			Object.fromEntries(
				Object.entries(isPlainObject(overrides) ? overrides : {}).filter(([, value]) => typeof value === 'string'),
			)
		),
	});

/**
 * @param {unknown} value
 * @returns {any}
 */
const deepFreezeCopy = (value) => {
	if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
	if (isPlainObject(value))
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepFreezeCopy(v)])));
	return value;
};

/**
 * @typedef {object} WidgetIdentity
 * @property {() => string | null} token the signed-in visitor token, if any (sent as `SS-Identity`)
 * @property {() => string | undefined} [anonymousId]
 * @property {() => string | undefined} [sessionId]
 */

/**
 * @typedef {object} HeadlessContext what `create` receives
 * @property {string} key
 * @property {Readonly<Record<string, any>>} config deep-frozen feature values
 * @property {Readonly<Record<string, string>>} strings resolved strings
 * @property {any} client the widget's API client ({@link createApiClient})
 * @property {WidgetIdentity} identity
 * @property {(verb: string, data?: Record<string, unknown>) => boolean} emit passes `<key>.<verb>` to the host
 * @property {Store<Record<string, any>>} store
 * @property {(input: unknown) => ReadonlyArray<FieldProblem>} validate
 */

/**
 * @typedef {object} WidgetDefinition
 * @property {string} key widget key (`apply_box`)
 * @property {(context: HeadlessContext) => { actions?: Record<string, (...args: any[]) => any>, destroy?: () => void } | void} create
 * @property {Record<string, any> | ((input: { config: Readonly<Record<string, any>> }) => Record<string, any>)} [initialState]
 * @property {(input: unknown, context: { config: Readonly<Record<string, any>>, strings: Readonly<Record<string, string>> }) => ReadonlyArray<FieldProblem>} [validate] sync and pure
 * @property {Record<string, string>} [strings] default English texts
 */

/**
 * Declare a widget's DOM-free core.
 * @param {WidgetDefinition} definition
 * @returns {Readonly<WidgetDefinition>}
 */
export const defineWidget = (definition) => {
	if (!isPlainObject(definition)) throw new TypeError('defineWidget: definition must be an object');
	if (typeof definition.key !== 'string' || !WIDGET_KEY.test(definition.key) || definition.key.length > 40)
		throw new TypeError(`defineWidget: invalid widget key ${JSON.stringify(definition.key)}`);
	if (typeof definition.create !== 'function') throw new TypeError('defineWidget: create must be a function');
	return Object.freeze({ ...definition, strings: Object.freeze({ ...definition.strings }) });
};

/**
 * @typedef {object} HeadlessWidget
 * @property {string} key
 * @property {() => Readonly<Record<string, any>>} state immutable snapshot
 * @property {Readonly<Record<string, (...args: any[]) => Promise<Result<any>>>>} actions async, never throw
 * @property {(listener: (state: Readonly<Record<string, any>>) => void) => () => void} subscribe
 * @property {(input: unknown) => ReadonlyArray<FieldProblem>} validate sync and pure
 * @property {Readonly<Record<string, string>>} strings
 * @property {() => void} destroy
 * @property {() => boolean} isDestroyed
 */

/**
 * @typedef {object} MountOptions
 * @property {Record<string, unknown>} [config]
 * @property {Record<string, unknown>} [strings] the website's text overrides
 * @property {any} [client] API client ({@link createApiClient})
 * @property {WidgetIdentity} [identity]
 * @property {(type: string, data: Record<string, unknown>) => void} [emit] receives `<key>.<verb>` events
 */

/**
 * Mount a widget's DOM-free core.
 * @param {Readonly<WidgetDefinition>} definition
 * @param {MountOptions} [options]
 * @returns {HeadlessWidget}
 */
export const mountHeadless = (definition, options = {}) => {
	const { key } = definition;
	const config = deepFreezeCopy(isPlainObject(options.config) ? options.config : {});
	const strings = resolveStrings(definition.strings, options.strings);
	const identity = options.identity ?? { token: () => null };
	const initial = typeof definition.initialState === 'function' ? definition.initialState({ config }) : definition.initialState;
	const store = createStore(isPlainObject(initial) ? initial : {});
	/** @type {Set<() => void>} */
	const unsubscribers = new Set();
	let destroyed = false;

	/** @type {HeadlessWidget['validate']} */
	const validate = (input) => {
		try {
			const found = definition.validate?.(input, { config, strings }) ?? [];
			return Object.freeze(Array.isArray(found) ? found.map((entry) => Object.freeze({ ...entry })) : []);
		} catch {
			return Object.freeze([Object.freeze({ path: '', code: 'internal_error', message: 'Validation failed unexpectedly.' })]);
		}
	};

	/** @type {HeadlessContext['emit']} */
	const emit = (verb, data = {}) => {
		if (destroyed || typeof verb !== 'string' || !VERB.test(verb) || !isPlainObject(data)) return false;
		try {
			options.emit?.(`${key}.${verb}`, data);
		} catch {
			/* a failing host never breaks the widget */
		}
		return true;
	};

	const created =
		definition.create({
			key,
			config,
			strings,
			client: options.client,
			identity,
			emit,
			store: /** @type {Store<Record<string, any>>} */ (/** @type {unknown} */ (store)),
			validate,
		}) ?? {};

	/** @type {Record<string, (...args: any[]) => Promise<Result<any>>>} */
	const actions = {};
	for (const [name, fn] of Object.entries(created.actions ?? {})) {
		if (typeof fn !== 'function') continue;
		actions[name] = async (...args) => {
			if (destroyed) return err(problem('destroyed'));
			try {
				const result = await fn(...args);
				return isResult(result) ? result : ok(result);
			} catch (error) {
				return err(problem('internal_error', { detail: error instanceof Error ? error.message.slice(0, 500) : undefined }));
			}
		};
	}

	return Object.freeze({
		key,
		state: store.getState,
		actions: Object.freeze(actions),
		subscribe: (listener) => {
			if (destroyed) return () => {};
			const off = store.subscribe(listener);
			unsubscribers.add(off);
			return () => {
				off();
				unsubscribers.delete(off);
			};
		},
		validate,
		strings,
		destroy: () => {
			if (destroyed) return;
			destroyed = true;
			for (const off of unsubscribers) off();
			unsubscribers.clear();
			try {
				created.destroy?.();
			} catch {
				/* teardown errors are contained */
			}
		},
		isDestroyed: () => destroyed,
	});
};

/**
 * @typedef {object} RequestOptions
 * @property {unknown} [body] JSON body
 * @property {Record<string, string | number | boolean | undefined>} [query]
 * @property {string} [idempotencyKey] POST only; generated when omitted
 * @property {AbortSignal} [signal]
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {object} ApiClient
 * @property {(method: string, path: string, options?: RequestOptions) => Promise<Result<any>>} request
 * @property {(path: string, options?: RequestOptions) => Promise<Result<any>>} get
 * @property {(path: string, body?: unknown, options?: RequestOptions) => Promise<Result<any>>} post
 * @property {(path: string, body?: unknown, options?: RequestOptions) => Promise<Result<any>>} put
 * @property {(path: string, body?: unknown, options?: RequestOptions) => Promise<Result<any>>} patch
 * @property {(path: string, options?: RequestOptions) => Promise<Result<any>>} delete
 */

/**
 * A JSON API client for a product's `/v1` routes: `Authorization: Bearer <token>` (the browser token for visitor
 * widgets, a ticket for admin widgets), `SS-Identity` when a signed-in visitor token is present, `Idempotency-Key` on
 * every POST, and errors returned as {@link Problem} results (never thrown).
 * @param {{ baseUrl: string, token: string, fetch?: typeof globalThis.fetch, identity?: WidgetIdentity, timeoutMs?: number, randomBytes?: import('./util.js').RandomBytes, headers?: Record<string, string> }} options
 * @returns {ApiClient}
 */
export const createApiClient = ({
	baseUrl,
	token: bearer,
	fetch = globalThis.fetch?.bind(globalThis),
	identity,
	timeoutMs = 15_000,
	randomBytes = defaultRandomBytes,
	headers: extraHeaders = {},
}) => {
	const base = new URL(baseUrl);
	const prefix = base.href.replace(/\/+$/, '');

	/** @type {ApiClient['request']} */
	const request = async (method, path, options = {}) => {
		if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
			return err(problem('invalid_request', { detail: 'path must be an absolute path on the API base' }));
		const url = new URL(prefix + path);
		if (url.origin !== base.origin) return err(problem('invalid_request', { detail: 'path escapes the API base' }));
		for (const [name, value] of Object.entries(options.query ?? {}))
			if (value !== undefined) url.searchParams.set(name, String(value));
		const upper = method.toUpperCase();
		/** @type {Record<string, string>} */
		const headers = {
			...extraHeaders,
			accept: 'application/json, application/problem+json',
			authorization: `Bearer ${bearer}`,
		};
		const token = identity?.token();
		if (token) headers['ss-identity'] = token;
		if (options.body !== undefined) headers['content-type'] = 'application/json';
		if (upper === 'POST') headers['idempotency-key'] = options.idempotencyKey ?? createId('idk', randomBytes);
		Object.assign(headers, options.headers);

		const controller = new AbortController();
		let timedOut = false;
		const timer = globalThis.setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		options.signal?.addEventListener('abort', onAbort);
		try {
			if (typeof fetch !== 'function') return err(problem('network_error', { detail: 'fetch is not available' }));
			const response = await fetch(url.href, {
				method: upper,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal,
				credentials: 'omit',
			});
			const requestId = response.headers?.get?.('x-request-id') ?? response.headers?.get?.('request-id') ?? undefined;
			const text = response.status === 204 ? '' : await response.text();
			let json;
			if (text !== '') {
				try {
					json = JSON.parse(text);
				} catch {
					if (response.ok) return err(problem('invalid_response', { requestId, status: response.status }));
				}
			}
			return response.ok ? ok(json ?? null) : err(parseProblem(json, response.status, { requestId }));
		} catch {
			if (timedOut) return err(problem('timeout'));
			if (options.signal?.aborted) return err(problem('aborted'));
			return err(problem('network_error'));
		} finally {
			globalThis.clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
		}
	};

	return Object.freeze({
		request,
		get: (path, options) => request('GET', path, options),
		delete: (path, options) => request('DELETE', path, options),
		post: (path, body, options) => request('POST', path, { ...options, body }),
		put: (path, body, options) => request('PUT', path, { ...options, body }),
		patch: (path, body, options) => request('PATCH', path, { ...options, body }),
	});
};
