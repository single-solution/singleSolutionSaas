/**
 * The page script (PLAN 0.4.10, 0.8.9). `widget.js` is the same for every website. With `data-token` on its script
 * tag (the website's browser token) it fetches the website's widget config and, following the switched-on features:
 * keeps the visitor's consent (the banner, or `SSGrowth.consent.set()` from the merchant's own tool), loads the tags
 * once their category is granted, shows the notice bar, records anonymous analytics (page views, searches, 404s, Web
 * Vitals) and the shop events (`ss:view_item`, `ss:add_to_cart`, `ss:begin_checkout`, `ss:purchase`), which it also
 * passes to the loaded pixels. It listens for the shop events from the moment it runs and keeps them until the config
 * is there. Without `data-token` (the merchant's admin pages) it only offers `window.SSGrowth.admin({ getTicket })`,
 * which mounts the admin widgets of switched-on features: `analytics_dashboard` and `seo_checklist`. Nothing renders
 * while the product is stopped, its features are off or the merchant database is not connected.
 * @module
 */
import { viewerOf } from '@ss/app-kit/widget';
import { granted } from '../core/consent.js';
import { detailOf, funnelEvent } from '../core/pixels.js';
import { BROWSER_EVENTS, WIDGET_ATTRIBUTE, WIDGET_FEATURES, WIDGET_GLOBAL } from '../core/widgets.js';
import { mountAnalyticsDashboard } from './analytics-dashboard.js';
import { createCollector, markedNotFound, pageView, searchOnPage, watchVitals } from './collect.js';
import { createConsent, mountConsentBanner, storageOf } from './consent.js';
import { NOTICE_STORAGE_KEY, mountNoticeBar } from './notice-bar.js';
import { mountSeoChecklist } from './seo-checklist.js';
import { createTags } from './tags.js';
import { createTicketSource } from './tickets.js';

/** The kit's widget config routes (browser token; ticket). */
export const CONFIG_PATH = '/v1/widget/config';
export const ADMIN_CONFIG_PATH = '/v1/widget/admin/config';

/**
 * The website's widget config, from the kit.
 * @typedef {object} WidgetConfig
 * @property {Record<string, string>} texts the widget texts (the website's own, else the defaults)
 * @property {import('@ss/app-kit/widget').WidgetTheme} theme
 * @property {string} customCss
 * @property {Partial<import('@ss/contracts/format').Format>} format how money and dates look (PLAN 0.8.10 K7)
 * @property {string} timeZone the business.json time zone (UTC without it; K8)
 * @property {string[]} features the switched-on features
 * @property {import('../core/config.js').WidgetSettings} settings what the page script needs
 */

/** The browser's language and time zone, for a Format that leaves them to the viewer. @typedef {ReturnType<typeof viewerOf>} Viewer */

/**
 * @param {typeof globalThis.fetch} request
 * @param {string} url
 * @param {string} credential browser token or ticket
 * @returns {Promise<WidgetConfig | null>} null when the product says no (stopped, database not connected …)
 */
const loadConfig = async (request, url, credential) => {
	try {
		const response = await request(url, { headers: { authorization: `Bearer ${credential}` } });
		return response.ok ? /** @type {WidgetConfig} */ (await response.json()) : null;
	} catch {
		return null;
	}
};

/**
 * @param {{ window: Window & typeof globalThis, script: HTMLScriptElement | null }} input
 */
export const startWidget = ({ window: win, script }) => {
	const doc = win.document;
	const base = new URL(script?.src ?? win.location.href).origin;
	const token = script?.dataset.token;
	const now = () => Date.now();
	/** @param {keyof typeof WIDGET_FEATURES} key */
	const hosts = (key) => /** @type {HTMLElement[]} */ ([...doc.querySelectorAll(`[${WIDGET_ATTRIBUTE}="${key}"]`)]);
	/** @type {typeof globalThis.fetch} */
	const request = (input, init) => win.fetch(input, init);
	/** @param {WidgetConfig} config @param {keyof typeof WIDGET_FEATURES} key */
	const on = (config, key) => WIDGET_FEATURES[key].some((feature) => config.features.includes(feature));
	/**
	 * A host element for a visitor widget: the one the merchant placed, else a new one.
	 * @param {keyof typeof WIDGET_FEATURES} key @param {'start' | 'end'} where
	 */
	const hostFor = (key, where) => {
		const placed = hosts(key)[0];
		if (placed) return placed;
		const created = doc.createElement('div');
		created.setAttribute(WIDGET_ATTRIBUTE, key);
		if (where === 'start') doc.body.prepend(created);
		else doc.body.append(created);
		return created;
	};

	const consent = createConsent({ storage: storageOf(win, 'localStorage'), now });
	const visits = storageOf(win, 'sessionStorage');
	/** @type {{ open: () => void } | null} */
	let banner = null;

	// the page's own calls before the config is there wait for it
	/** @type {Array<(ready: Ready) => void>} */
	let early = [];
	/** @typedef {{ config: WidgetConfig, collector: import('./collect.js').Collector, tags: ReturnType<typeof createTags> }} Ready */
	/** @type {Ready | null} */
	let current = null;
	/** @param {(ready: Ready) => void} task */
	const whenReady = (task) => {
		if (current) task(current);
		else if (early.length < 50) early.push(task);
	};
	const path = () => win.location.pathname;

	// shop events: listened for at once, recorded and passed to the pixels once the config is there
	for (const [name, step] of Object.entries(BROWSER_EVENTS))
		win.addEventListener(name, (event) => {
			const detail = detailOf(/** @type {CustomEvent} */ (event).detail);
			const at = path();
			whenReady(({ config, collector, tags }) => {
				const funnel = /** @type {import('../core/pixels.js').Step} */ (step);
				if (config.settings.record.funnel) collector.record(() => funnelEvent(funnel, detail, at));
				tags.forward(funnel, detail);
			});
		});

	const ready = (async () => {
		if (!token) return;
		const config = await loadConfig(request, `${base}${CONFIG_PATH}`, token);
		if (!config) return;
		const { record } = config.settings;
		const collector = createCollector({ base, token, fetch: request, schedule: (task, ms) => win.setTimeout(task, ms) });
		const tags = createTags({ window: win, tags: config.settings.tags });
		/** @param {import('../core/consent.js').Choice | null} choice */
		const follow = (choice) => {
			tags.apply(choice);
			collector.allow(!record.requireConsent || granted(choice, 'analytics'));
		};
		follow(consent.get());
		consent.onChange(follow);
		current = { config, collector, tags };

		if (on(config, 'consent_banner') && config.settings.consent.banner)
			banner = mountConsentBanner({ host: hostFor('consent_banner', 'end'), config, consent });
		const notice = config.settings.notice;
		if (on(config, 'notice_bar') && notice && visits.getItem(NOTICE_STORAGE_KEY) !== notice.text)
			mountNoticeBar({ host: hostFor('notice_bar', 'start'), config, visits });

		if (record.visits) collector.record(() => pageView({ window: win, visits, now }));
		if (record.searches) {
			const found = searchOnPage(win, record.searchParams);
			if (found) collector.record(() => found);
			if (markedNotFound(doc)) collector.record(() => ({ type: 'not_found', path: path() }));
		}
		if (record.vitals)
			watchVitals({
				window: win,
				report: (name, value) => {
					collector.record(() => ({ type: 'vital', path: path(), name, value }));
					collector.flush();
				},
			});
		const leave = () => {
			if (doc.visibilityState === 'hidden') collector.flush();
		};
		doc.addEventListener('visibilitychange', leave);
		win.addEventListener('pagehide', () => collector.flush());

		const waiting = early;
		early = [];
		for (const task of waiting) task(current);
	})();

	/** @param {{ getTicket: import('./tickets.js').GetTicket }} options */
	const admin = async ({ getTicket }) => {
		/** @type {import('./tickets.js').Ticket} */
		let first;
		try {
			first = await getTicket();
		} catch {
			return;
		}
		if (typeof first?.ticket !== 'string') return;
		const config = await loadConfig(request, `${base}${ADMIN_CONFIG_PATH}`, first.ticket);
		if (!config) return;
		const tickets = createTicketSource({
			first,
			getTicket,
			schedule: (task, ms) => win.setTimeout(task, ms),
			cancel: (id) => win.clearTimeout(id),
			now,
		});
		const api = { base, tickets, fetch: request };
		const viewer = viewerOf(win);
		if (on(config, 'analytics_dashboard'))
			for (const host of hosts('analytics_dashboard')) mountAnalyticsDashboard({ host, api, config, viewer, now });
		if (on(config, 'seo_checklist'))
			for (const host of hosts('seo_checklist')) mountSeoChecklist({ host, api, config, viewer });
	};

	const api = Object.freeze({
		admin,
		consent: Object.freeze({
			/** Open the banner's choices again (when the banner is on). */
			open: () => banner?.open(),
			/** @param {{ analytics?: unknown, marketing?: unknown }} picked the choice of the merchant's own consent tool */
			set: (picked) => consent.set(picked),
			get: () => consent.get(),
		}),
		/**
		 * Record a site search the page ran itself.
		 * @param {unknown} term @param {{ results?: number }} [options]
		 */
		search: (term, options = {}) => {
			const at = path();
			whenReady(({ config, collector }) => {
				if (config.settings.record.searches && typeof term === 'string' && term.trim() !== '')
					collector.record(() => ({
						type: 'search',
						path: at,
						term,
						...(Number.isSafeInteger(options.results) ? { results: options.results } : {}),
					}));
			});
		},
		/** Record this page as one that does not exist (404). */
		notFound: () => {
			const at = path();
			whenReady(({ config, collector }) => {
				if (config.settings.record.searches) collector.record(() => ({ type: 'not_found', path: at }));
			});
		},
	});
	Object.assign(win, { [WIDGET_GLOBAL]: api });
	return { ...api, ready };
};
