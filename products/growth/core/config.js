/**
 * What the page script needs for a website (the kit's `GET /v1/widget/config` → `settings`; PLAN 0.8.9): the consent
 * banner's place, privacy link and how many months a choice holds, what to record and whether it waits for consent, the merchant's tag ids (each
 * checked; a malformed id is left out, so nothing broken is loaded), the custom scripts per consent category, and the
 * notice bar while its dates say it is on. Only switched-on features are given; never a secret (tag ids and the
 * merchant's own scripts are public in any page that loads them).
 * @module
 */
import { pathMatches } from '@ss/contracts/text';
import { consentMonthsOf } from './consent.js';
import { readList } from './lists.js';
import { isIndexNowKey, keyLocationOf } from './seo.js';
import { BANNER_POSITIONS } from './widgets.js';

/** The shape of each tag id. */
const TAG_IDS = Object.freeze({
	meta: /^\d{6,20}$/,
	ga4: /^G-[A-Z0-9]{4,20}$/,
	ads: /^AW-\d{5,15}$/,
	adsLabel: /^[A-Za-z0-9_-]{4,40}$/,
	gtm: /^GTM-[A-Z0-9]{4,12}$/,
	tiktok: /^[A-Z0-9]{10,30}$/,
});

/** @typedef {Record<string, Record<string, unknown>>} FeatureValues settings of each switched-on feature */

/**
 * A setting as trimmed text.
 * @param {FeatureValues} values
 * @param {string} feature
 * @param {string} name
 */
const text = (values, feature, name) => {
	const value = values[feature]?.[name];
	return typeof value === 'string' ? value.trim() : '';
};

/**
 * A tag id when it has the right shape, else null.
 * @param {string} value
 * @param {RegExp} shape
 */
const idOf = (value, shape) => (shape.test(value) ? value : null);

/**
 * A link a widget may show: an https address or a path on the website, else null.
 * @param {string} value
 * @returns {string | null}
 */
export const linkOf = (value) => {
	if (value.startsWith('/') && !value.startsWith('//') && !/\s/.test(value)) return value;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
};

/**
 * The query parameters that hold a site search (the setting Search query parameters, for example `q, s, search`), at
 * most 10; an empty setting names none.
 * @param {string} value
 */
export const searchParamsOf = (value) =>
	value
		.split(/[\s,]+/)
		.filter((name) => /^[A-Za-z0-9_.-]{1,40}$/.test(name))
		.slice(0, 10);

/**
 * A time setting (ISO 8601), or undefined when empty, or NaN when it is not a time.
 * @param {string} value
 */
const timeOf = (value) => (value === '' ? undefined : Date.parse(value));

/** Most `hideOnPages` patterns read (settings schemas have no list limit). */
const MAX_HIDDEN_PAGES = 50;

/**
 * The `hideOnPages` patterns of the notice bar (G6): path patterns only, at most {@link MAX_HIDDEN_PAGES}.
 * @param {unknown} value
 * @returns {string[]}
 */
export const hiddenPagesOf = (value) =>
	(Array.isArray(value) ? value : [])
		.filter((pattern) => typeof pattern === 'string' && pattern.trim().startsWith('/'))
		.map((pattern) => String(pattern).trim())
		.slice(0, MAX_HIDDEN_PAGES);

/**
 * The notice bar now: its text and link while it is shown (the `enabled` setting, AO-2) and the dates say it is on
 * (checked on use), how long a closed bar stays closed and the pages it is hidden on (PLAN 0.8.10 G6), else null.
 * @param {FeatureValues} values
 * @param {number} now
 * @returns {{ text: string, linkUrl: string | null, linkText: string, dismissible: boolean,
 *   dismissFor: 'visit' | 'page', hideOnPages: string[] } | null}
 */
export const noticeOf = (values, now) => {
	// switched off by the merchant (AO-2): the text and dates are kept
	if (values.notice_bar?.enabled === false) return null;
	const message = text(values, 'notice_bar', 'text');
	if (message === '') return null;
	const startsAt = timeOf(text(values, 'notice_bar', 'startsAt'));
	const endsAt = timeOf(text(values, 'notice_bar', 'endsAt'));
	if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return null;
	if ((startsAt !== undefined && now < startsAt) || (endsAt !== undefined && now >= endsAt)) return null;
	const linkUrl = linkOf(text(values, 'notice_bar', 'linkUrl'));
	return {
		text: message,
		linkUrl,
		linkText: linkUrl === null ? '' : text(values, 'notice_bar', 'linkText'),
		dismissible: values.notice_bar?.dismissible !== false,
		dismissFor: values.notice_bar?.dismissFor === 'page' ? 'page' : 'visit',
		hideOnPages: hiddenPagesOf(values.notice_bar?.hideOnPages),
	};
};

/**
 * Whether the notice bar is hidden on a page: one of its `hideOnPages` patterns matches the page's path (the patterns
 * of `@ss/contracts/text` `pathMatches`: `*` inside one segment, `**` any number of segments).
 * @param {{ hideOnPages: ReadonlyArray<string> }} notice
 * @param {string} path
 */
export const noticeHiddenOn = (notice, path) => notice.hideOnPages.some((pattern) => pathMatches(pattern, path));

/**
 * What `GET /v1/notice` answers for custom UIs (G6): the notice bar now, or null — also null on a page it is hidden on
 * when the page's `path` is given.
 * @param {FeatureValues} values
 * @param {number} now
 * @param {unknown} path
 * @returns {{ text: string, linkText: string, linkUrl: string | null, dismissible: boolean } | null}
 */
export const noticeAnswer = (values, now, path) => {
	const notice = noticeOf(values, now);
	if (notice === null) return null;
	if (typeof path === 'string' && noticeHiddenOn(notice, path)) return null;
	return { text: notice.text, linkText: notice.linkText, linkUrl: notice.linkUrl, dismissible: notice.dismissible };
};

/**
 * The merchant's tags of switched-on features (malformed ids left out), and how they load (PLAN 0.8.10 G1): whether
 * they wait for consent (the `tags` shared setting `consentRequired`, true unless the merchant turns it off) and
 * whether Google Analytics 4 runs inside the Tag Manager container (`ga4ViaGtm`: Growth then does not load it); which
 * item ids the pixels get (the `pixels` shared setting `contentIds`, G2: the product's, or the variant's) and whether a
 * search found in the page address goes to them (`searchFromUrl`, SG-38: true unless the merchant turns it off).
 * @param {ReadonlyArray<string>} on
 * @param {FeatureValues} values
 * @param {ReadonlyArray<Record<string, unknown>>} [categories] the consent categories (their scripts, G3)
 */
export const tagsOf = (on, values, categories = []) => {
	const google = on.includes('google_tags');
	const adsId = google ? idOf(text(values, 'google_tags', 'adsId'), TAG_IDS.ads) : null;
	return {
		consentRequired: values.tags?.consentRequired !== false,
		ga4ViaGtm: google && values.google_tags?.ga4ViaGtm === true,
		contentIds: values.pixels?.contentIds === 'variant' ? /** @type {const} */ ('variant') : /** @type {const} */ ('product'),
		searchFromUrl: values.pixels?.searchFromUrl !== false,
		meta: on.includes('meta_pixel') ? idOf(text(values, 'meta_pixel', 'pixelId'), TAG_IDS.meta) : null,
		ga4: google ? idOf(text(values, 'google_tags', 'ga4Id'), TAG_IDS.ga4) : null,
		ads: adsId,
		adsPurchaseLabel: adsId ? idOf(text(values, 'google_tags', 'adsPurchaseLabel'), TAG_IDS.adsLabel) : null,
		gtm: google ? idOf(text(values, 'google_tags', 'gtmId'), TAG_IDS.gtm) : null,
		tiktok: on.includes('tiktok_pixel') ? idOf(text(values, 'tiktok_pixel', 'pixelId'), TAG_IDS.tiktok) : null,
		// each consent category's own scripts (G3), while Custom scripts is on
		scripts: on.includes('custom_scripts')
			? Object.fromEntries(
					categories
						.filter((category) => typeof category.scripts === 'string' && category.scripts.trim() !== '')
						.map((category) => [String(category.key), String(category.scripts).trim()]),
				)
			: {},
	};
};

/** @typedef {ReturnType<typeof tagsOf>} Tags */

/**
 * Tags set and well formed, per tag feature (for the dashboard's Overview).
 * @param {ReadonlyArray<string>} on
 * @param {FeatureValues} values
 * @returns {{ ready: number, total: number }}
 */
export const tagsReady = (on, values, categories = readList('consent_categories', undefined)) => {
	const tags = tagsOf(on, values, categories);
	const checks = [
		on.includes('meta_pixel') ? tags.meta !== null : null,
		on.includes('google_tags') ? (tags.ga4 !== null && !tags.ga4ViaGtm) || tags.ads !== null || tags.gtm !== null : null,
		on.includes('tiktok_pixel') ? tags.tiktok !== null : null,
		on.includes('custom_scripts') ? Object.keys(tags.scripts).length > 0 : null,
	].filter((check) => check !== null);
	return { ready: checks.filter(Boolean).length, total: checks.length };
};

/**
 * What the admin widgets also show (never to visitors): the pages the SEO checklist checks by default (paths; the home
 * page first), where the merchant's site serves the IndexNow key and, with Visitor analytics, how long raw events are
 * kept (null without it).
 * @param {ReadonlyArray<string>} on
 * @param {FeatureValues} values
 * @param {string} domain
 */
export const adminSettings = (on, values, domain) => {
	const paths = values.seo_checklist?.paths;
	const listed = (Array.isArray(paths) ? paths : []).filter(
		(path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/\s/.test(path),
	);
	const key = text(values, 'indexnow', 'key');
	return {
		seoPages: [...new Set(['/', ...listed.map(String)])].slice(0, 20),
		indexNow: on.includes('indexnow')
			? {
					keySet: isIndexNowKey(key),
					keyLocation: keyLocationOf({ key: key || '<key>', keyPath: values.indexnow?.keyPath }, domain),
				}
			: null,
		retentionMonths: on.includes('visitor_analytics') ? Number(values.visitor_analytics?.retentionMonths) : null,
	};
};

/**
 * The merchant's lists the page script needs (each as `readList` gives it; a list left out reads as its defaults).
 * @typedef {{ consent_categories?: any[], announcements?: any[], conversion_actions?: any[], goals?: any[], funnels?: any[] }} PageLists
 */

/**
 * The page script's settings; with `admin` (the admin widgets' config, PLAN 0.4.5) also {@link adminSettings}.
 * @param {{ on: ReadonlyArray<string>, values: FeatureValues, now: number, admin?: { domain: string } | null,
 *   lists?: PageLists }} input `lists`: the merchant's lists (consent categories …)
 */
export const widgetSettings = ({ on, values, now, admin = null, lists = {} }) => {
	const analytics = values.visitor_analytics ?? {};
	const categories = lists.consent_categories ?? readList('consent_categories', undefined);
	return {
		admin: admin ? adminSettings(on, values, admin.domain) : null,
		consent: {
			banner: on.includes('consent_banner'),
			// G7: a bar at the bottom or top, a dialog in the middle, or a corner box
			position: BANNER_POSITIONS.includes(String(values.consent_banner?.position))
				? String(values.consent_banner?.position)
				: 'bottom',
			privacyUrl: on.includes('consent_banner') ? linkOf(text(values, 'consent_banner', 'privacyUrl')) : null,
			// G6: a kept choice is asked again after the merchant's months (also with their own consent tool)
			askAgainMonths: consentMonthsOf(values.consent_banner?.askAgainMonths),
			// G3: the merchant's categories (their scripts go with the tags)
			categories: categories.map(({ key, name, description, mode, signals }) => ({ key, name, description, mode, signals })),
		},
		record: {
			visits: on.includes('visitor_analytics'),
			funnel: on.includes('conversion_funnel'),
			searches: on.includes('searches_404s'),
			// kept in the merchant's analytics only with Visitor analytics; to Google Analytics also without it (SG-27)
			vitals: on.includes('web_vitals') && on.includes('visitor_analytics'),
			vitalsToGa4: on.includes('web_vitals') && values.web_vitals?.toGa4 === true,
			requireConsent: analytics.requireConsent !== false,
			sessions: on.includes('visitor_analytics') && analytics.detail === 'sessions',
			searchParams: searchParamsOf(text(values, 'searches_404s', 'searchParams')),
		},
		tags: tagsOf(on, values, categories),
		notice: on.includes('notice_bar') ? noticeOf(values, now) : null,
	};
};

/** @typedef {ReturnType<typeof widgetSettings>} WidgetSettings */
