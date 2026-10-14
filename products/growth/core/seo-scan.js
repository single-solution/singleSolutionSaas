/**
 * Reading what the SEO health report fetched, the way a search engine reads it (SEO audit §3.2 B): a page's HTML (the
 * head tags, its canonical links, headings, images, the text a visitor sees without running scripts and its JSON-LD
 * structured data), robots.txt (groups and rules matched as RFC 9309 and Google's robots.txt rules say) and sitemaps
 * (an index or a list of addresses with their images). Pure: the fetching is done by the caller.
 * @module
 */
import { VERIFICATION_NAMES } from './seo.js';

/** Most addresses one sitemap file may list (the sitemap protocol's limit). */
const MAX_SITEMAP_ENTRIES = 50_000;

/** Most JSON-LD nodes read from one page, and how deep a node is searched. */
const MAX_NODES = 2_000;
const MAX_DEPTH = 12;

// ----------------------------------------------------------------------------------------------------------- text

/** Named character references the reader decodes (others stay as written). @type {Record<string, string>} */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/**
 * A text with its character references decoded (`&amp;`, `&#36;`, `&#x20B9;` …).
 * @param {string} value
 */
export const decodeEntities = (value) =>
	value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (match, decimal, hex, name) => {
		if (name !== undefined) return NAMED[String(name).toLowerCase()] ?? match;
		const code = decimal !== undefined ? Number(decimal) : Number.parseInt(String(hex), 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});

/**
 * Text as a person reads it: references decoded, every run of spaces one space.
 * @param {string} value
 */
const plainText = (value) =>
	decodeEntities(value)
		.replace(/[\s\u00a0]+/g, ' ')
		.trim();

// ----------------------------------------------------------------------------------------------------------- HTML

/**
 * The attributes of one tag (`<meta name="x" content="y">` → `{ name: 'x', content: 'y' }`); names lowercase, values
 * decoded.
 * @param {string} tag
 * @returns {Record<string, string>}
 */
export const attributesOf = (tag) => {
	/** @type {Record<string, string>} */
	const found = {};
	const inner = tag.replace(/^<[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
	for (const match of inner.matchAll(/([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
		const name = (match[1] ?? '').toLowerCase();
		if (!(name in found)) found[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '').trim();
	}
	return found;
};

/**
 * One JSON-LD block as parsed: its value, or null when it is not JSON (an HTML comment or CDATA wrapper is allowed).
 * @param {string} text
 */
const parseBlock = (text) => {
	const body = text
		.trim()
		.replace(/^<!--|-->$/g, '')
		.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')
		.trim();
	try {
		return { ok: true, value: /** @type {unknown} */ (JSON.parse(body)) };
	} catch {
		return { ok: false, value: null };
	}
};

/**
 * The top-level nodes of the parsed JSON-LD blocks: each block's object, the items of an array, and the nodes of an
 * `@graph`.
 * @param {unknown[]} values
 * @returns {Array<Record<string, unknown>>}
 */
const topNodesOf = (values) => {
	/** @type {Array<Record<string, unknown>>} */
	const nodes = [];
	/** @param {unknown} value */
	const add = (value) => {
		if (nodes.length >= MAX_NODES) return;
		if (Array.isArray(value)) for (const item of value) add(item);
		else if (isNode(value)) {
			if (Array.isArray(value['@graph'])) add(value['@graph']);
			else nodes.push(value);
		}
	};
	for (const value of values) add(value);
	return nodes;
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isNode = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The schema.org types of a node, without a prefix (`schema:Product`, `https://schema.org/Product` → `Product`).
 * @param {unknown} node
 * @returns {string[]}
 */
export const typesOf = (node) => {
	if (!isNode(node)) return [];
	const raw = node['@type'];
	return (Array.isArray(raw) ? raw : [raw])
		.filter((type) => typeof type === 'string')
		.map((type) => String(type).slice(Math.max(String(type).lastIndexOf('/'), String(type).lastIndexOf(':')) + 1));
};

/**
 * Every node of a JSON-LD value, nested ones included (at most {@link MAX_NODES}, {@link MAX_DEPTH} levels deep).
 * @param {Array<Record<string, unknown>>} top
 * @returns {Array<Record<string, unknown>>}
 */
export const allNodesOf = (top) => {
	/** @type {Array<Record<string, unknown>>} */
	const nodes = [];
	/** @param {unknown} value @param {number} depth */
	const walk = (value, depth) => {
		if (nodes.length >= MAX_NODES || depth > MAX_DEPTH) return;
		if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
		else if (isNode(value)) {
			nodes.push(value);
			for (const [key, item] of Object.entries(value)) if (key !== '@context') walk(item, depth + 1);
		}
	};
	walk(top, 0);
	return nodes;
};

/**
 * What the checks read from a page's HTML. Comments, scripts, styles, templates and `<noscript>` (search engines run
 * the page's scripts, so they never see it) are left out of the tags and the text; JSON-LD blocks are read from the
 * scripts. `text` is what a visitor sees before any script runs.
 * @param {string} html
 */
export const scanHtml = (html) => {
	const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter((match) =>
		/type\s*=\s*["']?application\/ld\+json/i.test(match[1] ?? ''),
	);
	const parsed = blocks.map((match) => parseBlock(match[2] ?? ''));
	const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '');
	/** @param {string} name */
	const tags = (name) => [...clean.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => attributesOf(match[0]));
	const metas = tags('meta');
	/** @param {string} key @param {string} value */
	const meta = (key, value) => metas.find((m) => (m[key] ?? '').toLowerCase() === value)?.content ?? null;
	const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? null;
	const canonicals = tags('link')
		.filter((link) => (link.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'))
		.map((link) => link.href ?? '');
	const images = tags('img');
	const body = clean.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ').replace(/<title\b[\s\S]*?<\/title\s*>/gi, ' ');
	const top = topNodesOf(parsed.filter((block) => block.ok).map((block) => block.value));
	return {
		title: title === null ? null : plainText(title),
		description: meta('name', 'description'),
		robots: [meta('name', 'robots'), meta('name', 'googlebot')]
			.filter((value) => value !== null)
			.join(', ')
			.toLowerCase(),
		viewport: meta('name', 'viewport'),
		ogTitle: meta('property', 'og:title'),
		ogImage: meta('property', 'og:image'),
		canonicals,
		lang: tags('html')[0]?.lang || null,
		h1: tags('h1').length,
		images: images.length,
		imagesWithoutAlt: images.filter((img) => !('alt' in img)).length,
		imagesWithoutSize: images.filter((img) => !img.width || !img.height).length,
		jsonLd: { blocks: blocks.length, invalid: parsed.filter((block) => !block.ok).length, nodes: top },
		verification: VERIFICATION_NAMES.filter((name) => meta('name', name) !== null),
		text: plainText(body.replace(/<[^>]*>/g, ' ')),
	};
};

/** @typedef {ReturnType<typeof scanHtml>} Scan */

/**
 * The numbers a text shows (`$1,250.00`, `1.250,00 €`, `1 250`): each read with a dot and with a comma as the decimal
 * mark, so a price is found whichever way the page writes it.
 * @param {string} text
 * @returns {number[]}
 */
export const numbersIn = (text) => {
	/** @type {Set<number>} */
	const found = new Set();
	for (const [token] of text.matchAll(/\d[\d.,'\u2019\u00a0\u202f\u2009]*\d|\d/g)) {
		const dotDecimal = Number(token.replace(/[,'\u2019\u00a0\u202f\u2009]/g, ''));
		const commaDecimal = Number(token.replace(/[.'\u2019\u00a0\u202f\u2009]/g, '').replace(',', '.'));
		for (const value of [dotDecimal, commaDecimal]) if (Number.isFinite(value)) found.add(value);
	}
	return [...found];
};

// ---------------------------------------------------------------------------------------------------- robots.txt

/** @typedef {{ allow: boolean, pattern: string }} RobotsRule */
/** @typedef {{ agents: string[], rules: RobotsRule[] }} RobotsGroup */

/**
 * The groups of a robots.txt (RFC 9309): user-agent lines in a row open one group, its allow and disallow rules follow;
 * rules before any user-agent line and empty rules (`Disallow:`) count for nothing. Comments and unknown lines are
 * skipped.
 * @param {string} text
 * @returns {RobotsGroup[]}
 */
export const robotsGroupsOf = (text) => {
	/** @type {RobotsGroup[]} */
	const groups = [];
	/** @type {RobotsGroup | null} */
	let current = null;
	let collecting = false;
	for (const raw of text.split(/\r?\n|\r/)) {
		const line = (raw.split('#')[0] ?? '').trim();
		const colon = line.indexOf(':');
		if (colon < 1) continue;
		const field = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (field === 'user-agent') {
			if (!collecting || current === null) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			collecting = true;
			current.agents.push(value.toLowerCase());
		} else if (field === 'allow' || field === 'disallow') {
			collecting = false;
			if (current !== null && value !== '') current.rules.push({ allow: field === 'allow', pattern: value });
		}
	}
	return groups;
};

/**
 * The sitemaps robots.txt names (any `Sitemap:` line).
 * @param {string} text
 */
export const sitemapsIn = (text) =>
	text
		.split(/\r?\n|\r/)
		.map((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1])
		.filter(/** @returns {url is string} */ (url) => typeof url === 'string');

/**
 * Whether a rule's pattern matches a path (with its query string): `*` any characters, a final `$` the end; else a
 * match of the path's start. Characters outside ASCII in the pattern are compared percent-encoded.
 * @param {string} pattern
 * @param {string} path
 */
const matches = (pattern, path) => {
	const anchored = pattern.endsWith('$');
	const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[^\u0020-\u007e]/gu, (char) => encodeURIComponent(char));
	const source = body
		.split('*')
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*');
	return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
};

/**
 * Whether a crawler may read a path, as Google decides it: the group of the crawler's most specific product token that
 * robots.txt names (several groups of one token count as one), else `*`; the longest matching rule wins, and `Allow`
 * wins a tie. `/robots.txt` itself is always allowed.
 * @param {RobotsGroup[]} groups
 * @param {string[]} tokens the crawler's product tokens, most specific first (`['googlebot-image', 'googlebot']`)
 * @param {string} path the path from `/` with its query string
 * @returns {{ allowed: boolean, rule: string | null }} `rule`: the deciding rule as written (`Disallow: /cart`)
 */
export const robotsAllows = (groups, tokens, path) => {
	if (path === '/robots.txt') return { allowed: true, rule: null };
	const token = [...tokens, '*'].find((name) => groups.some((group) => group.agents.includes(name)));
	if (token === undefined) return { allowed: true, rule: null };
	/** @type {RobotsRule | null} */
	let best = null;
	for (const group of groups.filter((entry) => entry.agents.includes(token)))
		for (const rule of group.rules) {
			if (!matches(rule.pattern, path)) continue;
			if (
				best === null ||
				rule.pattern.length > best.pattern.length ||
				(rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
			)
				best = rule;
		}
	if (best === null) return { allowed: true, rule: null };
	return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` };
};

// ------------------------------------------------------------------------------------------------------- sitemaps

/** @typedef {{ loc: string, images: number }} SitemapEntry */

/**
 * The address in a `<loc>` (CDATA unwrapped, references decoded).
 * @param {string} text
 */
const locOf = (text) => decodeEntities(text.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim());

/**
 * A sitemap file as read: an index of sitemap files, or a list of addresses with how many images each lists; `type`
 * null when the text is not a sitemap.
 * @param {string} xml
 * @returns {{ type: 'index' | 'urlset' | null, files: string[], entries: SitemapEntry[] }}
 */
export const sitemapOf = (xml) => {
	if (/<sitemapindex[\s>]/i.test(xml)) {
		const files = [...xml.matchAll(/<sitemap\b[^>]*>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi)]
			.map((match) => locOf(match[1] ?? ''))
			.slice(0, MAX_SITEMAP_ENTRIES);
		return { type: 'index', files, entries: [] };
	}
	if (!/<urlset[\s>]/i.test(xml)) return { type: null, files: [], entries: [] };
	/** @type {SitemapEntry[]} */
	const entries = [];
	for (const match of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
		const block = match[1] ?? '';
		const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(block)?.[1];
		if (loc === undefined) continue;
		entries.push({ loc: locOf(loc), images: [...block.matchAll(/<(?:[\w-]+:)?image(?=[\s>])/gi)].length });
		if (entries.length >= MAX_SITEMAP_ENTRIES) break;
	}
	return { type: 'urlset', files: [], entries };
};
