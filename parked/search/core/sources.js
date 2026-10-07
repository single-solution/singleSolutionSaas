/**
 * Crawled sources, pure part: which configured sources may run (https on the website's own domain or a subdomain,
 * a known document type, within the plan's source limit), JSON records mapped to documents through field paths
 * (`a.b|c`: dotted paths with alternatives, list indexes allowed), sitemap parsing (URL sets and sitemap indexes) and
 * the text of an HTML page (title, description, headings, body, image, robots `noindex`). Nothing is fetched here.
 * @module
 */
import { ID, isObject, linkOf } from './schema.js';
import { clip, htmlText } from './text.js';

/** Characters of page body text kept. */
export const MAX_BODY = 20_000;
/** Child sitemaps followed from a sitemap index. */
export const MAX_SITEMAPS = 20;

/**
 * @typedef {object} CrawlSource
 * @property {string} key
 * @property {'json' | 'sitemap'} kind
 * @property {string} url
 * @property {string} type
 * @property {number} everyHours
 * @property {string | null} recordsPath
 * @property {Record<string, string>} fields target field → path
 */

/**
 * True when a URL is https on the website's domain or one of its subdomains.
 * @param {string} url
 * @param {string} domain
 */
export const hostAllowed = (url, domain) => {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
		const site = String(domain ?? '')
			.toLowerCase()
			.replace(/\.$/, '');
		return (
			parsed.protocol === 'https:' &&
			parsed.username === '' &&
			parsed.password === '' &&
			site !== '' &&
			(host === site || host.endsWith(`.${site}`))
		);
	} catch {
		return false;
	}
};

/**
 * The sources that may run, and why the others may not.
 * @param {unknown} config `sources.crawl_sources`
 * @param {{ domain: string, max: number, types: Map<string, unknown> }} context
 * @returns {{ sources: CrawlSource[], refused: Array<{ key: string, reason: string }> }}
 */
export const crawlSourcesOf = (config, { domain, max, types }) => {
	/** @type {CrawlSource[]} */
	const sources = [];
	/** @type {Array<{ key: string, reason: string }>} */
	const refused = [];
	const seen = new Set();
	for (const raw of Array.isArray(config) ? config : []) {
		if (!isObject(raw) || typeof raw.key !== 'string' || seen.has(raw.key)) continue;
		seen.add(raw.key);
		const reason =
			raw.kind !== 'json' && raw.kind !== 'sitemap'
				? 'kind_unknown'
				: typeof raw.url !== 'string' || !hostAllowed(raw.url, domain)
					? 'url_not_allowed'
					: typeof raw.type !== 'string' || !types.has(raw.type)
						? 'type_unknown'
						: sources.length >= max
							? 'limit_reached'
							: null;
		if (reason) {
			refused.push({ key: raw.key, reason });
			continue;
		}
		/** @type {Record<string, string>} */
		const fields = {};
		for (const entry of Array.isArray(raw.fields) ? raw.fields : [])
			if (isObject(entry) && typeof entry.field === 'string' && typeof entry.path === 'string')
				fields[entry.field] = entry.path;
		sources.push({
			key: raw.key,
			kind: raw.kind,
			url: new URL(raw.url).href,
			type: raw.type,
			everyHours: Number.isInteger(raw.every_hours) && raw.every_hours > 0 ? raw.every_hours : 24,
			recordsPath: typeof raw.records_path === 'string' && raw.records_path !== '' ? raw.records_path : null,
			fields,
		});
	}
	return { sources, refused };
};

/**
 * Value at a path: `a.b.0.c`, alternatives separated by `|` (the first present one wins).
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 */
export const at = (value, path) => {
	for (const alternative of path.split('|').slice(0, 10)) {
		/** @type {unknown} */
		let current = value;
		for (const segment of alternative.trim().split('.').slice(0, 10)) {
			if (segment === '') break;
			if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
			else if (isObject(current) && Object.hasOwn(current, segment)) current = current[segment];
			else {
				current = undefined;
				break;
			}
		}
		if (current !== undefined && current !== null && current !== '') return current;
	}
	return undefined;
};

/**
 * The records of a JSON feed: at `recordsPath`, else the document itself when it is a list, else its
 * `items | data | results | documents` list.
 * @param {unknown} json
 * @param {string | null} recordsPath
 * @returns {unknown[]}
 */
export const recordsOf = (json, recordsPath) => {
	const found = recordsPath ? at(json, recordsPath) : Array.isArray(json) ? json : at(json, 'items|data|results|documents');
	return Array.isArray(found) ? found : [];
};

/** Paths used when a source does not map a field. */
export const DEFAULT_PATHS = Object.freeze({
	id: 'id|slug|sku|url',
	url: 'url|href|link',
	image: 'image.url|image|imageUrl|images.0.url|images.0',
	price: 'price',
	currency: 'currency',
	boost: 'boost|rank|popularity',
	title: 'title|name',
	description: 'description|summary|excerpt',
});
const RESERVED = new Set(['id', 'url', 'image', 'price', 'currency', 'boost']);

/**
 * A small, stable, non-cryptographic hash (53 bits, hex) for ids derived from URLs.
 * @param {string} text
 */
export const stableHash = (text) => {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
};

/**
 * Document id of a crawled record or page (namespaced by the source key).
 * @param {string} sourceKey
 * @param {unknown} raw
 */
export const crawledId = (sourceKey, raw) => {
	const text = String(raw ?? '').slice(0, 2000);
	const local = ID.test(text) && text.length <= 80 ? text : stableHash(text);
	return `${sourceKey}:${local}`;
};

/**
 * Map one JSON record to a document input (validated later like any other document).
 * @param {unknown} record
 * @param {CrawlSource} source
 * @param {readonly string[]} fieldKeys the fields of the source's document type
 * @returns {Record<string, unknown> | null} null without an id
 */
export const mapRecord = (record, source, fieldKeys) => {
	if (!isObject(record)) return null;
	const path = (/** @type {string} */ field) =>
		source.fields[field] ?? /** @type {Record<string, string>} */ (DEFAULT_PATHS)[field] ?? field;
	const rawId = at(record, path('id'));
	if (rawId === undefined || (typeof rawId !== 'string' && typeof rawId !== 'number')) return null;
	/** @type {Record<string, unknown>} */
	const fields = {};
	for (const key of fieldKeys) {
		if (RESERVED.has(key)) continue;
		const value = at(record, path(key));
		if (value !== undefined) fields[key] = value;
	}
	const price = at(record, path('price'));
	const currency = at(record, path('currency'));
	const boost = at(record, path('boost'));
	const link = linkOf(at(record, path('url')));
	const image = linkOf(at(record, path('image')));
	return {
		id: crawledId(source.key, rawId),
		type: source.type,
		url: link ?? null,
		image: image ?? null,
		price: Number.isSafeInteger(price) && /** @type {number} */ (price) >= 0 ? price : null,
		currency: typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : null,
		boost: typeof boost === 'number' && Number.isFinite(boost) && boost >= 0 ? Math.min(boost, 1_000_000) : 0,
		fields,
	};
};

/** @param {string} text */
const decodeXml = (text) =>
	text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.trim();

/**
 * URLs of a sitemap (`<urlset>`) or the child sitemaps of a sitemap index (`<sitemapindex>`).
 * @param {string} xml
 * @param {{ max: number }} options
 * @returns {{ urls: string[], sitemaps: string[] }}
 */
export const parseSitemap = (xml, { max }) => {
	const text = String(xml);
	/** @param {'url' | 'sitemap'} tag @param {number} limit */
	const locs = (tag, limit) => {
		/** @type {string[]} */
		const out = [];
		const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
		for (const match of text.matchAll(pattern)) {
			const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(match[1] ?? '');
			if (loc?.[1]) out.push(decodeXml(loc[1]));
			if (out.length >= limit) break;
		}
		return out;
	};
	return { urls: [...new Set(locs('url', max))], sitemaps: [...new Set(locs('sitemap', MAX_SITEMAPS))] };
};

/**
 * Content of a meta tag.
 * @param {string} html
 * @param {string} attribute `name` or `property`
 * @param {string} value
 */
const metaOf = (html, attribute, value) => {
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = match[0];
		const key = new RegExp(`\\b${attribute}\\s*=\\s*["']${value}["']`, 'i');
		if (!key.test(tag)) continue;
		const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
		if (content) return htmlText(content[2] ?? '');
	}
	return '';
};

/**
 * Text of an HTML page for indexing.
 * @param {string} html
 * @param {{ maxBody?: number }} [options]
 */
export const extractPage = (html, { maxBody = MAX_BODY } = {}) => {
	const source = String(html);
	const title = htmlText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? '') || metaOf(source, 'property', 'og:title');
	const headings = [...source.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
		.map((match) => htmlText(match[1] ?? ''))
		.filter((text) => text !== '')
		.slice(0, 50);
	const main =
		/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(source)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source)?.[1] ?? source;
	const robots = `${metaOf(source, 'name', 'robots')} ${metaOf(source, 'name', 'ss-search')}`.toLowerCase();
	const image = linkOf(metaOf(source, 'property', 'og:image'));
	return {
		title: clip(title, 300),
		description: clip(metaOf(source, 'name', 'description') || metaOf(source, 'property', 'og:description'), 1000),
		headings,
		body: clip(htmlText(main.replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')), maxBody),
		image: image ?? null,
		noindex: /\bnoindex\b|\bnone\b/.test(robots),
	};
};
