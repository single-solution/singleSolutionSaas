/**
 * What the page script needs for a website (the kit's `GET /v1/widget/config` → `settings`; PLAN 0.8.9): the consent
 * banner's place and privacy link, what to record and whether it waits for consent, the merchant's tag ids (each
 * checked; a malformed id is left out, so nothing broken is loaded), the custom scripts per consent category, and the
 * notice bar while its dates say it is on. Only switched-on features are given; never a secret (tag ids and the
 * merchant's own scripts are public in any page that loads them).
 * @module
 */

/** The shape of each tag id. */
const TAG_IDS = Object.freeze({
	meta: /^\d{6,20}$/,
	ga4: /^G-[A-Z0-9]{4,20}$/,
	ads: /^AW-\d{5,15}$/,
	adsLabel: /^[A-Za-z0-9_-]{4,40}$/,
	gtm: /^GTM-[A-Z0-9]{4,12}$/,
	tiktok: /^[A-Z0-9]{10,30}$/,
});

/** Search parameters read when the merchant names none. */
const DEFAULT_SEARCH_PARAMS = Object.freeze(['q', 's', 'search', 'query']);

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
 * The query parameters that hold a site search (`q, s, search`), at most 10.
 * @param {string} value
 */
export const searchParamsOf = (value) => {
	const names = value
		.split(/[\s,]+/)
		.filter((name) => /^[A-Za-z0-9_.-]{1,40}$/.test(name))
		.slice(0, 10);
	return names.length > 0 ? names : [...DEFAULT_SEARCH_PARAMS];
};

/**
 * A time setting (ISO 8601), or undefined when empty, or NaN when it is not a time.
 * @param {string} value
 */
const timeOf = (value) => (value === '' ? undefined : Date.parse(value));

/** Most `hideOnPages` patterns read (settings schemas have no list limit). */
const MAX_HIDDEN_PAGES = 50;

/**
 * Whether a page's path matches a path pattern: an exact path, `*` one segment, `**` any number of segments (the query
 * string and fragment are ignored; `/` is the home page).
 * @param {string} pattern
 * @param {string} path
 */
export const pathMatches = (pattern, path) => {
	const split = (/** @type {string} */ value) =>
		(value.split(/[?#]/)[0] ?? '').split('/').filter((segment) => segment.length > 0);
	const p = split(pattern.trim());
	const s = split(path);
	/** @param {number} i @param {number} j @returns {boolean} */
	const match = (i, j) => {
		if (i === p.length) return j === s.length;
		const part = p[i];
		if (part === '**') return match(i + 1, j) || (j < s.length && match(i, j + 1));
		if (j === s.length) return false;
		return (part === '*' || part === s[j]) && match(i + 1, j + 1);
	};
	return pattern.trim().startsWith('/') && match(0, 0);
};

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
 * The notice bar now: its text and link while the dates say it is on (checked on use), how long a closed bar stays
 * closed and the pages it is hidden on (PLAN 0.8.10 G6), else null.
 * @param {FeatureValues} values
 * @param {number} now
 * @returns {{ text: string, linkUrl: string | null, linkText: string, dismissible: boolean,
 *   dismissFor: 'visit' | 'page', hideOnPages: string[] } | null}
 */
export const noticeOf = (values, now) => {
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
	if (typeof path === 'string' && notice.hideOnPages.some((pattern) => pathMatches(pattern, path))) return null;
	return { text: notice.text, linkText: notice.linkText, linkUrl: notice.linkUrl, dismissible: notice.dismissible };
};

/**
 * The merchant's tags of switched-on features (malformed ids left out), and how they load (PLAN 0.8.10 G1): whether
 * they wait for consent (the `tags` shared setting `consentRequired`, true unless the merchant turns it off) and
 * whether Google Analytics 4 runs inside the Tag Manager container (`ga4ViaGtm`: Growth then does not load it); and
 * which item ids the pixels get (the `pixels` shared setting `contentIds`, G2: the product's, or the variant's).
 * @param {ReadonlyArray<string>} on
 * @param {FeatureValues} values
 */
export const tagsOf = (on, values) => {
	const google = on.includes('google_tags');
	const adsId = google ? idOf(text(values, 'google_tags', 'adsId'), TAG_IDS.ads) : null;
	return {
		consentRequired: values.tags?.consentRequired !== false,
		ga4ViaGtm: google && values.google_tags?.ga4ViaGtm === true,
		contentIds: values.pixels?.contentIds === 'variant' ? /** @type {const} */ ('variant') : /** @type {const} */ ('product'),
		meta: on.includes('meta_pixel') ? idOf(text(values, 'meta_pixel', 'pixelId'), TAG_IDS.meta) : null,
		ga4: google ? idOf(text(values, 'google_tags', 'ga4Id'), TAG_IDS.ga4) : null,
		ads: adsId,
		adsPurchaseLabel: adsId ? idOf(text(values, 'google_tags', 'adsPurchaseLabel'), TAG_IDS.adsLabel) : null,
		gtm: google ? idOf(text(values, 'google_tags', 'gtmId'), TAG_IDS.gtm) : null,
		tiktok: on.includes('tiktok_pixel') ? idOf(text(values, 'tiktok_pixel', 'pixelId'), TAG_IDS.tiktok) : null,
		scripts: on.includes('custom_scripts')
			? {
					analytics: text(values, 'custom_scripts', 'analyticsScripts'),
					marketing: text(values, 'custom_scripts', 'marketingScripts'),
				}
			: { analytics: '', marketing: '' },
	};
};

/** @typedef {ReturnType<typeof tagsOf>} Tags */

/**
 * Tags set and well formed, per tag feature (for the dashboard's Overview).
 * @param {ReadonlyArray<string>} on
 * @param {FeatureValues} values
 * @returns {{ ready: number, total: number }}
 */
export const tagsReady = (on, values) => {
	const tags = tagsOf(on, values);
	const checks = [
		on.includes('meta_pixel') ? tags.meta !== null : null,
		on.includes('google_tags') ? (tags.ga4 !== null && !tags.ga4ViaGtm) || tags.ads !== null || tags.gtm !== null : null,
		on.includes('tiktok_pixel') ? tags.tiktok !== null : null,
		on.includes('custom_scripts') ? tags.scripts.analytics !== '' || tags.scripts.marketing !== '' : null,
	].filter((check) => check !== null);
	return { ready: checks.filter(Boolean).length, total: checks.length };
};

/**
 * The page script's settings.
 * @param {{ on: ReadonlyArray<string>, values: FeatureValues, now: number }} input
 */
export const widgetSettings = ({ on, values, now }) => {
	const analytics = values.visitor_analytics ?? {};
	return {
		consent: {
			banner: on.includes('consent_banner'),
			position: values.consent_banner?.position === 'top' ? 'top' : 'bottom',
			privacyUrl: on.includes('consent_banner') ? linkOf(text(values, 'consent_banner', 'privacyUrl')) : null,
		},
		record: {
			visits: on.includes('visitor_analytics'),
			funnel: on.includes('conversion_funnel'),
			searches: on.includes('searches_404s'),
			vitals: on.includes('web_vitals'),
			vitalsToGa4: on.includes('web_vitals') && values.web_vitals?.toGa4 === true,
			requireConsent: analytics.requireConsent !== false,
			sessions: on.includes('visitor_analytics') && analytics.detail === 'sessions',
			searchParams: searchParamsOf(text(values, 'searches_404s', 'searchParams')),
		},
		tags: tagsOf(on, values),
		notice: on.includes('notice_bar') ? noticeOf(values, now) : null,
	};
};

/** @typedef {ReturnType<typeof widgetSettings>} WidgetSettings */
