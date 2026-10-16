/**
 * The words of catalog SEO (PLAN 0.8.8, SG-5, SG-21, G6): the merchant's title and description patterns filled, titles
 * that never name the store twice, and meta descriptions (the merchant's own text as written, any other text cut at a
 * word). No imports, so the admin widgets' search result preview (R7 #105) works out the same texts as the SEO
 * answers. Pure functions.
 * @module
 */

/** A meta description is cut to this many characters. */
const DESCRIPTION_LENGTH = 160;

/**
 * Plain text on one line, cut at a word to at most `max` characters (an ellipsis marks a cut).
 * @param {unknown} value
 * @param {number} max
 */
export const clip = (value, max) => {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length <= max) return text;
	const cut = text.slice(0, Math.max(0, max - 1));
	const space = cut.lastIndexOf(' ');
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** A word that only separates others in a title (`|`, `-`, `·` …). */
const SEPARATOR = /^[|\-–—·:/,•]+$/;

/**
 * A placeholder of a pattern (`{name}`, or a field's `{attr.<slug>}`), or an optional group (`[ by {brand}]`, no group
 * inside another).
 */
const PIECE = /\[([^[\]]*)\]|\{([A-Za-z][A-Za-z0-9]*(?:\.[a-z0-9-]+)?)\}/g;
/** A placeholder. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*(?:\.[a-z0-9-]+)?)\}/g;

/**
 * A merchant's pattern filled (SG-5, SG-21, G6): each `{placeholder}` of `values` replaced (in one pass: what a value
 * holds is never read as a placeholder); an optional group in square brackets that names a placeholder (`[ by
 * {brand}]`) is dropped when one of its placeholders is empty, else kept without its brackets (brackets that name none
 * stay as typed); empty brackets, and separators left at either end or doubled by an empty value, are dropped; spaces
 * collapsed. Other text stays as typed.
 * @param {string} template
 * @param {Record<string, string>} values
 */
export const fillTemplate = (template, values) => {
	/** @param {string} key */
	const known = (key) => Object.hasOwn(values, key);
	/** @param {string} text */
	const fill = (text) => text.replace(PLACEHOLDER, (all, /** @type {string} */ key) => (known(key) ? String(values[key]) : all));
	const text = String(template ?? '').replace(
		PIECE,
		(all, /** @type {string | undefined} */ group, /** @type {string | undefined} */ key) => {
			if (key !== undefined) return known(key) ? String(values[key]) : all;
			const named = [...String(group).matchAll(PLACEHOLDER)].map((match) => String(match[1])).filter(known);
			if (named.length === 0) return all;
			return named.some((name) => String(values[name]).trim() === '') ? '' : fill(String(group));
		},
	);
	/** @type {string[]} */
	const words = [];
	for (const word of text
		.replace(/\(\s*\)|\[\s*\]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)) {
		const last = words.at(-1);
		if (SEPARATOR.test(word) && (last === undefined || SEPARATOR.test(last))) continue;
		words.push(word);
	}
	while (words.length > 0 && SEPARATOR.test(/** @type {string} */ (words.at(-1)))) words.pop();
	return words.join(' ');
};

/** @param {string} char */
const isWordChar = (char) => /[\p{L}\p{N}]/u.test(char);

/**
 * Whether a text already holds a name as whole words, in any letter case (`Blue Mug — Northwind` holds `northwind`,
 * `Northwinds` does not).
 * @param {string} text
 * @param {string} name
 */
const holdsName = (text, name) => {
	const haystack = String(text ?? '').toLocaleLowerCase();
	const needle = String(name ?? '')
		.trim()
		.toLocaleLowerCase();
	if (needle === '') return false;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		const before = haystack[at - 1] ?? '';
		const after = haystack[at + needle.length] ?? '';
		if (!(before && isWordChar(before)) && !(after && isWordChar(after))) return true;
	}
	return false;
};

/**
 * A page title from the merchant's pattern (`{name} | {business}`; `{storeName}` is the same name). An empty pattern
 * is the name alone. The name in titles is never added twice (G6): when the page's part already holds it,
 * `{business}` and `{storeName}` stand for nothing (and the separators left over go).
 * @param {string} template
 * @param {{ name: string, business: string }} values `business`: the SEO brand name, else the business name
 */
export const fillTitle = (template, { name, business }) => {
	const store = holdsName(name, business) ? '' : business;
	return fillTemplate(String(template || '{name}'), { name, business: store, storeName: store }) || name;
};

/**
 * The title of a product's, category's or brand's page (G6): its own SEO title as written while its `titleMode` is
 * `as_written`; else the title pattern around its own title, else around the name from its pattern.
 * @param {string} template the `seo` setting `titleTemplate`
 * @param {{ own: string, mode: 'template' | 'as_written', name: string, business: string }} values `own`: the record's
 *   SEO title ('' = none); `name`: the page's part from its pattern
 */
export const pageTitle = (template, { own, mode, name, business }) =>
	own && mode === 'as_written' ? own : fillTitle(template, { name: own || name, business });

/**
 * The page's part of the title (`{name}` of the title pattern) from the `productTitle` or `categoryTitle` pattern
 * (SG-5): `{name}`, `{brand}`, `{category}`, `{storeName}` and, for products, the facts of {@link productFacts}; the
 * name alone when the pattern is empty or fills to nothing.
 * @param {unknown} template
 * @param {{ name: string, brand?: string, category?: string, storeName: string } & Record<string, string>} values
 */
export const pageName = (template, values) =>
	fillTemplate(String(template || '{name}'), { brand: '', category: '', ...values }) || values.name;

/**
 * A description from the `productDescription` or `categoryDescription` pattern (SG-5, SG-21), or '' when there is none.
 * @param {unknown} template
 * @param {Record<string, string>} values
 */
export const patternText = (template, values) => (template ? fillTemplate(String(template), values) : '');

/**
 * Text the merchant wrote as a meta description (a record's SEO description, a landing page's, the default
 * description): {@link metaDescription} sends it as written, never cut (G6).
 * @param {unknown} text
 * @returns {{ asWritten: string }}
 */
export const asWritten = (text) => ({ asWritten: typeof text === 'string' ? text : '' });

/**
 * The first text that is not empty, as a meta description on one line: the merchant's own text ({@link asWritten}) as
 * written (its fields hold at most 500 characters), any other text (patterns, summaries, descriptions) cut at a word to
 * at most 160 characters (G6).
 * @param {...(string | { asWritten: string } | null | undefined)} texts
 */
export const metaDescription = (...texts) => {
	for (const text of texts) {
		const own = typeof text === 'object' && text !== null;
		const value = own ? text.asWritten : text;
		if (typeof value !== 'string' || value.trim() === '') continue;
		return own ? value.replace(/\s+/g, ' ').trim() : clip(value, DESCRIPTION_LENGTH);
	}
	return '';
};

/** A summary this long or longer is a written description; a shorter one gives way to the description pattern (G6). */
const WRITTEN_SUMMARY = 50;

/**
 * A product's summary when it is long enough to describe the page (at least {@link WRITTEN_SUMMARY} characters), else
 * '' (the description pattern's facts describe it better).
 * @param {string} summary
 */
export const writtenSummary = (summary) => (summary.trim().length >= WRITTEN_SUMMARY ? summary : '');
