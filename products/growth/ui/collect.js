/**
 * The page script's analytics (PLAN 0.8.9 Own analytics): events are queued and sent to `POST /v1/collect` with the
 * browser token in small batches (shortly after they happen, and when the page is hidden, with `keepalive`). While the
 * merchant requires consent and the visitor has not given analytics consent, events wait in memory for this page
 * only; refusing drops them. What is sent is anonymous: the page view, whether it starts a visit (the start of the
 * visit is a time in sessionStorage, never an id), the referring host, the campaign, a device class, searches, 404s,
 * the shop events and Web Vitals.
 *
 * With the `detail` setting `sessions` (PLAN 0.8.10 G3) every event also carries the tab's session: a random id kept
 * in that tab's sessionStorage (never a cross-site id, gone when the tab closes or after 30 minutes without a page
 * view) with the browser and system family; a page view says which page of the session it is and how long after the
 * last one it came.
 * @module
 */
import { MAX_BATCH, familiesOf } from '../core/events.js';
import { PAGE_MARKER, SESSION_STORAGE_KEY, VISIT_IDLE_MS, VISIT_STORAGE_KEY } from '../core/widgets.js';

/** Events wait this long for others before a batch is sent. */
const FLUSH_DELAY_MS = 1000;
/** Most events kept while waiting for consent. */
const MAX_WAITING = 50;

/** @typedef {Record<string, unknown> & { type: string, path: string }} PageEvent */
/** @typedef {import('./consent.js').KeyValue} KeyValue */

/**
 * @param {{ base: string, token: string, fetch: typeof fetch, schedule: (task: () => void, ms: number) => unknown,
 *   stamp?: () => Record<string, unknown> }} input `stamp`: what every event also carries (the session, G3), read when
 *   the event is built
 */
export const createCollector = ({ base, token, fetch, schedule, stamp }) => {
	/** @type {PageEvent[]} */
	const queue = [];
	/** @type {Array<() => PageEvent | null>} */
	let waiting = [];
	let allowed = false;
	let timer = false;

	const flush = () => {
		timer = false;
		while (queue.length > 0) {
			const events = queue.splice(0, MAX_BATCH);
			void fetch(`${base}/v1/collect`, {
				method: 'POST',
				keepalive: true,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ events }),
			}).catch(() => undefined);
		}
	};

	/** @param {PageEvent | null} event */
	const enqueue = (event) => {
		if (event === null) return;
		queue.push(stamp ? { ...event, ...stamp() } : event);
		if (!timer) {
			timer = true;
			schedule(flush, FLUSH_DELAY_MS);
		}
	};

	return Object.freeze({
		/**
		 * Record an event (built when it may be sent, so nothing is kept in storage before consent).
		 * @param {() => PageEvent | null} make
		 */
		record: (make) => {
			if (allowed) enqueue(make());
			else if (waiting.length < MAX_WAITING) waiting.push(make);
		},
		/** @param {boolean} yes may events be sent now */
		allow: (yes) => {
			allowed = yes;
			const ready = waiting;
			waiting = [];
			if (yes) for (const make of ready) enqueue(make());
		},
		flush,
	});
};

/** @typedef {ReturnType<typeof createCollector>} Collector */

/**
 * The device class from the window's width.
 * @param {number} width
 */
export const deviceOf = (width) => (width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop');

/**
 * A random session id: 32 hex characters (G3).
 * @param {Window} win
 */
export const randomId = (win) => {
	const bytes = new Uint8Array(16);
	try {
		win.crypto.getRandomValues(bytes);
	} catch {
		for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
	}
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** @typedef {{ id: string, last: number, pages: number }} SessionState */

/**
 * The tab's session (G3): created by its first page view, or by any event before one; it ends after 30 minutes
 * without a page view. Kept in sessionStorage (in memory when the browser refuses it).
 * @param {{ visits: KeyValue, now: () => number, random: () => string, userAgent: string, touch?: boolean }} input
 */
export const createSession = ({ visits, now, random, userAgent, touch = false }) => {
	const { browser, os } = familiesOf(userAgent, { touch });
	/** @type {SessionState | null} */
	let memory = null;
	/** @returns {SessionState | null} the session while it lasts */
	const current = () => {
		/** @type {SessionState | null} */
		let kept = memory;
		try {
			const stored = JSON.parse(visits.getItem(SESSION_STORAGE_KEY) ?? 'null');
			if (typeof stored?.id === 'string' && Number.isFinite(stored.last) && Number.isSafeInteger(stored.pages)) kept = stored;
		} catch {
			// unreadable: the one in memory
		}
		return kept !== null && now() - kept.last < VISIT_IDLE_MS && kept.last <= now() ? kept : null;
	};
	/** @param {SessionState} state */
	const save = (state) => {
		memory = state;
		try {
			visits.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
		} catch {
			// kept in memory for this page
		}
		return state;
	};
	return Object.freeze({
		/**
		 * A page view: whether it starts the session, which page of it this is and how long after the last one.
		 * @returns {{ visit: boolean, page: number, gap: number | null }}
		 */
		view: () => {
			const kept = current();
			const state = save({ id: kept?.id ?? random(), last: now(), pages: (kept?.pages ?? 0) + 1 });
			return {
				visit: kept === null || kept.pages === 0,
				page: state.pages,
				gap: kept && kept.pages > 0 ? now() - kept.last : null,
			};
		},
		/** What every event carries: the session id, the browser and the system family. */
		stamp: () => ({ session: (current() ?? save({ id: random(), last: now(), pages: 0 })).id, browser, os }),
	});
};

/** @typedef {ReturnType<typeof createSession>} Session */

/**
 * Where the visitor came from to this page (G3, for 404s): a path on this site, another site's host, or null.
 * @param {Window} win
 * @returns {string | null}
 */
export const cameFrom = (win) => {
	try {
		const referrer = new URL(win.document.referrer);
		return referrer.host === win.location.host ? referrer.pathname : referrer.hostname;
	} catch {
		return null;
	}
};

/**
 * The page view of the current page: whether it starts a visit (none in the last 30 minutes in this tab's session),
 * the referring host and the campaign of a visit's first page; with a session (G3), which page of it this is and how
 * long after the last one it came. `inApp`: the page was opened inside the website without loading a document (a
 * single-page app's navigation, SG-4), so it came from this website, not from the document's referrer.
 * @param {{ window: Window, visits: KeyValue, now: () => number, session?: Session | null, inApp?: boolean }} input
 * @returns {PageEvent}
 */
export const pageView = ({ window: win, visits, now, session = null, inApp = false }) => {
	const last = Number(visits.getItem(VISIT_STORAGE_KEY));
	const viewed = session?.view() ?? null;
	const visit = viewed ? viewed.visit : !(last > 0 && now() - last < VISIT_IDLE_MS);
	try {
		visits.setItem(VISIT_STORAGE_KEY, String(now()));
	} catch {
		// no sessionStorage: every page counts as a visit's first
	}
	const url = new URL(win.location.href);
	/** @type {string | null} */
	let referrer = null;
	try {
		referrer = inApp ? url.hostname : win.document.referrer ? new URL(win.document.referrer).hostname : null;
	} catch {
		referrer = null;
	}
	return {
		type: 'page_view',
		path: url.pathname,
		visit,
		device: deviceOf(win.innerWidth),
		...(viewed ? { page: viewed.page, ...(viewed.gap === null ? {} : { gap: viewed.gap }) } : {}),
		...(visit
			? {
					referrer,
					campaign: {
						source: url.searchParams.get('utm_source') ?? '',
						medium: url.searchParams.get('utm_medium') ?? '',
						name: url.searchParams.get('utm_campaign') ?? '',
					},
				}
			: {}),
	};
};

/**
 * Follow the page's own navigations (single-page apps, SG-4): `history.pushState` and the back and forward buttons
 * (`popstate`) when the address (path or query string) changes, and `history.replaceState` when the path does (a
 * query string replaced on the same path is the same page: its filters, a variant, scroll state). `change` gets the
 * address the visitor came from; whatever it does, the page's own navigation goes on.
 * @param {{ window: Window, change: (from: URL) => void }} input
 */
export const watchNavigation = ({ window: win, change }) => {
	let current = new URL(win.location.href);
	/** @param {boolean} pathOnly */
	const check = (pathOnly) => {
		const next = new URL(win.location.href);
		const from = current;
		current = next;
		if (next.pathname !== from.pathname || (!pathOnly && next.search !== from.search)) change(from);
	};
	/** @param {boolean} pathOnly */
	const safely = (pathOnly) => {
		try {
			check(pathOnly);
		} catch {
			// never in the way of the page's navigation
		}
	};
	const history = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (win.history));
	for (const [name, pathOnly] of /** @type {const} */ ([
		['pushState', false],
		['replaceState', true],
	])) {
		const original = history[name];
		if (typeof original !== 'function') continue;
		history[name] = function navigate(/** @type {unknown[]} */ ...args) {
			const result = original.apply(this, args);
			safely(pathOnly);
			return result;
		};
	}
	win.addEventListener('popstate', () => safely(false));
};

/**
 * A site search on this page's address (one of the search parameters, not empty), or null.
 * @param {Window} win
 * @param {string[]} params
 * @returns {PageEvent | null}
 */
export const searchOnPage = (win, params) => {
	const url = new URL(win.location.href);
	for (const name of params) {
		const term = url.searchParams.get(name)?.trim();
		if (term) return { type: 'search', path: url.pathname, term };
	}
	return null;
};

/**
 * Whether the page marks itself as a 404 (`<meta name="ss-growth-page" content="not_found">`).
 * @param {Document} doc
 */
export const markedNotFound = (doc) =>
	doc.querySelector(`meta[name="${PAGE_MARKER}"]`)?.getAttribute('content')?.trim().toLowerCase() === 'not_found';

/** CLS: layout shifts less than this apart (ms) are one session window, which lasts at most {@link SHIFT_WINDOW_MS}. */
const SHIFT_GAP_MS = 1000;
const SHIFT_WINDOW_MS = 5000;
/** INP: the longest interactions kept; one of them is passed over per this many interactions (about the 98th percentile). */
const LONGEST_KEPT = 10;
const INTERACTIONS_PER_STEP = 50;

/**
 * Measure Web Vitals with the browser's PerformanceObserver the way web.dev defines them (the `web-vitals` library's
 * rules, SG-26) and report them together once when the page is first hidden (one batch, RT-2): LCP (the last largest
 * paint), FCP (the first contentful paint), both only while the page had not been hidden yet, and after a prerendered
 * page was shown; CLS (the largest session window of layout shifts without recent input: shifts less than 1 s apart,
 * at most 5 s, × 1000; 0 for a page that painted without shifting); INP (the longest interaction, passing over one of
 * the 10 longest per 50 interactions: about the 98th percentile; only after an interaction); TTFB. They are the loaded
 * document's, so a single-page app files them under the page it was loaded on (SG-4).
 * @param {{ window: Window & typeof globalThis, report: (vitals: Array<[name: string, value: number]>) => void }} input
 */
export const watchVitals = ({ window: win, report }) => {
	const Observer = win.PerformanceObserver;
	if (typeof Observer !== 'function') return;
	const doc = win.document;
	/** @type {Record<string, number>} */
	const values = {};
	/** @type {Array<() => void>} each observer's entries not delivered yet, taken when the page is hidden */
	const pending = [];
	// a page loaded in a background tab: its paints are not what the visitor saw
	let hiddenAt = doc.visibilityState === 'hidden' ? 0 : Number.POSITIVE_INFINITY;
	/** @type {any} */
	let navigation = null;
	try {
		navigation = win.performance.getEntriesByType('navigation')[0] ?? null;
	} catch {
		// no navigation timing
	}
	// a prerendered page counts from when it was shown
	const activationStart = Number(navigation?.activationStart) || 0;
	/** @param {number} time */
	const sinceShown = (time) => Math.max(time - activationStart, 0);
	if (navigation && navigation.responseStart > 0) values.TTFB = sinceShown(navigation.responseStart);

	/** @param {string} type @param {(entries: any[]) => void} take @param {Record<string, unknown>} [extra] */
	const observe = (type, take, extra = {}) => {
		try {
			const observer = new Observer((list) => take(list.getEntries()));
			observer.observe({ type, buffered: true, ...extra });
			if (typeof observer.takeRecords === 'function') pending.push(() => take(observer.takeRecords()));
			return true;
		} catch {
			// this browser does not measure it
			return false;
		}
	};
	observe('largest-contentful-paint', (entries) => {
		const last = entries[entries.length - 1];
		if (last && last.startTime < hiddenAt) values.LCP = sinceShown(last.startTime);
	});
	observe('paint', (entries) => {
		const first = entries.find((entry) => entry.name === 'first-contentful-paint');
		if (first && first.startTime < hiddenAt) values.FCP = sinceShown(first.startTime);
	});

	let windowValue = 0;
	/** @type {any[]} the shifts of the current session window */
	let shifts = [];
	let largestWindow = 0;
	const measuresShifts = observe('layout-shift', (entries) => {
		for (const entry of entries) {
			if (entry.hadRecentInput) continue;
			const first = shifts[0];
			const last = shifts[shifts.length - 1];
			if (first && entry.startTime - last.startTime < SHIFT_GAP_MS && entry.startTime - first.startTime < SHIFT_WINDOW_MS) {
				windowValue += entry.value;
				shifts.push(entry);
			} else {
				windowValue = entry.value;
				shifts = [entry];
			}
			largestWindow = Math.max(largestWindow, windowValue);
		}
	});

	/** @type {Array<{ id: number, duration: number }>} the longest interactions, longest first */
	let longest = [];
	let lowestId = Number.POSITIVE_INFINITY;
	let highestId = 0;
	/** @param {any[]} entries */
	const takeInteractions = (entries) => {
		for (const entry of entries) {
			const id = Number(entry.interactionId) || 0;
			if (id === 0) continue;
			lowestId = Math.min(lowestId, id);
			highestId = Math.max(highestId, id);
			const duration = Number(entry.duration) || 0;
			const known = longest.find((interaction) => interaction.id === id);
			if (known) known.duration = Math.max(known.duration, duration);
			else longest.push({ id, duration });
			longest = longest.sort((a, b) => b.duration - a.duration).slice(0, LONGEST_KEPT);
		}
		if (longest.length === 0) return;
		// the browser's count of interactions, else estimated from the ids it gave them (they go up by 7)
		const counted = Number(/** @type {any} */ (win.performance)?.interactionCount) || (highestId - lowestId) / 7 + 1;
		const pick = longest[Math.min(longest.length - 1, Math.floor(counted / INTERACTIONS_PER_STEP))];
		if (pick) values.INP = pick.duration;
	};
	observe('event', takeInteractions, { durationThreshold: 40 });
	observe('first-input', takeInteractions);

	let sent = false;
	/** @param {Event} [event] */
	const send = (event) => {
		if (sent || doc.visibilityState !== 'hidden') return;
		if (event && event.timeStamp > 0) hiddenAt = Math.min(hiddenAt, event.timeStamp);
		sent = true;
		for (const take of pending) take();
		if (measuresShifts && (largestWindow > 0 || values.FCP !== undefined)) values.CLS = largestWindow * 1000;
		report(Object.entries(values));
	};
	doc.addEventListener('visibilitychange', send);
	win.addEventListener('pagehide', send);
};
