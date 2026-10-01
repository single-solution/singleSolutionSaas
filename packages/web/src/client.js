/**
 * Website events client (PLAN §5.2, §5.3, §5.4; Part E §9): builds standard event envelopes, batches them, retries with
 * backoff, keeps a capped offline queue in storage, flushes with `sendBeacon` when the page is hidden, drops events whose
 * consent category is not granted, and carries a bring-your-own identity token.
 * @module
 */
import { createId, defaultRandomBytes, defaultStorage, globMatch, isPlainObject, safeStorage } from './util.js';

/** Event type pattern (`@ss/contracts` `eventType`). */
const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+@[1-9][0-9]*$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const SLUG = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ELEMENT_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** The consent category that is always granted. */
export const NECESSARY = 'necessary';

/**
 * Default category of each event type (first matching glob wins; `*` spans dots). Business events that make the site
 * work are `necessary`; everything else (page views, element UI events, custom events, vitals) is `analytics`.
 */
export const DEFAULT_EVENT_CATEGORIES = Object.freeze({
	'customer.*': NECESSARY,
	'cart.*': NECESSARY,
	'order.*': NECESSARY,
	'inventory.*': NECESSARY,
	'price.*': NECESSARY,
	'file.*': NECESSARY,
	// catalogue changes (not `item.*`: `item.viewed` stays analytics)
	'item.created': NECESSARY,
	'item.updated': NECESSARY,
	'item.deleted': NECESSARY,
	'*': 'analytics',
});

/** Retryable HTTP statuses (everything else non-2xx is permanent and the batch is dropped). */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * @typedef {object} EventEnvelope
 * @property {string} id
 * @property {string} type
 * @property {string} websiteId
 * @property {'live' | 'test'} env
 * @property {string} occurredAt
 * @property {string} idempotencyKey
 * @property {{ type: string, id?: string }} actor
 * @property {Record<string, unknown>} data
 * @property {Record<string, string>} [context]
 */

/**
 * @typedef {object} TrackOptions
 * @property {string} [idempotencyKey] stable key for events that may be sent twice (e.g. `order:<id>:placed`)
 * @property {string} [category] consent category; defaults from `categories`
 * @property {string} [element] element key recorded in `context.element`
 * @property {string} [product] product slug recorded in `context.product`
 */

/**
 * @typedef {{ ok: true, id: string, idempotencyKey: string } | { ok: false, reason: 'invalid_type' | 'invalid_data' | 'invalid_option' | 'consent' | 'destroyed' }} TrackResult
 */

/**
 * @typedef {object} ConsentApi
 * @property {(categories: Record<string, boolean>) => Readonly<Record<string, boolean>>} set merge decisions (`necessary` cannot be revoked)
 * @property {() => Readonly<Record<string, boolean>>} get current decisions (always includes `necessary: true`)
 * @property {(category: string) => boolean} allows
 * @property {(listener: (consent: Readonly<Record<string, boolean>>) => void) => () => void} subscribe
 */

/**
 * @typedef {object} Client
 * @property {string} key the public website key
 * @property {string} websiteId
 * @property {'live' | 'test'} env
 * @property {(type: string, data?: Record<string, unknown>, options?: TrackOptions) => TrackResult} track
 * @property {(input: { token: string | null, persist?: boolean }) => { ok: boolean }} identify bring-your-own identity (null signs out)
 * @property {() => string | null} identity the current federated token
 * @property {() => string} anonymousId
 * @property {() => string} sessionId
 * @property {ConsentApi} consent
 * @property {() => Promise<void>} flush send queued events now
 * @property {() => number} pending number of queued events
 * @property {() => void} flushBeacon hand the queue to `navigator.sendBeacon` (called on pagehide)
 * @property {(listener: (event: EventEnvelope) => void) => () => void} onTrack observe accepted events (Loader triggers)
 * @property {() => void} destroy
 */

/**
 * @typedef {object} ClientOptions
 * @property {string} key public website key (`pk_live_…` / `pk_test_…`)
 * @property {string} endpoint events ingest URL (configuration, never hardcoded)
 * @property {string} websiteId
 * @property {'live' | 'test'} [env] defaults from the key prefix
 * @property {typeof globalThis.fetch} [fetch]
 * @property {() => number} [now] epoch ms
 * @property {import('./util.js').StorageLike | null} [storage] defaults to localStorage (null disables persistence)
 * @property {import('./util.js').RandomBytes} [randomBytes]
 * @property {() => number} [random] jitter source in [0, 1)
 * @property {any} [window] event target for pagehide/visibilitychange/online (defaults to `globalThis.window`)
 * @property {any} [navigator] provides `sendBeacon`, `onLine`, `language`, `userAgent`
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 * @property {number} [batchSize] events per request (default 20)
 * @property {number} [flushIntervalMs] delay before a partial batch is sent (default 1000)
 * @property {number} [maxQueue] offline queue item cap (oldest dropped first; default 500)
 * @property {number} [maxQueueBytes] offline queue serialized size cap (default 256 000)
 * @property {number} [maxEventBytes] per-event serialized data cap (default 32 000)
 * @property {number} [maxAttempts] attempts per event before it is dropped (default 8)
 * @property {number} [backoffMs] first retry delay (default 1000, doubled per failure)
 * @property {number} [maxBackoffMs] (default 60 000)
 * @property {number} [beaconMaxBytes] per-beacon payload cap (default 60 000)
 * @property {number} [sessionTimeoutMs] inactivity that starts a new session (default 30 min)
 * @property {Record<string, boolean>} [defaultConsent] decisions before the visitor chooses (default: none — opt-in)
 * @property {Record<string, string>} [categories] extra type-glob → category rules, checked before the defaults
 * @property {'loader' | 'server' | 'product' | 'portal' | 'import' | 'webhook'} [source] `context.source` (default loader)
 * @property {string} [locale] `context.locale` (defaults to navigator.language when valid)
 * @property {string} [storagePrefix] (default `ss`)
 */

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, boolean>}
 */
const booleansOnly = (value) =>
	/** @type {Record<string, boolean>} */ (
		Object.fromEntries(
			Object.entries(value).filter(([category, granted]) => SLUG.test(category) && typeof granted === 'boolean'),
		)
	);

/**
 * @param {string} value
 * @returns {string | undefined}
 */
const pageUrl = (value) => {
	if (!value || value.length > 2048) return undefined;
	try {
		return new URL(value).href.length <= 2048 ? value : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Create a website events client.
 * @param {ClientOptions} options
 * @returns {Client}
 */
export const createClient = (options) => {
	const {
		key,
		endpoint,
		websiteId,
		fetch = globalThis.fetch?.bind(globalThis),
		now = Date.now,
		randomBytes = defaultRandomBytes,
		random = Math.random,
		window: win = globalThis.window,
		navigator: nav = globalThis.navigator,
		setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimer = (handle) => globalThis.clearTimeout(/** @type {any} */ (handle)),
		batchSize = 20,
		flushIntervalMs = 1000,
		maxQueue = 500,
		maxQueueBytes = 256_000,
		maxEventBytes = 32_000,
		maxAttempts = 8,
		backoffMs = 1000,
		maxBackoffMs = 60_000,
		beaconMaxBytes = 60_000,
		sessionTimeoutMs = 30 * 60_000,
		defaultConsent = {},
		categories = {},
		source = 'loader',
		storagePrefix = 'ss',
	} = options;
	if (typeof key !== 'string' || !/^pk_(live|test)_/.test(key))
		throw new TypeError('createClient: key must be a pk_live_/pk_test_ key');
	if (typeof endpoint !== 'string' || endpoint === '') throw new TypeError('createClient: endpoint is required');
	if (typeof websiteId !== 'string' || websiteId === '') throw new TypeError('createClient: websiteId is required');
	const env = options.env ?? (key.startsWith('pk_test_') ? 'test' : 'live');
	const store = safeStorage(options.storage === undefined ? defaultStorage() : options.storage);
	const storageKey = (/** @type {string} */ name) => `${storagePrefix}:${websiteId}:${name}`;
	const navLocale = typeof nav?.language === 'string' ? nav.language : undefined;
	const locale = [options.locale, navLocale].find((value) => typeof value === 'string' && LOCALE.test(value));
	const categoryRules = Object.entries({ ...categories, ...DEFAULT_EVENT_CATEGORIES });

	/** @typedef {{ e: EventEnvelope, c: string, n: number }} QueueItem */
	const loaded = store.read(storageKey('q'));
	/** @type {QueueItem[]} */
	let queue = Array.isArray(loaded) ? loaded.filter((item) => isPlainObject(item) && isPlainObject(item.e)) : [];
	const stored = store.read(storageKey('consent'));
	/** @type {Record<string, boolean>} */
	let consentState = {
		...booleansOnly(defaultConsent),
		...(isPlainObject(stored) ? booleansOnly(stored) : {}),
		[NECESSARY]: true,
	};
	const storedToken = store.read(storageKey('idt'));
	/** @type {string | null} */
	let token = typeof storedToken === 'string' ? storedToken : null;
	/** @type {Set<(consent: Readonly<Record<string, boolean>>) => void>} */
	const consentListeners = new Set();
	/** @type {Set<(event: EventEnvelope) => void>} */
	const trackListeners = new Set();
	/** @type {unknown} */
	let timer;
	let timerDue = Infinity;
	let inflight = false;
	let failures = 0;
	let destroyed = false;

	const allows = (/** @type {string} */ category) => consentState[category] === true;
	const persistQueue = () => {
		if (queue.length === 0) store.remove(storageKey('q'));
		else store.write(storageKey('q'), queue);
	};
	const trimQueue = () => {
		let bytes = JSON.stringify(queue).length;
		while (queue.length > maxQueue || (bytes > maxQueueBytes && queue.length > 0)) {
			const dropped = /** @type {QueueItem} */ (queue.shift());
			bytes -= JSON.stringify(dropped).length + 1;
		}
	};

	// Identifiers are persisted only once analytics consent is granted; until then they live for this page only.
	const volatile = { anon: createId('anon', randomBytes), session: { id: createId('ses', randomBytes), at: now() } };
	const persistIds = () => allows('analytics');
	const anonymousId = () => {
		const saved = store.read(storageKey('anon'));
		if (typeof saved === 'string' && OPAQUE_ID.test(saved)) return saved;
		if (persistIds()) store.write(storageKey('anon'), volatile.anon);
		return volatile.anon;
	};
	const sessionId = () => {
		const saved = store.read(storageKey('ses'));
		const at = now();
		const current =
			isPlainObject(saved) && typeof saved.id === 'string' && typeof saved.at === 'number' ? saved : volatile.session;
		const session =
			at - /** @type {number} */ (current.at) > sessionTimeoutMs
				? { id: createId('ses', randomBytes), at }
				: { id: current.id, at };
		volatile.session = /** @type {{ id: string, at: number }} */ (session);
		if (persistIds()) store.write(storageKey('ses'), session);
		return /** @type {string} */ (session.id);
	};

	const categoryOf = (/** @type {string} */ type) => {
		const name = type.slice(0, type.indexOf('@'));
		return categoryRules.find(([glob]) => globMatch(glob, name) || globMatch(glob, type))?.[1] ?? 'analytics';
	};

	const schedule = (/** @type {number} */ delay) => {
		if (destroyed) return;
		const due = now() + delay;
		if (timer !== undefined && timerDue <= due) return;
		if (timer !== undefined) clearTimer(timer);
		timerDue = due;
		timer = setTimer(() => {
			timer = undefined;
			timerDue = Infinity;
			void flush();
		}, delay);
	};

	const headers = () => {
		/** @type {Record<string, string>} */
		const out = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
		if (token) out['ss-identity'] = token;
		return out;
	};

	/**
	 * @param {QueueItem[]} batch
	 * @param {number} [retryAfterMs]
	 */
	const failed = (batch, retryAfterMs = 0) => {
		const ids = new Set(batch.map((item) => item.e.id));
		queue = queue.flatMap((item) =>
			ids.has(item.e.id) ? (item.n + 1 >= maxAttempts ? [] : [{ ...item, n: item.n + 1 }]) : [item],
		);
		persistQueue();
		failures += 1;
		const backoff = Math.min(maxBackoffMs, backoffMs * 2 ** (failures - 1)) * (0.5 + random() / 2);
		schedule(Math.max(backoff, retryAfterMs));
	};

	/** @param {QueueItem[]} batch */
	const settled = (batch) => {
		const ids = new Set(batch.map((item) => item.e.id));
		queue = queue.filter((item) => !ids.has(item.e.id));
		persistQueue();
	};

	/** @returns {Promise<void>} */
	const flush = async () => {
		if (destroyed || inflight || queue.length === 0 || typeof fetch !== 'function') return;
		if (nav && nav.onLine === false) return; // the `online` listener resumes
		inflight = true;
		const batch = queue.slice(0, batchSize);
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ events: batch.map((item) => item.e) }),
				credentials: 'omit',
				keepalive: true,
			});
			if (response.ok) {
				failures = 0;
				settled(batch);
			} else if (RETRYABLE.has(response.status)) {
				const retryAfter = Number(response.headers?.get?.('retry-after'));
				failed(batch, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, maxBackoffMs) : 0);
				return;
			} else settled(batch); // permanent rejection: never retry a poison batch
		} catch {
			if (nav && nav.onLine === false) return; // offline: keep the queue untouched
			failed(batch);
			return;
		} finally {
			inflight = false;
		}
		if (queue.length > 0) schedule(0);
	};

	const flushBeacon = () => {
		if (queue.length === 0 || typeof nav?.sendBeacon !== 'function') return;
		const auth = token ? { key, identity: token } : { key };
		const envelope = JSON.stringify({ ...auth, events: [] }).length;
		/** @type {QueueItem[][]} */
		const chunks = [[]];
		let size = envelope;
		for (const item of queue) {
			const bytes = JSON.stringify(item.e).length + 1;
			if (bytes + envelope > beaconMaxBytes) continue; // too large for a beacon; stays queued for the next page
			if (size + bytes > beaconMaxBytes) {
				chunks.push([]);
				size = envelope;
			}
			/** @type {QueueItem[]} */ (chunks.at(-1)).push(item);
			size += bytes;
		}
		for (const chunk of chunks) {
			if (chunk.length === 0) continue;
			const body = JSON.stringify({ ...auth, events: chunk.map((item) => item.e) });
			let sent = false;
			try {
				sent = nav.sendBeacon(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' })) === true;
			} catch {
				sent = false;
			}
			if (sent) settled(chunk);
		}
		persistQueue();
	};

	/** @type {Client['track']} */
	const track = (rawType, data = {}, trackOptions = {}) => {
		if (destroyed) return { ok: false, reason: 'destroyed' };
		const type = typeof rawType === 'string' && !rawType.includes('@') ? `${rawType}@1` : rawType;
		if (typeof type !== 'string' || type.length > 120 || !EVENT_TYPE.test(type)) return { ok: false, reason: 'invalid_type' };
		if (!isPlainObject(data)) return { ok: false, reason: 'invalid_data' };
		let serialized;
		try {
			serialized = JSON.stringify(data);
		} catch {
			return { ok: false, reason: 'invalid_data' };
		}
		if (serialized.length > maxEventBytes) return { ok: false, reason: 'invalid_data' };
		const { idempotencyKey: givenKey, element, product } = trackOptions;
		if (givenKey !== undefined && (typeof givenKey !== 'string' || !IDEMPOTENCY_KEY.test(givenKey)))
			return { ok: false, reason: 'invalid_option' };
		if (element !== undefined && !ELEMENT_KEY.test(element)) return { ok: false, reason: 'invalid_option' };
		if (product !== undefined && !SLUG.test(product)) return { ok: false, reason: 'invalid_option' };
		const category = trackOptions.category ?? categoryOf(type);
		if (!allows(category)) return { ok: false, reason: 'consent' };

		const id = createId('evt', randomBytes);
		const idempotencyKey = givenKey ?? id;
		const loc = win?.location;
		const doc = win?.document;
		/** @type {Record<string, string | undefined>} */
		const context = {
			source,
			product,
			element,
			locale,
			sessionId: sessionId(),
			anonymousId: anonymousId(),
			pageUrl: typeof loc?.href === 'string' ? pageUrl(loc.href) : undefined,
			referrer: typeof doc?.referrer === 'string' ? pageUrl(doc.referrer) : undefined,
			userAgent: typeof nav?.userAgent === 'string' && nav.userAgent !== '' ? nav.userAgent.slice(0, 512) : undefined,
		};
		/** @type {EventEnvelope} */
		const event = {
			id,
			type,
			websiteId,
			env,
			occurredAt: new Date(now()).toISOString(),
			idempotencyKey,
			actor: token ? { type: 'customer' } : { type: 'anonymous', id: context.anonymousId },
			data: JSON.parse(serialized),
			context: /** @type {Record<string, string>} */ (
				Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined))
			),
		};
		queue.push({ e: event, c: category, n: 0 });
		trimQueue();
		persistQueue();
		for (const listener of trackListeners) {
			try {
				listener(event);
			} catch {
				/* observers never break tracking */
			}
		}
		schedule(queue.length >= batchSize ? 0 : flushIntervalMs);
		return { ok: true, id, idempotencyKey };
	};

	/** @type {ConsentApi} */
	const consent = {
		get: () => Object.freeze({ ...consentState }),
		allows,
		set: (decisions) => {
			if (!isPlainObject(decisions)) return consent.get();
			consentState = { ...consentState, ...booleansOnly(decisions), [NECESSARY]: true };
			store.write(
				storageKey('consent'),
				Object.fromEntries(Object.entries(consentState).filter(([name]) => name !== NECESSARY)),
			);
			const before = queue.length;
			queue = queue.filter((item) => allows(item.c));
			if (queue.length !== before) persistQueue();
			if (!allows('analytics')) {
				store.remove(storageKey('anon'));
				store.remove(storageKey('ses'));
			}
			const snapshot = consent.get();
			for (const listener of consentListeners) {
				try {
					listener(snapshot);
				} catch {
					/* isolated */
				}
			}
			return snapshot;
		},
		subscribe: (listener) => {
			consentListeners.add(listener);
			return () => consentListeners.delete(listener);
		},
	};

	/** @type {Client['identify']} */
	const identify = ({ token: next, persist = true } = { token: null }) => {
		if (next !== null && (typeof next !== 'string' || next === '' || next.length > 8192 || /[\s]/.test(next)))
			return { ok: false };
		token = next;
		if (next !== null && persist) store.write(storageKey('idt'), next);
		else store.remove(storageKey('idt'));
		return { ok: true };
	};

	const onHidden = () => {
		if (win?.document?.visibilityState === 'hidden') flushBeacon();
	};
	const onOnline = () => void flush();
	win?.addEventListener?.('pagehide', flushBeacon);
	win?.document?.addEventListener?.('visibilitychange', onHidden);
	win?.addEventListener?.('online', onOnline);
	if (queue.length > 0) schedule(0);

	return Object.freeze({
		key,
		websiteId,
		env,
		track,
		identify,
		identity: () => token,
		anonymousId,
		sessionId,
		consent: Object.freeze(consent),
		flush,
		flushBeacon,
		pending: () => queue.length,
		onTrack: (listener) => {
			trackListeners.add(listener);
			return () => trackListeners.delete(listener);
		},
		destroy: () => {
			destroyed = true;
			if (timer !== undefined) clearTimer(timer);
			timer = undefined;
			win?.removeEventListener?.('pagehide', flushBeacon);
			win?.document?.removeEventListener?.('visibilitychange', onHidden);
			win?.removeEventListener?.('online', onOnline);
			consentListeners.clear();
			trackListeners.clear();
		},
	});
};
