/**
 * Site-wide SEO (PLAN 0.8.9): the robots.txt the merchant's site serves (their rules plus their sitemaps), the
 * verification tags (Google, Bing, Meta, Yandex), IndexNow submissions (the merchant's key, URLs of the website's exact
 * domain) and the activity-log texts of a submission and of an SEO checklist run (the checks themselves are
 * `core/seo-checks.js`). Pure: the fetching is done by the caller.
 * @module
 */

/** URLs one IndexNow submission takes (the IndexNow limit). */
const MAX_INDEXNOW_URLS = 10_000;

/** The IndexNow endpoint every participating search engine shares. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

// ------------------------------------------------------------------------------------------------- robots and tags

/** The verification meta tags: setting → tag name (Yandex: PLAN 0.8.10 G4). */
const VERIFICATION_TAGS = Object.freeze({
	googleVerification: 'google-site-verification',
	bingVerification: 'msvalidate.01',
	metaVerification: 'facebook-domain-verification',
	yandexVerification: 'yandex-verification',
});

/** The verification meta tags' names. */
export const VERIFICATION_NAMES = Object.freeze(Object.values(VERIFICATION_TAGS));

/**
 * Crawlers that only collect AI training data (PLAN 0.8.10 G4: the list is kept in code). Search engines and AI
 * answer bots that cite pages (Googlebot, Bingbot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot) are
 * not on it.
 */
export const AI_TRAINING_CRAWLERS = Object.freeze([
	'GPTBot',
	'Google-Extended',
	'CCBot',
	'ClaudeBot',
	'anthropic-ai',
	'Applebot-Extended',
	'Bytespider',
	'meta-externalagent',
	'cohere-training-data-crawler',
]);

/**
 * A verification token from what the merchant pasted: the token itself, or the `content` of a pasted meta tag.
 * @param {unknown} value
 * @returns {string | null}
 */
export const tokenOf = (value) => {
	if (typeof value !== 'string') return null;
	const pasted = /content\s*=\s*["']([^"']*)["']/i.exec(value)?.[1] ?? value;
	const token = pasted.trim();
	return /^[A-Za-z0-9_.=-]{1,120}$/.test(token) ? token : null;
};

/**
 * The verification tags of the settings, as `{ name, content }` and as HTML for the page head.
 * @param {Record<string, unknown>} values the `robots_verification` settings
 */
export const verificationOf = (values) => {
	const tags = Object.entries(VERIFICATION_TAGS)
		.map(([setting, name]) => ({ name, content: tokenOf(values[setting]) }))
		.filter(/** @returns {tag is { name: string, content: string }} */ (tag) => tag.content !== null);
	return { tags, html: tags.map((tag) => `<meta name="${tag.name}" content="${tag.content}">`).join('\n') };
};

/**
 * An https URL on the website's exact domain, or null.
 * @param {unknown} value
 * @param {string} domain
 */
export const siteUrlOf = (value, domain) => {
	if (typeof value !== 'string' || value.length > 2048) return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.hostname === domain && url.port === '' && url.username === ''
			? url.toString()
			: null;
	} catch {
		return null;
	}
};

/**
 * The sitemaps robots.txt names: each sitemap URL set on the website's domain (at most 50); with none set, the
 * website's `/sitemap.xml` (where Ecommerce's sitemap route serves it, SEO audit G8), so search engines find it.
 * @param {Record<string, unknown>} values the `robots_verification` settings
 * @param {string} domain
 */
const sitemapUrlsOf = (values, domain) => {
	const listed = Array.isArray(values.sitemaps) ? values.sitemaps : [];
	return (listed.length > 0 ? listed : [`https://${domain}/sitemap.xml`])
		.map((url) => siteUrlOf(url, domain))
		.filter((url) => url !== null)
		.slice(0, 50);
};

/** Most sort and filter parameters, and most private pages, robots.txt keeps out (settings schemas have no list limit). */
const MAX_PRESETS = 20;

/**
 * The query parameters of sorted and filtered lists robots.txt keeps out (G12): names of letters, digits, `_`, `.` and
 * `-` separated by commas or spaces, a final `*` for every parameter that starts with the name (`attr.*`), at most
 * {@link MAX_PRESETS}.
 * @param {unknown} value the `blockParameters` setting
 * @returns {string[]}
 */
const blockedParametersOf = (value) =>
	typeof value === 'string'
		? [...new Set(value.split(/[\s,]+/).filter((name) => /^[A-Za-z0-9_.-]{1,40}\*?$/.test(name)))].slice(0, MAX_PRESETS)
		: [];

/**
 * The private pages robots.txt keeps out (G12): paths from `/` without patterns (`*`, `$`), a query, a fragment or
 * spaces, the trailing slash dropped, letters outside ASCII percent-encoded (NFC); never `/` (the whole site) nor a
 * path that would keep out a sitemap; at most {@link MAX_PRESETS}.
 * @param {unknown} value the `blockPaths` setting
 * @param {string[]} sitemapPaths the paths of the sitemaps robots.txt names
 * @returns {string[]}
 */
const blockedPathsOf = (value, sitemapPaths) => {
	/** @type {string[]} */
	const paths = [];
	for (const raw of Array.isArray(value) ? value : []) {
		const text = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
		// eslint-disable-next-line no-control-regex
		if (!/^\/[^/]/.test(text) || /[*$?#\s\u0000-\u001f\u007f]/.test(text)) continue;
		const path = text.normalize('NFC').replace(/[^\u0021-\u007e]/gu, (char) => encodeURIComponent(char));
		/** @param {string} other */
		const covers = (other) => other === path || other.startsWith(`${path}/`) || other.startsWith(`${path}?`);
		if (!sitemapPaths.some(covers) && !paths.includes(path)) paths.push(path);
	}
	return paths.slice(0, MAX_PRESETS);
};

/**
 * The robots.txt presets (SEO audit G12; Google: keep crawlers out of pages that need no indexing, such as internal
 * search results and sorted or filtered lists, rather than relying on noindex or canonical links): `Disallow:` lines for
 * addresses with a search parameter of Searches and 404s (`blockSearchPages`), a sort or filter parameter
 * (`blockParameters`), and the private pages (`blockPaths`: the page, the pages under it and its query strings, never
 * a longer name: `/cart` keeps out `/cart`, `/cart/…` and `/cart?…`, never `/cartoons`). They name no product,
 * category, image or sitemap address by themselves; the merchant matches them to the storefront's own names.
 * @param {Record<string, unknown>} values the `robots_verification` settings
 * @param {string} domain
 * @param {ReadonlyArray<string>} searchParams the search parameters of Searches and 404s
 * @returns {string[]}
 */
export const robotsPresetsOf = (values, domain, searchParams) => {
	const names = [
		...(values.blockSearchPages === true ? searchParams : []),
		...blockedParametersOf(values.blockParameters),
	].filter((name, at, all) => all.indexOf(name) === at);
	const sitemapPaths = sitemapUrlsOf(values, domain).map((url) => pathOfUrl(url));
	return [
		...names.flatMap((name) => {
			const start = name.endsWith('*') ? name.slice(0, -1) : `${name}=`;
			return [`Disallow: /*?${start}`, `Disallow: /*&${start}`];
		}),
		...blockedPathsOf(values.blockPaths, sitemapPaths).flatMap((path) => [
			`Disallow: ${path}$`,
			`Disallow: ${path}/`,
			`Disallow: ${path}?`,
		]),
	];
};

/**
 * A robots.txt line's field (lower case) and value, comments left out; null for a line without one.
 * @param {string} line
 */
export const robotsDirectiveOf = (line) => {
	const text = (line.split('#')[0] ?? '').trim();
	const colon = text.indexOf(':');
	return colon < 1 ? null : { field: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim() };
};

/**
 * The merchant's rules with the presets in every group, right after its user-agent lines (before its first rule, so
 * crawlers that take the first matching rule see them first); without a group for every crawler (`User-agent: *`),
 * one holding the presets comes first.
 * @param {string[]} lines
 * @param {string[]} presets
 */
const withPresets = (lines, presets) => {
	if (presets.length === 0) return lines;
	/** @type {string[]} */
	const out = [];
	let agents = false;
	let everyone = false;
	for (const line of lines) {
		const directive = robotsDirectiveOf(line);
		if (directive?.field === 'user-agent') {
			agents = true;
			if (directive.value === '*') everyone = true;
		} else if (agents && (directive?.field === 'allow' || directive?.field === 'disallow')) {
			out.push(...presets);
			agents = false;
		}
		out.push(line);
	}
	if (agents) out.push(...presets);
	return everyone ? out : ['User-agent: *', ...presets, ...(out.length > 0 ? ['', ...out] : [])];
};

/**
 * The robots.txt the merchant's site serves: their rules (control characters removed) with the presets in every group
 * ({@link robotsPresetsOf}), with `blockAiCrawlers` a group that keeps the AI training crawlers off the whole site (G4),
 * and a `Sitemap:` line per sitemap ({@link sitemapUrlsOf}).
 * @param {Record<string, unknown>} values the `robots_verification` settings
 * @param {string} domain
 * @param {ReadonlyArray<string>} [searchParams] the search parameters of Searches and 404s
 */
export const robotsTxtOf = (values, domain, searchParams = []) => {
	const rules = typeof values.robotsRules === 'string' ? values.robotsRules : '';
	const own = rules
		.split(/\r?\n/)
		// eslint-disable-next-line no-control-regex
		.map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd())
		.filter((line) => !/^\s*sitemap\s*:/i.test(line));
	while (own.length > 0 && own[own.length - 1] === '') own.pop();
	const lines = withPresets(own, robotsPresetsOf(values, domain, searchParams));
	const blocked =
		values.blockAiCrawlers === true
			? [...(lines.length > 0 ? [''] : []), ...AI_TRAINING_CRAWLERS.map((name) => `User-agent: ${name}`), 'Disallow: /']
			: [];
	const before = [...lines, ...blocked];
	const after = sitemapUrlsOf(values, domain).map((url) => `Sitemap: ${url}`);
	return `${[...before, ...(before.length > 0 && after.length > 0 ? [''] : []), ...after].join('\n')}\n`;
};

/** @param {unknown} value */
export const isIndexNowKey = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value);

/**
 * A key file path the merchant set (PLAN 0.8.10 G5): a path on the website (`/indexnow-key.txt`), at most 300
 * characters, without a query, fragment or spaces; `''` when none is set; null when it is not a path.
 * @param {unknown} value
 * @returns {string | null}
 */
export const keyPathOf = (value) => {
	const path = typeof value === 'string' ? value.trim() : '';
	if (path === '') return '';
	return path.startsWith('/') && !path.startsWith('//') && path.length <= 300 && !/[\s?#\\]/.test(path) ? path : null;
};

/**
 * Where the merchant's site serves the IndexNow key: the `keyPath` setting, else `/<key>.txt` (G5); null when the
 * setting is not a path.
 * @param {{ key: unknown, keyPath?: unknown }} settings the `indexnow` settings
 * @param {string} domain
 */
export const keyLocationOf = ({ key, keyPath }, domain) => {
	const path = keyPathOf(keyPath);
	if (path === null) return null;
	return `https://${domain}${path === '' ? `/${String(key)}.txt` : path}`;
};

/**
 * An IndexNow submission: the URLs checked (https, the website's exact domain, no duplicates) and the body the
 * IndexNow endpoint takes (the key file at the `keyPath` setting, else `/<key>.txt`), or the reason it cannot be sent.
 * @param {{ urls: unknown, key: unknown, keyPath?: unknown, domain: string }} input
 * @returns {{ ok: true, body: { host: string, key: string, keyLocation: string, urlList: string[] } }
 *   | { ok: false, field: 'urls' | 'key' | 'keyPath', message: string }}
 */
export const indexNowSubmission = ({ urls, key, keyPath, domain }) => {
	if (!isIndexNowKey(key))
		return { ok: false, field: 'key', message: 'Set your IndexNow key (8–128 letters, digits or dashes) in Settings first.' };
	const keyLocation = keyLocationOf({ key, keyPath }, domain);
	if (keyLocation === null)
		return {
			ok: false,
			field: 'keyPath',
			message: 'The key file address must be a path on your website, such as /indexnow-key.txt (Settings).',
		};
	if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_INDEXNOW_URLS)
		return { ok: false, field: 'urls', message: `Send 1 to ${MAX_INDEXNOW_URLS} URLs.` };
	/** @type {string[]} */
	const list = [];
	for (const url of urls) {
		const checked = siteUrlOf(url, domain);
		if (checked === null) return { ok: false, field: 'urls', message: `Every URL must be an https address on ${domain}.` };
		if (!list.includes(checked)) list.push(checked);
	}
	return {
		ok: true,
		body: { host: domain, key: String(key), keyLocation, urlList: list },
	};
};

// ------------------------------------------------------------------------------------------------- the activity log

/**
 * The path of a page address on the website (`https://shop.example.com/a?b` → `/a?b`); the text itself when it is not
 * an address.
 * @param {string} url
 */
export const pathOfUrl = (url) => {
	try {
		const parsed = new URL(url);
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return url;
	}
};

/**
 * Paths as a list: the first ones, then how many more (the activity log keeps short texts).
 * @param {string[]} paths
 * @param {number} shown
 */
const listOf = (paths, shown) =>
	paths.length > shown ? `${paths.slice(0, shown).join(', ')} and ${paths.length - shown} more` : paths.join(', ');

/**
 * The activity-log texts of an IndexNow submission (PLAN 0.8.10 K9): how many pages as the label, what IndexNow
 * answered and the pages' paths as the detail.
 * @param {string[]} urls the submitted addresses (all on the website)
 * @param {number | null} status what IndexNow answered
 * @returns {{ label: string, detail: string }}
 */
export const indexNowActivity = (urls, status) => ({
	label: `${urls.length} ${urls.length === 1 ? 'page' : 'pages'} submitted to IndexNow`,
	detail: `IndexNow answered ${status ?? 'nothing'}. Pages: ${listOf(urls.map(pathOfUrl), 50)}`,
});

/**
 * The activity-log texts of an SEO checklist run (PLAN 0.8.10 K9): the checked page (and how many more) as the label,
 * the counts and the pages' paths as the detail.
 * @param {string[]} pages the checked pages
 * @param {{ pass: number, warn: number, fail: number }} summary
 * @returns {{ label: string, detail: string }}
 */
export const checksActivity = (pages, summary) => {
	const paths = pages.map(pathOfUrl);
	return {
		label: listOf(paths, 1),
		detail: `${summary.pass} passed, ${summary.warn} to improve, ${summary.fail} to fix. Pages: ${listOf(paths, 20)}`,
	};
};
