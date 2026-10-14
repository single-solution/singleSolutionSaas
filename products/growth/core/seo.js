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
 * The robots.txt the merchant's site serves: their rules (control characters removed), with `blockAiCrawlers` a group
 * that keeps the AI training crawlers off the whole site (G4), and a `Sitemap:` line per sitemap URL on the website's
 * domain.
 * @param {Record<string, unknown>} values the `robots_verification` settings
 * @param {string} domain
 */
export const robotsTxtOf = (values, domain) => {
	const rules = typeof values.robotsRules === 'string' ? values.robotsRules : '';
	const lines = rules
		.split(/\r?\n/)
		// eslint-disable-next-line no-control-regex
		.map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd())
		.filter((line) => !/^\s*sitemap\s*:/i.test(line));
	const sitemaps = (Array.isArray(values.sitemaps) ? values.sitemaps : [])
		.map((url) => siteUrlOf(url, domain))
		.filter((url) => url !== null)
		.slice(0, 50);
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	const blocked =
		values.blockAiCrawlers === true
			? [...(lines.length > 0 ? [''] : []), ...AI_TRAINING_CRAWLERS.map((name) => `User-agent: ${name}`), 'Disallow: /']
			: [];
	return `${[...lines, ...blocked, ...(sitemaps.length > 0 ? ['', ...sitemaps.map((url) => `Sitemap: ${url}`)] : [])].join('\n')}\n`;
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
