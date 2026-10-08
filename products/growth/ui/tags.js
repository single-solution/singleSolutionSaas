/**
 * The merchant's tags in the page (PLAN 0.8.9): Google Consent Mode v2 set to denied before anything else, then each
 * tag loaded only once the visitor consents to its category — Google Analytics 4 and the analytics scripts after
 * analytics; the Meta pixel, the TikTok pixel, Google Ads and the marketing scripts after marketing; the Tag Manager
 * container after either (Consent Mode tells its tags what was granted). Consent changes update Consent Mode. Shop
 * events go to the pixels that are loaded.
 * @module
 */
import { consentMode, granted } from '../core/consent.js';
import { pixelCalls } from '../core/pixels.js';

/** @typedef {import('../core/config.js').Tags} Tags */
/** @typedef {import('../core/consent.js').Choice} Choice */

/**
 * The pasted scripts of one category added to the page: each `<script>` re-created so it runs, anything else (for
 * example a `<noscript>` image) added as it is; plain JavaScript without tags runs as one script.
 * @param {Document} doc
 * @param {string} pasted
 */
export const injectScripts = (doc, pasted) => {
	const template = doc.createElement('template');
	template.innerHTML = /<[a-z!]/i.test(pasted) ? pasted : `<script>${pasted}</script>`;
	for (const node of [...template.content.childNodes]) {
		if (node.nodeName === 'SCRIPT') {
			const source = /** @type {HTMLScriptElement} */ (node);
			const script = doc.createElement('script');
			for (const attribute of [...source.attributes]) script.setAttribute(attribute.name, attribute.value);
			script.textContent = source.textContent;
			doc.head.append(script);
		} else if (node.nodeType === 1) doc.body.append(node);
	}
};

/**
 * @param {{ window: Window & typeof globalThis, tags: Tags }} input
 */
export const createTags = ({ window: win, tags }) => {
	const doc = win.document;
	const w = /** @type {any} */ (win);
	const google = tags.ga4 !== null || tags.ads !== null || tags.gtm !== null;
	/** @type {Set<string>} */
	const loaded = new Set();

	/** @param {string} src */
	const load = (src) => {
		const script = doc.createElement('script');
		script.async = true;
		script.src = src;
		doc.head.append(script);
	};

	if (google) {
		// Consent Mode v2: everything denied until the visitor chooses (no request is made by this)
		w.dataLayer = w.dataLayer ?? [];
		w.gtag =
			w.gtag ??
			function gtag() {
				// gtag.js reads the arguments object itself
				w.dataLayer.push(arguments);
			};
		w.gtag('consent', 'default', { ...consentMode(null), wait_for_update: 500 });
	}

	/** @param {string} id */
	const loadGtag = (id) => {
		if (!loaded.has('gtag')) {
			loaded.add('gtag');
			load(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
			w.gtag('js', new Date());
		}
		w.gtag('config', id);
	};

	const loadMeta = () => {
		if (!w.fbq) {
			/** @type {any} */
			const fbq = (/** @type {unknown[]} */ ...args) => (fbq.callMethod ? fbq.callMethod(...args) : fbq.queue.push(args));
			fbq.push = fbq;
			fbq.loaded = true;
			fbq.version = '2.0';
			fbq.queue = [];
			w.fbq = fbq;
			w._fbq = w._fbq ?? fbq;
		}
		load('https://connect.facebook.net/en_US/fbevents.js');
		w.fbq('init', tags.meta);
		w.fbq('track', 'PageView');
	};

	const loadTikTok = () => {
		const id = String(tags.tiktok);
		w.TiktokAnalyticsObject = 'ttq';
		const ttq = (w.ttq = w.ttq ?? []);
		const methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group'];
		for (const method of methods)
			ttq[method] =
				ttq[method] ??
				((/** @type {unknown[]} */ ...args) => {
					ttq.push([method, ...args]);
				});
		ttq._i = ttq._i ?? {};
		ttq._i[id] = [];
		ttq._t = { ...ttq._t, [id]: Date.now() };
		ttq._o = { ...ttq._o, [id]: {} };
		load(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(id)}&lib=ttq`);
		ttq.page();
	};

	/**
	 * Load what the choice now allows (each tag once) and update Consent Mode.
	 * @param {Choice | null} choice
	 */
	const apply = (choice) => {
		if (choice === null) return;
		if (google) w.gtag('consent', 'update', consentMode(choice));
		const analytics = granted(choice, 'analytics');
		const marketing = granted(choice, 'marketing');
		/** @param {string} name @param {boolean} allowed @param {() => void} start */
		const once = (name, allowed, start) => {
			if (!allowed || loaded.has(name)) return;
			loaded.add(name);
			start();
		};
		if (tags.gtm !== null)
			once('gtm', analytics || marketing, () => {
				w.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
				load(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(String(tags.gtm))}`);
			});
		if (tags.ga4 !== null) once('ga4', analytics, () => loadGtag(String(tags.ga4)));
		if (tags.ads !== null) once('ads', marketing, () => loadGtag(String(tags.ads)));
		if (tags.meta !== null) once('meta', marketing, loadMeta);
		if (tags.tiktok !== null) once('tiktok', marketing, loadTikTok);
		if (tags.scripts.analytics) once('scripts.analytics', analytics, () => injectScripts(doc, tags.scripts.analytics));
		if (tags.scripts.marketing) once('scripts.marketing', marketing, () => injectScripts(doc, tags.scripts.marketing));
	};

	/**
	 * Pass a shop event to the loaded pixels.
	 * @param {import('../core/pixels.js').Step} step
	 * @param {import('../core/pixels.js').Detail} detail
	 */
	const forward = (step, detail) => {
		const calls = pixelCalls(step, detail, {
			meta: loaded.has('meta'),
			google: loaded.has('ga4') || loaded.has('ads') || loaded.has('gtm'),
			ads:
				loaded.has('ads') && tags.ads !== null && tags.adsPurchaseLabel !== null
					? { id: tags.ads, label: tags.adsPurchaseLabel }
					: null,
			tiktok: loaded.has('tiktok'),
		});
		// a pixel the page removed since is skipped
		const send = {
			meta: typeof w.fbq === 'function' ? w.fbq : null,
			google: typeof w.gtag === 'function' ? w.gtag : null,
			tiktok: typeof w.ttq?.track === 'function' ? (/** @type {unknown[]} */ ...args) => w.ttq.track(...args) : null,
		};
		for (const call of calls) send[call.vendor]?.(...call.args);
	};

	return Object.freeze({ apply, forward, loaded: () => [...loaded] });
};
