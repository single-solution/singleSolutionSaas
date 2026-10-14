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

// ------------------------------------------------------------------------------------------------- linear scanning
// A page or a sitemap is the site's to write: tags, comments and elements are found by scanning forward with
// `indexOf`, never with a pattern that reads the rest of the text again for every tag left open (a hostile page of
// unclosed tags would take minutes).

/**
 * A text with its ASCII letters in lower case: the same length, so a place in it is the same place in the text.
 * @param {string} text
 */
const lowerAscii = (text) => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/** A letter, digit or `_` (a name that goes on is another name: `<header` is not `<head`). */
const WORD = /\w/;

/**
 * Where a tag `<name` starts at or after `from` (its name ends there), or -1.
 * @param {string} lower the text from {@link lowerAscii}
 * @param {string} name in lower case
 * @param {number} from
 */
const openingAt = (lower, name, from) => {
	let at = lower.indexOf(`<${name}`, from);
	while (at >= 0 && WORD.test(lower[at + name.length + 1] ?? '')) at = lower.indexOf(`<${name}`, at + 1);
	return at;
};

/**
 * The closing tag `</name>` (spaces allowed before `>`) at or after `from`: where it starts and ends, or null.
 * @param {string} lower
 * @param {string} name
 * @param {number} from
 */
const closingAt = (lower, name, from) => {
	for (let at = lower.indexOf(`</${name}`, from); at >= 0; at = lower.indexOf(`</${name}`, at + 1)) {
		let end = at + name.length + 2;
		while (/\s/.test(lower[end] ?? '')) end += 1;
		if (lower[end] === '>') return { at, end: end + 1 };
	}
	return null;
};

/**
 * The elements `<name …>…</name>` of a text, in order: the opening tag and what is inside (an element left open, and
 * every one after it, is not one).
 * @param {string} text
 * @param {string} name in lower case
 * @returns {Array<{ tag: string, inner: string }>}
 */
const elementsOf = (text, name) => {
	const lower = lowerAscii(text);
	/** @type {Array<{ tag: string, inner: string }>} */
	const found = [];
	for (let from = 0; ;) {
		const at = openingAt(lower, name, from);
		const open = at < 0 ? -1 : lower.indexOf('>', at);
		const close = open < 0 ? null : closingAt(lower, name, open + 1);
		if (close === null) return found;
		found.push({ tag: text.slice(at, open + 1), inner: text.slice(open + 1, close.at) });
		from = close.end;
	}
};

/**
 * The tags `<name …>` of a text, in order (`<meta`, `<link` …).
 * @param {string} text
 * @param {string} lower the text from {@link lowerAscii}
 * @param {string} name in lower case
 * @returns {string[]}
 */
const tagsOf = (text, lower, name) => {
	/** @type {string[]} */
	const found = [];
	for (let from = 0; ;) {
		const at = openingAt(lower, name, from);
		const end = at < 0 ? -1 : lower.indexOf('>', at);
		if (end < 0) return found;
		found.push(text.slice(at, end + 1));
		from = end + 1;
	}
};

/**
 * A text without its elements of these names, from `<name` to `</name>` (each replaced by `by`); `once`: only the
 * first. An element left open stays, as does every later one of its name.
 * @param {string} text
 * @param {string[]} names in lower case
 * @param {{ by?: string, once?: boolean }} [options]
 */
const withoutElements = (text, names, { by = '', once = false } = {}) => {
	const lower = lowerAscii(text);
	const open = new Set(names);
	let out = '';
	let kept = 0;
	for (let at = lower.indexOf('<'); at >= 0 && open.size > 0;) {
		const name = [...open].find((n) => lower.startsWith(n, at + 1) && !WORD.test(lower[at + n.length + 1] ?? ''));
		const close = name === undefined ? null : closingAt(lower, name, at + name.length + 1);
		if (name !== undefined && close === null) open.delete(name);
		if (close === null) {
			at = lower.indexOf('<', at + 1);
			continue;
		}
		out += `${text.slice(kept, at)}${by}`;
		kept = close.end;
		if (once) break;
		at = lower.indexOf('<', kept);
	}
	return out + text.slice(kept);
};

/**
 * A text without its comments (`<!-- … -->`); one left open stays.
 * @param {string} text
 */
const withoutComments = (text) => {
	let out = '';
	let kept = 0;
	for (let at = text.indexOf('<!--'); at >= 0; at = text.indexOf('<!--', kept)) {
		const end = text.indexOf('-->', at + 4);
		if (end < 0) break;
		out += text.slice(kept, at);
		kept = end + 3;
	}
	return out + text.slice(kept);
};

/**
 * A text with every tag (`<…>`) replaced by a space.
 * @param {string} text
 */
const withoutTags = (text) => {
	let out = '';
	let kept = 0;
	for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', kept)) {
		const end = text.indexOf('>', at);
		if (end < 0) break;
		out += `${text.slice(kept, at)} `;
		kept = end + 1;
	}
	return out + text.slice(kept);
};

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
	const blocks = elementsOf(html, 'script').filter((script) => /type\s*=\s*["']?application\/ld\+json/i.test(script.tag));
	const parsed = blocks.map((script) => parseBlock(script.inner));
	const clean = withoutElements(withoutComments(html), ['script', 'style', 'template', 'noscript']);
	const lower = lowerAscii(clean);
	/** @param {string} name */
	const tags = (name) => tagsOf(clean, lower, name).map(attributesOf);
	const metas = tags('meta');
	/** @param {string} key @param {string} value */
	const meta = (key, value) => metas.find((m) => (m[key] ?? '').toLowerCase() === value)?.content ?? null;
	const title = elementsOf(clean, 'title')[0]?.inner ?? null;
	const canonicals = tags('link')
		.filter((link) => (link.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'))
		.map((link) => link.href ?? '');
	const images = tags('img');
	const body = withoutElements(withoutElements(clean, ['head'], { by: ' ', once: true }), ['title'], { by: ' ' });
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
		text: plainText(withoutTags(body)),
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
 * match of the path's start. Characters outside ASCII in the pattern are compared percent-encoded. The parts between
 * the `*`s are found in order, each as early as it can be (never a pattern that tries every split: a rule of many `*`s
 * would take minutes).
 * @param {string} pattern
 * @param {string} path
 */
const matches = (pattern, path) => {
	const anchored = pattern.endsWith('$');
	const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[^\u0020-\u007e]/gu, (char) => encodeURIComponent(char));
	const [first = '', ...rest] = body.split('*');
	if (!path.startsWith(first)) return false;
	if (rest.length === 0) return !anchored || path.length === first.length;
	const last = /** @type {string} */ (rest.pop());
	let at = first.length;
	for (const part of rest) {
		const found = path.indexOf(part, at);
		if (found < 0) return false;
		at = found + part.length;
	}
	return anchored ? path.length - last.length >= at && path.endsWith(last) : path.includes(last, at);
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
	/** The `<loc>` of an element, or undefined. @param {string} inner */
	const locIn = (inner) => elementsOf(inner, 'loc')[0]?.inner;
	if (/<sitemapindex[\s>]/i.test(xml)) {
		const files = elementsOf(xml, 'sitemap')
			.map((sitemap) => locIn(sitemap.inner))
			.filter(/** @returns {loc is string} */ (loc) => loc !== undefined)
			.slice(0, MAX_SITEMAP_ENTRIES)
			.map(locOf);
		return { type: 'index', files, entries: [] };
	}
	if (!/<urlset[\s>]/i.test(xml)) return { type: null, files: [], entries: [] };
	/** @type {SitemapEntry[]} */
	const entries = [];
	for (const { inner } of elementsOf(xml, 'url')) {
		const loc = locIn(inner);
		if (loc === undefined) continue;
		entries.push({ loc: locOf(loc), images: [...inner.matchAll(/<(?:[\w-]+:)?image(?=[\s>])/gi)].length });
		if (entries.length >= MAX_SITEMAP_ENTRIES) break;
	}
	return { type: 'urlset', files: [], entries };
};
