/**
 * The page script's analytics (PLAN 0.8.9 Own analytics): events are queued and sent to `POST /v1/collect` with the
 * browser token in small batches (shortly after they happen, and when the page is hidden, with `keepalive`). While the
 * merchant requires consent and the visitor has not given analytics consent, events wait in memory for this page
 * only; refusing drops them. What is sent is anonymous: the page view, whether it starts a visit (the start of the
 * visit is a time in sessionStorage, never an id), the referring host, the campaign, a device class, searches, 404s,
 * the shop events and Web Vitals.
 * @module
 */
import { MAX_BATCH } from '../core/events.js';
import { PAGE_MARKER, VISIT_IDLE_MS, VISIT_STORAGE_KEY } from '../core/widgets.js';

/** Events wait this long for others before a batch is sent. */
export const FLUSH_DELAY_MS = 1000;
/** Most events kept while waiting for consent. */
const MAX_WAITING = 50;

/** @typedef {Record<string, unknown> & { type: string, path: string }} PageEvent */
/** @typedef {import('./consent.js').KeyValue} KeyValue */

/**
 * @param {{ base: string, token: string, fetch: typeof fetch, schedule: (task: () => void, ms: number) => unknown }} input
 */
export const createCollector = ({ base, token, fetch, schedule }) => {
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
		queue.push(event);
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
 * The page view of the current page: whether it starts a visit (none in the last 30 minutes in this tab's session),
 * the referring host and the campaign of a visit's first page.
 * @param {{ window: Window, visits: KeyValue, now: () => number }} input
 * @returns {PageEvent}
 */
export const pageView = ({ window: win, visits, now }) => {
	const last = Number(visits.getItem(VISIT_STORAGE_KEY));
	const visit = !(last > 0 && now() - last < VISIT_IDLE_MS);
	try {
		visits.setItem(VISIT_STORAGE_KEY, String(now()));
	} catch {
		// no sessionStorage: every page counts as a visit's first
	}
	const url = new URL(win.location.href);
	/** @type {string | null} */
	let referrer = null;
	try {
		referrer = win.document.referrer ? new URL(win.document.referrer).hostname : null;
	} catch {
		referrer = null;
	}
	return {
		type: 'page_view',
		path: url.pathname,
		visit,
		device: deviceOf(win.innerWidth),
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

/**
 * Measure Web Vitals with the browser's PerformanceObserver and report each once when the page is first hidden:
 * LCP (last largest paint), CLS (shifts without recent input, × 1000), INP (the longest interaction), FCP and TTFB.
 * @param {{ window: Window & typeof globalThis, report: (name: string, value: number) => void }} input
 */
export const watchVitals = ({ window: win, report }) => {
	const Observer = win.PerformanceObserver;
	if (typeof Observer !== 'function') return;
	/** @type {Record<string, number>} */
	const values = {};
	/** @param {string} type @param {(entries: any[]) => void} take @param {Record<string, unknown>} [extra] */
	const observe = (type, take, extra = {}) => {
		try {
			new Observer((list) => take(list.getEntries())).observe({ type, buffered: true, ...extra });
		} catch {
			// this browser does not measure it
		}
	};
	observe('largest-contentful-paint', (entries) => {
		const last = entries[entries.length - 1];
		if (last) values.LCP = last.startTime;
	});
	observe('layout-shift', (entries) => {
		for (const entry of entries) if (!entry.hadRecentInput) values.CLS = (values.CLS ?? 0) + entry.value * 1000;
	});
	observe(
		'event',
		(entries) => {
			for (const entry of entries)
				if (entry.interactionId) values.INP = Math.max(values.INP ?? 0, Number(entry.duration) || 0);
		},
		{ durationThreshold: 40 },
	);
	observe('paint', (entries) => {
		const first = entries.find((entry) => entry.name === 'first-contentful-paint');
		if (first) values.FCP = first.startTime;
	});
	try {
		const navigation = /** @type {any} */ (win.performance.getEntriesByType('navigation')[0]);
		if (navigation && navigation.responseStart > 0) values.TTFB = navigation.responseStart;
	} catch {
		// no navigation timing
	}
	let sent = false;
	const send = () => {
		if (sent || win.document.visibilityState !== 'hidden') return;
		sent = true;
		for (const [name, value] of Object.entries(values)) report(name, value);
	};
	win.document.addEventListener('visibilitychange', send);
	win.addEventListener('pagehide', send);
};
