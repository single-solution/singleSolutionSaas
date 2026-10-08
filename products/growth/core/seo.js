/**
 * Site-wide SEO (PLAN 0.8.9): the robots.txt the merchant's site serves (their rules plus their sitemaps), the
 * verification tags (Google, Bing, Meta), IndexNow submissions (the merchant's key, URLs of the website's exact
 * domain) and the SEO checklist: from the merchant's pages as fetched on request (no timers), a list of checks, each
 * pass, warn or fail, that the widget shows with its title and fix steps (widget texts). Pure: the fetching is done
 * by the caller.
 * @module
 */

/** Pages one checklist run reads, besides robots.txt and the sitemap. */
const MAX_PAGES = 20;

/** URLs one IndexNow submission takes (the IndexNow limit). */
const MAX_INDEXNOW_URLS = 10_000;

/** The IndexNow endpoint every participating search engine shares. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Title and description lengths search results show without cutting. */
const TITLE_LENGTH = Object.freeze({ min: 10, max: 60 });
const DESCRIPTION_LENGTH = Object.freeze({ min: 50, max: 160 });

/** @typedef {'pass' | 'warn' | 'fail'} CheckStatus */
/** @typedef {{ id: string, status: CheckStatus, page: string | null, detail: Record<string, string | number> }} Check */
/** @typedef {{ url: string, status: number | null, headers?: Record<string, string>, body: string }} Fetched */

// ------------------------------------------------------------------------------------------------- robots and tags

/** The verification meta tags: setting → tag name. */
const VERIFICATION_TAGS = Object.freeze({
	googleVerification: 'google-site-verification',
	bingVerification: 'msvalidate.01',
	metaVerification: 'facebook-domain-verification',
});

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
 * The robots.txt the merchant's site serves: their rules (control characters removed) and a `Sitemap:` line per
 * sitemap URL on the website's domain.
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
	return `${[...lines, ...(sitemaps.length > 0 ? ['', ...sitemaps.map((url) => `Sitemap: ${url}`)] : [])].join('\n')}\n`;
};

/** @param {unknown} value */
const isIndexNowKey = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value);

/**
 * An IndexNow submission: the URLs checked (https, the website's exact domain, no duplicates) and the body the
 * IndexNow endpoint takes, or the reason it cannot be sent.
 * @param {{ urls: unknown, key: unknown, domain: string }} input
 * @returns {{ ok: true, body: { host: string, key: string, keyLocation: string, urlList: string[] } }
 *   | { ok: false, field: 'urls' | 'key', message: string }}
 */
export const indexNowSubmission = ({ urls, key, domain }) => {
	if (!isIndexNowKey(key))
		return { ok: false, field: 'key', message: 'Set your IndexNow key (8–128 letters, digits or dashes) in Settings first.' };
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
		body: { host: domain, key: String(key), keyLocation: `https://${domain}/${String(key)}.txt`, urlList: list },
	};
};

// -------------------------------------------------------------------------------------------------------- the HTML

/**
 * The attributes of one tag (`<meta name="x" content="y">` → `{ name: 'x', content: 'y' }`); names lowercase.
 * @param {string} tag
 * @returns {Record<string, string>}
 */
export const attributesOf = (tag) => {
	/** @type {Record<string, string>} */
	const found = {};
	const inner = tag.replace(/^<[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
	for (const match of inner.matchAll(/([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
		const name = (match[1] ?? '').toLowerCase();
		if (!(name in found)) found[name] = (match[2] ?? match[3] ?? match[4] ?? '').trim();
	}
	return found;
};

/**
 * What the checks read from a page's HTML (comments and script bodies other than JSON-LD ignored).
 * @param {string} html
 */
export const scanHtml = (html) => {
	const ldCount = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json/gi)].length;
	const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '<script></script>');
	/** @param {string} name */
	const tags = (name) => [...clean.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => attributesOf(match[0]));
	const metas = tags('meta');
	/** @param {string} key @param {string} value */
	const meta = (key, value) => metas.find((m) => (m[key] ?? '').toLowerCase() === value)?.content ?? null;
	const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? null;
	const canonical = tags('link').find((link) => (link.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'));
	const images = tags('img');
	return {
		title: title === null ? null : decodeText(title),
		description: meta('name', 'description'),
		robots: (meta('name', 'robots') ?? '').toLowerCase(),
		viewport: meta('name', 'viewport'),
		ogTitle: meta('property', 'og:title'),
		ogImage: meta('property', 'og:image'),
		canonical: canonical?.href ?? null,
		lang: tags('html')[0]?.lang ?? null,
		h1: tags('h1').length,
		images: images.length,
		imagesWithoutAlt: images.filter((img) => !('alt' in img)).length,
		jsonLd: ldCount,
		verification: Object.values(VERIFICATION_TAGS).filter((name) => meta('name', name) !== null),
	};
};

/**
 * Text of an element: entities decoded, spaces collapsed.
 * @param {string} value
 */
const decodeText = (value) =>
	value
		.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (match, name) =>
			name === 'amp' ? '&' : name === 'lt' ? '<' : name === 'gt' ? '>' : name === 'quot' ? '"' : name === 'nbsp' ? ' ' : "'",
		)
		.replace(/\s+/g, ' ')
		.trim();

/**
 * Whether robots.txt blocks every crawler from the whole site (`User-agent: *` with `Disallow: /`).
 * @param {string} text
 */
export const blocksAll = (text) => {
	let star = false;
	let inGroup = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = (raw.split('#')[0] ?? '').trim();
		const [field = '', ...rest] = line.split(':');
		const value = rest.join(':').trim();
		const name = field.trim().toLowerCase();
		if (name === 'user-agent') {
			if (!inGroup) star = false;
			inGroup = true;
			if (value === '*') star = true;
		} else if (name !== '') {
			inGroup = false;
			if (star && name === 'disallow' && value === '/') return true;
		}
	}
	return false;
};

/**
 * The sitemaps robots.txt names.
 * @param {string} text
 */
export const sitemapsIn = (text) =>
	text
		.split(/\r?\n/)
		.map((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1])
		.filter(/** @returns {url is string} */ (url) => typeof url === 'string');

/**
 * @param {string} id
 * @param {CheckStatus} status
 * @param {string | null} page
 * @param {Record<string, string | number>} [detail]
 * @returns {Check}
 */
const check = (id, status, page, detail = {}) => ({ id, status, page, detail });

/**
 * The checks of one page.
 * @param {Fetched} page
 * @param {string} domain
 * @returns {Check[]}
 */
export const pageChecks = (page, domain) => {
	const at = page.url;
	if (page.status !== 200) return [check('reachable', 'fail', at, { status: page.status ?? 0 })];
	const scan = scanHtml(page.body);
	const header = (page.headers?.['x-robots-tag'] ?? '').toLowerCase();
	const titleLength = scan.title?.length ?? 0;
	const descriptionLength = scan.description?.length ?? 0;
	/** @type {CheckStatus} */
	const canonical = (() => {
		if (!scan.canonical) return 'warn';
		try {
			return new URL(scan.canonical, at).hostname === domain ? 'pass' : 'warn';
		} catch {
			return 'warn';
		}
	})();
	return [
		check('reachable', 'pass', at, { status: 200 }),
		check('noindex', scan.robots.includes('noindex') || header.includes('noindex') ? 'fail' : 'pass', at),
		check(
			'title',
			titleLength === 0 ? 'fail' : titleLength < TITLE_LENGTH.min || titleLength > TITLE_LENGTH.max ? 'warn' : 'pass',
			at,
			{ length: titleLength },
		),
		check(
			'description',
			descriptionLength < DESCRIPTION_LENGTH.min || descriptionLength > DESCRIPTION_LENGTH.max ? 'warn' : 'pass',
			at,
			{ length: descriptionLength },
		),
		check('h1', scan.h1 === 1 ? 'pass' : 'warn', at, { count: scan.h1 }),
		check('canonical', canonical, at),
		check('lang', scan.lang ? 'pass' : 'warn', at),
		check('viewport', scan.viewport ? 'pass' : 'fail', at),
		check('social', scan.ogTitle && scan.ogImage ? 'pass' : 'warn', at),
		check('image_alt', scan.imagesWithoutAlt === 0 ? 'pass' : 'warn', at, { count: scan.imagesWithoutAlt }),
		check('structured_data', scan.jsonLd > 0 ? 'pass' : 'warn', at, { count: scan.jsonLd }),
	];
};

/**
 * The checks of the whole site.
 * @param {{ home: Fetched, robots: Fetched, sitemap: Fetched | null }} input `sitemap`: the first sitemap robots.txt
 *   names, else `/sitemap.xml`
 * @returns {Check[]}
 */
export const siteChecks = ({ home, robots, sitemap }) => {
	const robotsOk = robots.status === 200;
	const verified = home.status === 200 ? scanHtml(home.body).verification : [];
	return [
		check('robots_txt', robotsOk ? 'pass' : 'warn', robots.url, { status: robots.status ?? 0 }),
		check('robots_blocks', robotsOk && blocksAll(robots.body) ? 'fail' : 'pass', robots.url),
		check('sitemap', sitemap?.status === 200 ? 'pass' : 'warn', sitemap?.url ?? null, { status: sitemap?.status ?? 0 }),
		check('verification', verified.length > 0 ? 'pass' : 'warn', home.url, { count: verified.length }),
	];
};

/**
 * The pages one run reads: the paths of the `seo_checklist` settings (else `/`), as URLs of the website, at most
 * {@link MAX_PAGES}.
 * @param {unknown} paths
 * @param {string} domain
 */
export const pagesOf = (paths, domain) => {
	const list = (Array.isArray(paths) ? paths : [])
		.filter((path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/\s/.test(path))
		.map((path) => `https://${domain}${path}`);
	const unique = [...new Set([`https://${domain}/`, ...list])];
	return unique.slice(0, MAX_PAGES);
};

/**
 * The checklist report: every check and the counts.
 * @param {Check[]} checks
 * @param {number} now
 */
export const reportOf = (checks, now) => ({
	checkedAt: new Date(now).toISOString(),
	summary: {
		pass: checks.filter((c) => c.status === 'pass').length,
		warn: checks.filter((c) => c.status === 'warn').length,
		fail: checks.filter((c) => c.status === 'fail').length,
	},
	checks,
});
