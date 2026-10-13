/**
 * What the page script sends to `POST /v1/collect` (PLAN 0.8.9 Own analytics): anonymous events, checked and reduced
 * to what is kept. No IP address, user agent, cookie or cross-site id is ever kept: a page view carries only the path
 * (never the query string), whether it starts a visit, the referring host or campaign source, a device class and the
 * country the host's request header gave. Each event type belongs to one feature and is dropped while it is off.
 *
 * Every kept event becomes a raw event (removed by the database expiry index after the retention) and increments of
 * the daily totals (kept forever): `{ day, metric, key, count, sum }`, where `day` is the day in the website's business
 * time zone (business.json `timeZone`, UTC when missing; PLAN 0.8.10 K8).
 *
 * With the `detail` setting `sessions` (PLAN 0.8.10 G3), events also carry the tab's random session id (never a
 * cross-site id), the browser and system family and the city of the host's header; a page view says which page of the
 * session it is and how long after the session's last page it came, and a 404 where the visitor came from. The daily
 * totals then also count sessions, engaged sessions (a second page), their pages and time, browsers, systems and
 * cities, Web Vitals per page and 404 referrers.
 * @module
 */
import { zonedDay } from '@ss/contracts/format';
import { FUNNEL_STEPS, VISIT_IDLE_MS } from './widgets.js';
import { isAmount, isCurrency } from './money.js';

/** The feature each event type belongs to. */
export const EVENT_FEATURES = Object.freeze({
	page_view: 'visitor_analytics',
	view_item: 'conversion_funnel',
	add_to_cart: 'conversion_funnel',
	begin_checkout: 'conversion_funnel',
	purchase: 'conversion_funnel',
	search: 'searches_404s',
	not_found: 'searches_404s',
	vital: 'web_vitals',
});

/** @typedef {keyof typeof EVENT_FEATURES} EventType */

/** The features whose events `POST /v1/collect` takes. */
export const COLLECT_FEATURES = Object.freeze(['visitor_analytics', 'conversion_funnel', 'searches_404s', 'web_vitals']);

/** Most events in one request (the page script sends smaller batches). */
export const MAX_BATCH = 25;

/** Most items kept of one funnel event. */
const MAX_ITEMS = 50;

/** Device classes the page script reports (from the screen width). */
export const DEVICES = Object.freeze(['mobile', 'tablet', 'desktop']);

/** The Web Vitals the page script measures, with the good and poor thresholds of web.dev (ms; CLS × 1000). */
export const VITALS = Object.freeze({
	LCP: Object.freeze([2500, 4000]),
	INP: Object.freeze([200, 500]),
	CLS: Object.freeze([100, 250]),
	FCP: Object.freeze([1800, 3000]),
	TTFB: Object.freeze([800, 1800]),
});

/** @typedef {keyof typeof VITALS} VitalName */

/** Browser families a session may name (G3). */
export const BROWSERS = Object.freeze(['chrome', 'safari', 'edge', 'firefox', 'samsung', 'opera', 'other']);
/** System families a session may name (G3). */
export const SYSTEMS = Object.freeze(['android', 'ios', 'windows', 'macos', 'chromeos', 'linux', 'other']);

/** A visit with no referrer and no campaign. */
export const DIRECT = '(direct)';
/** A country the host's header did not give. */
export const UNKNOWN = '(unknown)';

/**
 * @typedef {object} KeptEvent
 * @property {EventType} type
 * @property {string} path
 * @property {Record<string, unknown>} data what else is kept with the raw event
 * @property {Array<{ metric: string, key: string, count: number, sum: number }>} totals increments of the daily totals
 * @property {{ session: string, browser: string | null, os: string | null, city: string | null }} [visitor] the session
 *   facts kept with the raw event (G3)
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A page path: the path only (no query string or fragment), at most 300 characters, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const pathOf = (value) => {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
	const path = value.split(/[?#]/)[0] ?? '';
	// eslint-disable-next-line no-control-regex
	if (path.length === 0 || path.length > 300 || /[\u0000-\u001f\s]/.test(path)) return null;
	return path;
};

/**
 * A host name (lowercase, letters, digits, dots and dashes), or null.
 * @param {unknown} value
 */
const hostOf = (value) =>
	typeof value === 'string' && /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(value.toLowerCase())
		? value.toLowerCase()
		: null;

/**
 * Plain text of at most `max` characters (trimmed, spaces collapsed), or ''.
 * @param {unknown} value
 * @param {number} max
 */
export const textOf = (value, max) =>
	typeof value === 'string'
		? value
				// eslint-disable-next-line no-control-regex
				.replace(/[\u0000-\u001f\u007f]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, max)
		: '';

/**
 * The country of a request from the host's header (two letters), or null.
 * @param {(name: string) => string | null} header
 */
export const countryOf = (header) => {
	for (const name of ['x-vercel-ip-country', 'cf-ipcountry', 'cloudfront-viewer-country', 'x-country-code']) {
		const value = (header(name) ?? '').trim().toUpperCase();
		if (/^[A-Z]{2}$/.test(value)) return value;
	}
	return null;
};

/**
 * The city of a request from the host's header (Vercel's is URL-encoded), at most 80 characters, or null (G3).
 * @param {(name: string) => string | null} header
 */
export const cityOf = (header) => {
	for (const name of ['x-vercel-ip-city', 'cf-ipcity', 'cloudfront-viewer-city']) {
		const raw = header(name);
		if (!raw) continue;
		let value = raw;
		try {
			value = decodeURIComponent(raw);
		} catch {
			// kept as sent
		}
		const city = textOf(value, 80);
		if (city !== '' && !/^\d+$/.test(city)) return city;
	}
	return null;
};

/**
 * The browser and system family of a user agent (G3): only the family is ever sent, never the user agent. `touch`:
 * an iPad that names itself a Mac.
 * @param {string} userAgent
 * @param {{ touch?: boolean }} [options]
 * @returns {{ browser: string, os: string }}
 */
export const familiesOf = (userAgent, { touch = false } = {}) => {
	const ua = String(userAgent);
	const browser = /\bEdg(?:e|A|iOS)?\//.test(ua)
		? 'edge'
		: /\bOPR\/|\bOpera\b/.test(ua)
			? 'opera'
			: /SamsungBrowser\//.test(ua)
				? 'samsung'
				: /Firefox\/|FxiOS\//.test(ua)
					? 'firefox'
					: /Chrome\/|CriOS\/|Chromium\//.test(ua)
						? 'chrome'
						: /Safari\//.test(ua) && /Version\//.test(ua)
							? 'safari'
							: 'other';
	const os = /Android/.test(ua)
		? 'android'
		: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch)
			? 'ios'
			: /Windows/.test(ua)
				? 'windows'
				: /CrOS/.test(ua)
					? 'chromeos'
					: /Mac OS X|Macintosh/.test(ua)
						? 'macos'
						: /Linux/.test(ua)
							? 'linux'
							: 'other';
	return { browser, os };
};

/**
 * A session id the page script (or the merchant's server) sent: 8 to 64 letters, digits, `_` or `-`, else null.
 * @param {unknown} value
 */
const sessionIdOf = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null);

/**
 * Where a 404's visitor came from (G3): a path on the website or another site's host; null when unknown.
 * @param {unknown} value
 */
const cameFromOf = (value) => pathOf(value) ?? hostOf(value);

/**
 * The session facts of an event (G3), or null without a session id.
 * @param {Record<string, any>} raw
 * @param {string | null} city
 */
const visitorOf = (raw, city) => {
	const session = sessionIdOf(raw.session);
	if (session === null) return null;
	return {
		session,
		browser: BROWSERS.includes(raw.browser) ? String(raw.browser) : null,
		os: SYSTEMS.includes(raw.os) ? String(raw.os) : null,
		city,
	};
};

/**
 * The rating of a Web Vital value.
 * @param {VitalName} name
 * @param {number} value
 * @returns {'good' | 'needs_improvement' | 'poor'}
 */
export const ratingOf = (name, value) => {
	const [good = 0, poor = 0] = VITALS[name];
	return value <= good ? 'good' : value <= poor ? 'needs_improvement' : 'poor';
};

/**
 * The items of a funnel event: ids and quantities only.
 * @param {unknown} value
 */
const itemsOf = (value) =>
	(Array.isArray(value) ? value : [])
		.slice(0, MAX_ITEMS)
		.filter(isObject)
		.map((item) => ({
			id: textOf(item.id, 80),
			variantId: textOf(item.variantId, 80) || null,
			quantity: Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10_000 ? item.quantity : 1,
		}))
		.filter((item) => item.id !== '');

/**
 * One event as the page script sent it, checked: what is kept, or null when it is invalid.
 * @param {unknown} raw
 * @param {{ domain: string, country: string | null, sessions?: boolean, city?: string | null }} context `domain`: the
 *   website's (a referrer on it is not a source); `sessions`: the `detail` setting is `sessions` (G3); `city`: from the
 *   host's header
 * @returns {KeptEvent | null}
 */
export const checkEvent = (raw, context) => {
	const kept = checkBase(raw, context);
	if (kept === null || !context.sessions || !isObject(raw)) return kept;
	const visitor = visitorOf(raw, context.city ?? null);
	/** @type {KeptEvent['totals']} */
	const more = [];
	if (kept.type === 'vital')
		more.push({
			metric: 'vital_page',
			key: `${kept.path}\n${String(kept.data.name)}`,
			count: 1,
			sum: Number(kept.data.value),
		});
	if (kept.type === 'not_found') {
		const from = cameFromOf(raw.referrer);
		kept.data = { from };
		more.push({ metric: 'not_found_from', key: `${kept.path}\n${from ?? DIRECT}`, count: 1, sum: 0 });
	}
	if (visitor !== null && kept.type === 'page_view') {
		const page = Number.isSafeInteger(raw.page) && raw.page > 0 && raw.page <= 10_000 ? Number(raw.page) : null;
		const gap =
			typeof raw.gap === 'number' && Number.isFinite(raw.gap) && raw.gap >= 0 && raw.gap <= VISIT_IDLE_MS
				? Math.round(raw.gap)
				: null;
		more.push({ metric: 'session_pages', key: '', count: 1, sum: 0 });
		if (kept.data.visit === true) {
			const where = String(kept.data.country ?? UNKNOWN);
			more.push(
				{ metric: 'sessions', key: '', count: 1, sum: 0 },
				{ metric: 'browser', key: visitor.browser ?? 'other', count: 1, sum: 0 },
				{ metric: 'os', key: visitor.os ?? 'other', count: 1, sum: 0 },
				...(visitor.city === null
					? []
					: [{ metric: 'city', key: where === UNKNOWN ? visitor.city : `${visitor.city}, ${where}`, count: 1, sum: 0 }]),
			);
		} else if (gap !== null) more.push({ metric: 'duration', key: '', count: 1, sum: gap });
		if (page === 2) more.push({ metric: 'engaged', key: '', count: 1, sum: 0 });
		kept.data = { ...kept.data, ...(page === null ? {} : { page }) };
	}
	return { ...kept, totals: [...kept.totals, ...more], ...(visitor === null ? {} : { visitor }) };
};

/**
 * One event checked as anonymous analytics keep it (without the session facts of G3).
 * @param {unknown} raw
 * @param {{ domain: string, country: string | null }} context
 * @returns {KeptEvent | null}
 */
const checkBase = (raw, { domain, country }) => {
	if (!isObject(raw) || typeof raw.type !== 'string' || !Object.hasOwn(EVENT_FEATURES, raw.type)) return null;
	const type = /** @type {EventType} */ (raw.type);
	const path = pathOf(raw.path);
	if (path === null) return null;
	if (type === 'page_view') {
		const visit = raw.visit === true;
		const device = DEVICES.includes(raw.device) ? String(raw.device) : 'desktop';
		const referrer = hostOf(raw.referrer);
		const external = referrer !== null && referrer !== domain && referrer !== `www.${domain}` && `www.${referrer}` !== domain;
		const campaign = isObject(raw.campaign) ? raw.campaign : {};
		const utm = {
			source: textOf(campaign.source, 100).toLowerCase(),
			medium: textOf(campaign.medium, 100).toLowerCase(),
			name: textOf(campaign.name, 100),
		};
		const source = utm.source || (external ? referrer : DIRECT);
		const where = country ?? UNKNOWN;
		return {
			type,
			path,
			data: visit ? { visit, source, medium: utm.medium, campaign: utm.name, device, country: where } : { visit },
			totals: [
				{ metric: 'page_views', key: '', count: 1, sum: 0 },
				{ metric: 'page', key: path, count: 1, sum: 0 },
				...(visit
					? [
							{ metric: 'visits', key: '', count: 1, sum: 0 },
							{ metric: 'source', key: source, count: 1, sum: 0 },
							{ metric: 'device', key: device, count: 1, sum: 0 },
							{ metric: 'country', key: where, count: 1, sum: 0 },
						]
					: []),
			],
		};
	}
	if (FUNNEL_STEPS.includes(type)) {
		const currency = isCurrency(raw.currency) ? raw.currency : null;
		const value = currency !== null && isAmount(raw.value) ? raw.value : 0;
		const orderId = type === 'purchase' ? textOf(raw.orderId, 80) || null : null;
		return {
			type,
			path,
			data: { items: itemsOf(raw.items), value, currency, ...(type === 'purchase' ? { orderId } : {}) },
			totals: [
				{ metric: 'funnel', key: type, count: 1, sum: 0 },
				...(type === 'purchase' && currency !== null ? [{ metric: 'revenue', key: currency, count: 1, sum: value }] : []),
			],
		};
	}
	if (type === 'search') {
		const term = textOf(raw.term, 100).toLowerCase();
		if (term === '') return null;
		const results = Number.isSafeInteger(raw.results) && raw.results >= 0 ? raw.results : null;
		return {
			type,
			path,
			data: { term, results },
			totals: [
				{ metric: 'search', key: term, count: 1, sum: 0 },
				...(results === 0 ? [{ metric: 'search_empty', key: term, count: 1, sum: 0 }] : []),
			],
		};
	}
	if (type === 'not_found') return { type, path, data: {}, totals: [{ metric: 'not_found', key: path, count: 1, sum: 0 }] };
	// a Web Vital (CLS arrives × 1000, the others in milliseconds)
	if (typeof raw.name !== 'string' || !Object.hasOwn(VITALS, raw.name)) return null;
	const name = /** @type {VitalName} */ (raw.name);
	if (typeof raw.value !== 'number' || !Number.isFinite(raw.value) || raw.value < 0 || raw.value > 600_000) return null;
	const value = Math.round(raw.value);
	const rating = ratingOf(name, value);
	return {
		type,
		path,
		data: { name, value, rating },
		totals: [
			{ metric: 'vital', key: `${name}:${rating}`, count: 1, sum: 0 },
			{ metric: 'vital_value', key: name, count: 1, sum: value },
		],
	};
};

/**
 * A `POST /v1/collect` body, checked: the kept events of switched-on features (at most {@link MAX_BATCH}; the rest and
 * the invalid ones are dropped, as a beacon has nobody to tell).
 * @param {unknown} body
 * @param {{ on: ReadonlyArray<string>, domain: string, country: string | null, sessions?: boolean, city?: string | null }} context
 * @returns {KeptEvent[]}
 */
export const checkBatch = (body, { on, ...context }) => {
	const list = isObject(body) && Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];
	/** @type {KeptEvent[]} */
	const kept = [];
	for (const raw of list) {
		const event = checkEvent(raw, context);
		if (event && on.includes(EVENT_FEATURES[event.type])) kept.push(event);
	}
	return kept;
};

/**
 * The day of a time in the business time zone, `YYYY-MM-DD`: the key of the daily totals (PLAN 0.8.10 K8, always).
 * @param {number} at
 * @param {string | null | undefined} timeZone the business.json time zone (UTC when missing or unknown)
 */
export const dayOf = (at, timeZone) => zonedDay(at, timeZone);

/**
 * The increments of a batch merged per metric and key (one database write each).
 * @param {KeptEvent[]} events
 * @returns {Array<{ metric: string, key: string, count: number, sum: number }>}
 */
export const mergeTotals = (events) => {
	/** @type {Map<string, { metric: string, key: string, count: number, sum: number }>} */
	const merged = new Map();
	for (const event of events)
		for (const total of event.totals) {
			const id = `${total.metric}\n${total.key}`;
			const found = merged.get(id);
			if (found) {
				found.count += total.count;
				found.sum += total.sum;
			} else merged.set(id, { ...total });
		}
	return [...merged.values()];
};

/**
 * When a raw event kept now expires (the retention in months).
 * @param {number} at
 * @param {number} months
 */
export const expiryOf = (at, months) => {
	const date = new Date(at);
	date.setUTCMonth(date.getUTCMonth() + months);
	return date;
};
