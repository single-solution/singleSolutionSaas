/**
 * Loader runtime (PLAN §4.1, §4.5, §5.4; Part E §4, §8, §9): what a compiled per-website bundle calls. It evaluates
 * placements, arms triggers, enforces frequency caps, lazy-mounts elements (headless core + optional default
 * renderer), isolates element failures, forwards element events, samples Core Web Vitals and exposes `window.SS`.
 * @module
 */
import { createElementApi, mountHeadless } from './element.js';
import { createFrequency } from './frequency.js';
import { DEFAULT_BREAKPOINTS, deviceOf, matchPlacement } from './placement.js';
import { h, prefersReducedMotion, reserveSpace, tokens } from './renderer.js';
import { attempt, defaultStorage, isPlainObject } from './util.js';

const ELEMENT_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const INSTANCES = Symbol.for('ss.loader.instances');
const OWNER = Symbol.for('ss.loader.owner');
const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart'];
const SS_API = ['version', 'track', 'identify', 'consent', 'elements', 'on', 'refresh'];

/**
 * @typedef {object} RendererModule
 * @property {(props: RenderProps) => Node} render pure function of the props
 * @property {(node: Node, props: RenderProps) => Node | void} [update] optional in-place update (keeps focus)
 */

/**
 * @typedef {object} RenderProps
 * @property {Readonly<Record<string, any>>} state
 * @property {Readonly<Record<string, (...args: any[]) => Promise<any>>>} actions
 * @property {Readonly<Record<string, string>>} strings
 * @property {Record<string, unknown>} theme
 * @property {Record<string, unknown>} slots
 * @property {import('./element.js').HeadlessElement} element
 * @property {typeof h} h
 * @property {string | undefined} nonce CSP nonce for any `<style>` the renderer adds
 * @property {boolean} reducedMotion
 */

/**
 * @typedef {object} BundleElement
 * @property {string} key
 * @property {Record<string, any>} [placement] `@ss/contracts` placement v1
 * @property {Record<string, unknown>} [config]
 * @property {Record<string, unknown>} [strings]
 * @property {import('./element.js').ElementDefinition | (() => Promise<any>)} headless definition or lazy import
 * @property {RendererModule | (() => Promise<any>)} [renderer] default renderer or lazy import (Mode A)
 * @property {{ baseUrl: string }} [api] the element's Mode-C API
 * @property {Record<string, unknown>} [theme] per-element token overrides
 * @property {Record<string, unknown>} [slots]
 * @property {{ minHeight?: number | string, minWidth?: number | string, aspectRatio?: number | string }} [reserve] space held before mount
 */

/**
 * @typedef {object} Bundle
 * @property {string} [version]
 * @property {ReadonlyArray<BundleElement>} elements
 * @property {unknown} [doc] entitlement document(s) — elements a document marks disabled never mount
 * @property {{ nonce?: string }} [csp]
 * @property {Record<string, unknown>} [theme] website design tokens
 * @property {string} [timeZone] website IANA time zone (audience rules)
 * @property {{ sampleRate?: number }} [rum]
 */

/**
 * @typedef {object} BootOptions
 * @property {string} websiteId
 * @property {'live' | 'test'} env
 * @property {Bundle} bundle
 * @property {import('./client.js').Client} [client] events client (consent, identity, tracking)
 * @property {any} [window]
 * @property {() => number} [now]
 * @property {import('./util.js').StorageLike | null} [storage] frequency caps (defaults to localStorage)
 * @property {import('./placement.js').PlacementEnv['audience']} [audience] rules evaluator (`@ss/web/audience`)
 * @property {Record<string, unknown>} [context] extra audience context (e.g. `segments`, `customer`)
 * @property {string} [pageType]
 * @property {{ tablet: number, desktop: number }} [breakpoints]
 * @property {() => number} [random]
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 * @property {(report: { key?: string, phase: string, error: unknown }) => void} [onError]
 * @property {typeof fetch} [fetch] for element API clients
 */

/**
 * @typedef {'idle' | 'blocked' | 'armed' | 'loading' | 'mounted' | 'failed'} ElementStatus
 */

/**
 * @typedef {object} LoaderInstance
 * @property {string} websiteId
 * @property {(key: string) => import('./element.js').HeadlessElement | undefined} get
 * @property {() => ReadonlyArray<{ key: string, status: ElementStatus, reason?: string }>} list
 * @property {() => void} refresh re-evaluate placements (SPA navigation)
 * @property {(type: string, handler: (event: { type: string, data: Record<string, unknown> }) => void) => () => void} on
 * @property {(type: string, data?: Record<string, unknown>, options?: import('./client.js').TrackOptions) => unknown} track
 * @property {() => Promise<void>} ready resolves when every triggered mount has settled
 * @property {() => void} destroy
 */

/**
 * @param {unknown} doc
 * @param {string} key
 * @returns {boolean}
 */
const enabledByDocs = (doc, key) => {
	const docs = Array.isArray(doc) ? doc : doc === undefined || doc === null ? [] : [doc];
	return docs.every((entry) => {
		if (!isPlainObject(entry) || !isPlainObject(entry.elements) || !Object.hasOwn(entry.elements, key)) return true;
		const element = entry.elements[key];
		const active = !isPlainObject(entry.runtime) || entry.runtime.state === undefined || entry.runtime.state === 'active';
		return active && !(isPlainObject(element) && element.enabled === false);
	});
};

/** @param {any} value @param {string} member */
const resolveModule = async (value, member) => {
	if (typeof value !== 'function' || typeof value[member] === 'function') return value;
	const loaded = await value();
	return loaded && typeof loaded[member] !== 'function' && loaded.default ? loaded.default : loaded;
};

/**
 * Boot the Loader for one website. Idempotent: a second call for the same website returns the running instance.
 * @param {BootOptions} options
 * @returns {LoaderInstance}
 */
export const boot = (options) => {
	const {
		websiteId,
		client,
		window: win = globalThis.window,
		now = Date.now,
		random = Math.random,
		setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimer = (handle) => globalThis.clearTimeout(/** @type {any} */ (handle)),
		breakpoints = DEFAULT_BREAKPOINTS,
	} = options;
	const bundle = isPlainObject(options.bundle) ? options.bundle : { elements: [] };
	const doc = win?.document;
	const SS = win ? (win.SS = win.SS && typeof win.SS === 'object' ? win.SS : {}) : {};
	if (!SS[INSTANCES]) Object.defineProperty(SS, INSTANCES, { value: new Map(), enumerable: false });
	/** @type {Map<string, LoaderInstance>} */
	const instances = SS[INSTANCES];
	const existing = instances.get(websiteId);
	if (existing) return existing;

	/** @type {Array<() => void>} */
	const cleanups = [];
	/** @param {any} target @param {string} type @param {(event: any) => void} fn @param {AddEventListenerOptions} [opts] */
	const listen = (target, type, fn, opts) => {
		target?.addEventListener?.(type, fn, opts);
		cleanups.push(() => target?.removeEventListener?.(type, fn, opts));
	};
	/** @type {Set<unknown>} */
	const timers = new Set();
	cleanups.push(() => {
		for (const handle of timers) clearTimer(handle);
		timers.clear();
	});
	/** @param {() => void} fn @param {number} ms */
	const later = (fn, ms) => {
		const handle = setTimer(() => {
			timers.delete(handle);
			fn();
		}, ms);
		timers.add(handle);
		return () => {
			timers.delete(handle);
			clearTimer(handle);
		};
	};
	/** @type {(report: { key?: string, phase: string, error: unknown }) => void} */
	const report = (entry) => {
		attempt(() => options.onError?.(entry));
		attempt(() => win?.dispatchEvent?.(new win.CustomEvent('ss:error', { detail: { key: entry.key, phase: entry.phase } })));
		if (entry.key) attempt(() => client?.track('loader.element_failed@1', { element: entry.key, phase: entry.phase }));
	};

	// ---- event bus: element events, merchant hooks (`SS.on`) and `event` triggers --------------------------------
	/** @type {Map<string, Set<(event: { type: string, data: Record<string, unknown> }) => void>>} */
	const handlers = new Map();
	/** @param {string} type */
	const baseType = (type) => (type.includes('@') ? type.slice(0, type.indexOf('@')) : type);
	/** @param {string} type @param {Record<string, unknown>} data */
	const publish = (type, data) => {
		const full = type.includes('@') ? type : `${type}@1`;
		for (const name of new Set([full, baseType(full), '*'])) {
			for (const handler of [...(handlers.get(name) ?? [])])
				attempt(
					() => handler({ type: full, data }),
					(error) => report({ phase: 'hook', error }),
				);
		}
	};
	/** @type {LoaderInstance['on']} */
	const on = (type, handler) => {
		const set = handlers.get(type) ?? new Set();
		handlers.set(type, set);
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	};
	/** @type {LoaderInstance['track']} */
	const track = (type, data = {}, trackOptions) => {
		if (typeof type === 'string' && isPlainObject(data)) publish(type, data);
		return client ? client.track(type, data, trackOptions) : { ok: false, reason: 'no_client' };
	};

	// ---- environment ---------------------------------------------------------------------------------------------
	const volatileSession = `ses_${Math.floor(random() * 2 ** 52).toString(32)}`;
	const sessionId = () => client?.sessionId() ?? volatileSession;
	const frequency = createFrequency({
		storage: options.storage === undefined ? defaultStorage() : options.storage,
		websiteId,
		now,
		sessionId,
	});
	const pageType = () =>
		options.pageType ??
		doc?.documentElement?.getAttribute?.('data-ss-page-type') ??
		doc?.querySelector?.('meta[name="ss:page-type"]')?.getAttribute('content') ??
		undefined;
	const referrerHost = () => {
		try {
			return doc?.referrer ? new URL(doc.referrer).hostname.toLowerCase() : undefined;
		} catch {
			return undefined;
		}
	};
	const consent = () => client?.consent.get() ?? { necessary: true };
	/** @returns {import('./placement.js').PlacementEnv} */
	const env = () => {
		const path = win?.location?.pathname ?? '/';
		const device = deviceOf(Number(win?.innerWidth ?? breakpoints.desktop), breakpoints);
		return {
			path,
			pageType: pageType(),
			device,
			referrerHost: referrerHost(),
			now: now(),
			consent: consent(),
			hasSelector: (selector) => Boolean(doc?.querySelector(selector)),
			audience: options.audience,
			timeZone: bundle.timeZone,
			audienceContext: {
				...options.context,
				page: {
					path,
					url: win?.location?.href,
					referrer: doc?.referrer || null,
					pageType: pageType() ?? null,
					title: doc?.title ?? null,
				},
				device,
				consent: consent(),
				visitor: { identified: Boolean(client?.identity()) },
			},
		};
	};

	// ---- RUM (sampled Core Web Vitals + per-element mount time) --------------------------------------------------
	/** @type {Record<string, { mountMs: number }>} */
	const elementTimings = {};
	const vitals = {
		lcp: /** @type {number | undefined} */ (undefined),
		cls: 0,
		inp: /** @type {number | undefined} */ (undefined),
	};
	const sampleRate = typeof bundle.rum?.sampleRate === 'number' ? bundle.rum.sampleRate : 0;
	const Observer = win?.PerformanceObserver;
	if (typeof Observer === 'function' && random() < sampleRate) {
		let windowValue = 0;
		let windowStart = 0;
		let windowLast = 0;
		/** @type {Map<number, number>} */
		const interactions = new Map();
		/** @param {string} type @param {(entries: any[]) => void} fn @param {Record<string, unknown>} [extra] */
		const observe = (type, fn, extra = {}) =>
			attempt(() => {
				const observer = new Observer((/** @type {any} */ list) => attempt(() => fn(list.getEntries())));
				observer.observe({ type, buffered: true, ...extra });
				cleanups.push(() => observer.disconnect());
			});
		observe('largest-contentful-paint', (entries) => {
			const last = entries.at(-1);
			if (last) vitals.lcp = Math.round(last.startTime);
		});
		observe('layout-shift', (entries) => {
			for (const entry of entries) {
				if (entry.hadRecentInput) continue;
				if (windowValue > 0 && (entry.startTime - windowLast > 1000 || entry.startTime - windowStart > 5000)) windowValue = 0;
				if (windowValue === 0) windowStart = entry.startTime;
				windowValue += entry.value;
				windowLast = entry.startTime;
				vitals.cls = Math.max(vitals.cls, Math.round(windowValue * 1000) / 1000);
			}
		});
		observe(
			'event',
			(entries) => {
				for (const entry of entries) {
					if (!entry.interactionId) continue;
					interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration));
				}
				const sorted = [...interactions.values()].sort((a, b) => b - a);
				vitals.inp = Math.round(/** @type {number} */ (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))]));
			},
			{ durationThreshold: 40 },
		);
		let reported = false;
		const sendVitals = () => {
			if (reported) return;
			reported = true;
			/** @type {Record<string, unknown>} */
			const data = { cls: vitals.cls, elements: { ...elementTimings } };
			if (vitals.lcp !== undefined) data.lcp = vitals.lcp;
			if (vitals.inp !== undefined) data.inp = vitals.inp;
			if (bundle.version) data.bundleVersion = bundle.version;
			attempt(() => client?.track('loader.vitals@1', data));
			attempt(() => client?.flushBeacon());
		};
		listen(win, 'pagehide', sendVitals);
		listen(doc, 'visibilitychange', () => doc?.visibilityState === 'hidden' && sendVitals());
	}

	// ---- elements ------------------------------------------------------------------------------------------------
	/**
	 * @typedef {object} ElementRecord
	 * @property {BundleElement} spec
	 * @property {ElementStatus} status
	 * @property {number} generation incremented on every mount attempt and unmount
	 * @property {string} [reason]
	 * @property {import('./element.js').HeadlessElement} [instance]
	 * @property {HTMLElement} [container]
	 * @property {() => void} [restore] undo a `replace` mount
	 * @property {Array<() => void>} disarm
	 * @property {Array<() => void>} teardown
	 */
	/** @type {Map<string, ElementRecord>} */
	const records = new Map();
	const lookup = (/** @type {string} */ key) => /** @type {ElementRecord} */ (records.get(key));
	/** @type {Set<Promise<void>>} */
	const pending = new Set();
	let destroyed = false;

	/** @param {ElementRecord} record */
	const clearTriggers = (record) => {
		for (const fn of record.disarm.splice(0)) attempt(fn);
	};

	/** @param {string} key @param {ElementStatus} [status] */
	const unmount = (key, status = 'idle') => {
		const record = lookup(key);
		clearTriggers(record);
		for (const fn of record.teardown.splice(0)) attempt(fn);
		attempt(() => record.instance?.destroy());
		attempt(() => record.restore?.());
		attempt(() => record.container?.remove());
		record.instance = undefined;
		record.container = undefined;
		record.restore = undefined;
		record.status = status;
		record.generation += 1;
	};

	/** @param {string} key @param {string} phase @param {unknown} error */
	const fail = (key, phase, error) => {
		const record = lookup(key);
		unmount(key, 'failed');
		record.reason = phase;
		report({ key: record.spec.key, phase, error });
	};

	/** @param {string} key @param {Record<string, any>} placement */
	const createContainer = (key, placement) => {
		const record = lookup(key);
		const container = /** @type {HTMLElement} */ (doc.createElement('div'));
		container.setAttribute('data-ss-element', record.spec.key);
		const target = (placement.selectors ?? [])
			.map((/** @type {{ selector: string, position?: string }} */ entry) => ({
				entry,
				node: attempt(() => doc.querySelector(entry.selector)),
			}))
			.find((/** @type {{ node: unknown }} */ found) => found.node);
		if (!target) doc.body.appendChild(container);
		else {
			const node = /** @type {HTMLElement} */ (target.node);
			switch (target.entry.position ?? 'append') {
				case 'before':
					node.before(container);
					break;
				case 'after':
					node.after(container);
					break;
				case 'prepend':
					node.prepend(container);
					break;
				case 'replace':
					node.replaceWith(container);
					record.restore = () => container.isConnected && container.replaceWith(node);
					break;
				default:
					node.append(container);
			}
		}
		return container;
	};

	/** @param {string} key */
	const mount = async (key) => {
		const record = lookup(key);
		const { spec } = record;
		const placement = spec.placement ?? {};
		record.status = 'loading';
		const generation = (record.generation += 1);
		const started = win?.performance?.now?.() ?? now();
		try {
			const container = spec.renderer && doc ? createContainer(key, placement) : undefined;
			record.container = container;
			const release = container ? reserveSpace(container, spec.reserve) : () => {};
			const [definition, renderer] = await Promise.all([
				resolveModule(spec.headless, 'create'),
				spec.renderer ? resolveModule(spec.renderer, 'render') : undefined,
			]);
			if (destroyed || record.generation !== generation) return;
			if (!definition || typeof definition.create !== 'function' || definition.key !== spec.key)
				throw new TypeError('invalid headless definition');
			const identity = {
				token: () => client?.identity() ?? null,
				anonymousId: () => client?.anonymousId(),
				sessionId: () => client?.sessionId(),
			};
			const api =
				spec.api?.baseUrl && client
					? createElementApi({ baseUrl: spec.api.baseUrl, key: client.key, identity, fetch: options.fetch })
					: undefined;
			const instance = mountHeadless(definition, {
				config: spec.config,
				strings: spec.strings,
				client: api,
				identity,
				emit: (type, data) => {
					if (type === `${spec.key}.dismissed`) frequency.recordDismiss(spec.key);
					track(type, data, { element: spec.key });
				},
			});
			record.instance = instance;
			if (container && renderer) {
				if (typeof renderer.render !== 'function') throw new TypeError('invalid renderer');
				const theme = { ...bundle.theme, ...spec.theme };
				tokens.apply(container, theme);
				/** @returns {RenderProps} */
				const props = () => ({
					state: instance.state(),
					actions: instance.actions,
					strings: instance.strings,
					theme,
					slots: { ...spec.slots },
					element: instance,
					h,
					nonce: bundle.csp?.nonce,
					reducedMotion: prefersReducedMotion(win),
				});
				let node = renderer.render(props());
				container.appendChild(node);
				release();
				record.teardown.push(
					instance.subscribe(() => {
						if (record.status !== 'mounted') return;
						try {
							const next = renderer.update ? (renderer.update(node, props()) ?? node) : renderer.render(props());
							if (next !== node) {
								/** @type {ChildNode} */ (node).replaceWith(next);
								node = next;
							}
						} catch (error) {
							fail(key, 'render', error);
						}
					}),
				);
			}
			record.status = 'mounted';
			elementTimings[spec.key] = { mountMs: Math.round((win?.performance?.now?.() ?? now()) - started) };
			frequency.recordShow(spec.key);
			track(`${spec.key}.shown`, {}, { element: spec.key });
		} catch (error) {
			fail(key, 'mount', error);
		}
	};

	/** @param {ElementRecord} record @param {Record<string, any>} trigger @param {() => void} fire */
	const arm = (record, trigger, fire) => {
		const type = trigger.type;
		if (type === 'load') {
			const cancel = later(fire, Number(trigger.delayMs ?? 0));
			record.disarm.push(cancel);
		} else if (type === 'idle') {
			/** @type {() => void} */
			let cancel = () => {};
			const reset = () => {
				cancel();
				cancel = later(fire, Number(trigger.afterMs ?? 0));
			};
			reset();
			for (const name of ACTIVITY) win?.addEventListener?.(name, reset, { passive: true });
			record.disarm.push(() => {
				cancel();
				for (const name of ACTIVITY) win?.removeEventListener?.(name, reset, { passive: true });
			});
		} else if (type === 'scroll') {
			const check = () => {
				const root = doc?.documentElement;
				const height = Math.max(Number(root?.scrollHeight ?? 0), Number(doc?.body?.scrollHeight ?? 0));
				const seen = Number(win?.scrollY ?? 0) + Number(win?.innerHeight ?? 0);
				if (height <= 0 || (seen / height) * 100 >= Number(trigger.percent ?? 0)) fire();
			};
			win?.addEventListener?.('scroll', check, { passive: true });
			record.disarm.push(() => win?.removeEventListener?.('scroll', check, { passive: true }));
			later(check, 0);
		} else if (type === 'exit') {
			/** @param {MouseEvent} event */
			const onOut = (event) => {
				if (!event.relatedTarget && event.clientY <= 0) fire();
			};
			doc?.addEventListener?.('mouseout', onOut);
			record.disarm.push(() => doc?.removeEventListener?.('mouseout', onOut));
		} else if (type === 'selector-click') {
			/** @param {Event} event */
			const onClick = (event) => {
				const target = /** @type {Element | null} */ (event.target);
				if (attempt(() => target?.closest?.(trigger.selector))) fire();
			};
			doc?.addEventListener?.('click', onClick, { capture: true });
			record.disarm.push(() => doc?.removeEventListener?.('click', onClick, { capture: true }));
		} else if (type === 'event' && typeof trigger.event === 'string') {
			const wanted = trigger.event;
			record.disarm.push(on(wanted.includes('@') ? wanted : baseType(wanted), fire));
		}
	};

	/** @param {string} key */
	const consider = (key) => {
		const record = lookup(key);
		if (destroyed || (record.status !== 'idle' && record.status !== 'blocked')) return;
		const placement = record.spec.placement ?? {};
		const result = attempt(
			() => matchPlacement(placement, env()),
			(error) => report({ key: record.spec.key, phase: 'placement', error }),
		);
		if (!result || !result.ok) {
			record.status = 'blocked';
			record.reason = result ? result.reason : 'placement';
			return;
		}
		if (!frequency.allowed(record.spec.key, placement.frequency)) {
			record.status = 'blocked';
			record.reason = 'frequency';
			return;
		}
		record.status = 'armed';
		record.reason = undefined;
		const fire = () => {
			if (record.status !== 'armed') return;
			clearTriggers(record);
			// Re-check what may have changed while waiting (consent revoked, cap reached in another tab).
			const again = attempt(() => matchPlacement(placement, env()));
			if (!again?.ok || !frequency.allowed(record.spec.key, placement.frequency)) {
				record.status = 'blocked';
				record.reason = again && !again.ok ? again.reason : 'frequency';
				return;
			}
			const task = mount(key);
			pending.add(task);
			void task.finally(() => pending.delete(task));
		};
		const triggers =
			Array.isArray(placement.triggers) && placement.triggers.length > 0 ? placement.triggers : [{ type: 'load' }];
		for (const trigger of triggers)
			attempt(
				() => arm(record, trigger, fire),
				(error) => report({ key: record.spec.key, phase: 'trigger', error }),
			);
	};

	for (const spec of Array.isArray(bundle.elements) ? bundle.elements : []) {
		if (!isPlainObject(spec) || typeof spec.key !== 'string' || !ELEMENT_KEY.test(spec.key) || records.has(spec.key)) {
			report({ key: undefined, phase: 'bundle', error: new TypeError('invalid or duplicate element in bundle') });
			continue;
		}
		if (!enabledByDocs(bundle.doc, spec.key)) continue;
		records.set(spec.key, {
			spec: /** @type {BundleElement} */ (spec),
			status: 'idle',
			generation: 0,
			disarm: [],
			teardown: [],
		});
	}

	const refresh = () => {
		if (destroyed) return;
		for (const [key, record] of records) {
			if (record.status === 'failed') continue;
			if (record.status === 'mounted' || record.status === 'loading' || record.status === 'armed') {
				const result = attempt(() => matchPlacement(record.spec.placement ?? {}, env()));
				if (result?.ok) continue;
				unmount(key);
			}
			if (record.status === 'blocked') lookup(key).status = 'idle';
			consider(key);
		}
	};

	const start = () => {
		for (const key of records.keys()) consider(key);
	};
	if (doc?.readyState === 'loading') listen(doc, 'DOMContentLoaded', start, { once: true });
	else start();
	if (client) cleanups.push(client.consent.subscribe(() => refresh()));
	listen(win, 'popstate', refresh);

	/** @type {LoaderInstance} */
	const instance = Object.freeze({
		websiteId,
		get: (key) => (records.get(key)?.status === 'mounted' ? records.get(key)?.instance : undefined),
		list: () =>
			[...records.values()].map((record) =>
				Object.freeze(
					record.reason
						? { key: record.spec.key, status: record.status, reason: record.reason }
						: { key: record.spec.key, status: record.status },
				),
			),
		refresh,
		on,
		track,
		ready: async () => {
			while (pending.size > 0) await Promise.allSettled([...pending]);
		},
		destroy: () => {
			if (destroyed) return;
			for (const key of records.keys()) unmount(key);
			destroyed = true;
			for (const fn of cleanups.splice(0)) attempt(fn);
			handlers.clear();
			instances.delete(websiteId);
			if (SS[OWNER] === websiteId) {
				for (const name of SS_API) delete SS[name];
				delete SS[OWNER];
			}
		},
	});
	instances.set(websiteId, instance);

	// ---- window.SS -----------------------------------------------------------------------------------------------
	if (win && !instances.has(SS[OWNER])) {
		SS[OWNER] = websiteId;
		const queued = Array.isArray(SS.q) ? SS.q.splice(0) : [];
		Object.assign(SS, {
			version: 1,
			track,
			identify: (/** @type {{ token: string | null }} */ input) => {
				const result = client ? client.identify(input) : { ok: false };
				refresh();
				return result;
			},
			consent: Object.freeze({
				get: consent,
				set: (/** @type {Record<string, boolean>} */ decisions) => client?.consent.set(decisions) ?? consent(),
			}),
			elements: Object.freeze({ get: instance.get, list: instance.list }),
			on,
			refresh,
		});
		for (const entry of queued) {
			if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
			const [method, ...args] = entry;
			attempt(() => {
				if (method === 'consent') SS.consent.set(args[0]);
				else if (typeof SS[method] === 'function') SS[method](...args);
			});
		}
	}
	return instance;
};
