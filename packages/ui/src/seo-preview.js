/**
 * `@ss/ui/seo-preview` — the search result and share card preview of a page (R7 #105), framework-free so the product
 * widgets (plain DOM in a Shadow DOM) and the React dashboards (`<SeoPreview>`) draw the same part.
 *
 * The title and description are measured by their width in pixels, never by counting characters, so the preview holds
 * for any language and script: in a browser with a canvas (`OffscreenCanvas`) by the font Google uses, else by an
 * estimate (Arial's widths for Latin letters, accented letters as their base letter, a full em for Chinese, Japanese,
 * Korean and emoji, nothing for combining marks). Past Google's usual widths ({@link SERP_LIMITS}) the text is cut at
 * a word (between characters for scripts without spaces, never inside one) with an ellipsis, and a "may be cut"
 * warning shows. The share card shows the image at 1.91 : 1, the domain, the title and the description.
 *
 * Every word is the caller's (`texts`, English defaults in {@link SEO_PREVIEW_TEXTS}); text is always set as text.
 * Widgets add {@link SEO_PREVIEW_CSS} to their own CSS; `<SeoPreview>` adds it to the document once.
 * @module
 */

/** Google's usual widths: a title is cut past 600 px at 20 px Arial, a description past 920 px at 14 px Arial. */
export const SERP_LIMITS = Object.freeze({
	title: Object.freeze({ font: '20px arial, sans-serif', width: 600 }),
	description: Object.freeze({ font: '14px arial, sans-serif', width: 920 }),
});

/** The preview's words in US English (a caller passes its own, for example its widget texts). */
export const SEO_PREVIEW_TEXTS = Object.freeze({
	result: 'Search result preview',
	card: 'Share preview',
	noTitle: 'No title: search engines write one from the page.',
	noDescription: 'No description: search engines show text from the page.',
	noImage: 'No share image',
	titleWidth: 'Title: {width} of {limit} px',
	descriptionWidth: 'Description: {width} of {limit} px',
	titleCut: 'The title may be cut in search results.',
	descriptionCut: 'The description may be cut in search results.',
});

/** Arial's advance widths (thousandths of an em) of the printable ASCII characters, from space (32) to `~` (126). */
const ARIAL = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556,
	556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778,
	722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
	500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** The width of a letter of another script (an average Arial letter). */
const OTHER = 556;
/** Code point ranges a full em wide: Hangul, CJK, Yi, full-width forms, emoji and the CJK supplements. */
const WIDE = Object.freeze([
	[0x1100, 0x115f],
	[0x2e80, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1faff],
	[0x20000, 0x3fffd],
]);
/** Code point ranges with no width of their own: conjoining Hangul vowels and finals, zero-width characters. */
const ZERO = Object.freeze([
	[0x1160, 0x11ff],
	[0x200b, 0x200f],
	[0x2060, 0x2060],
	[0xfe00, 0xfe0f],
	[0xfeff, 0xfeff],
]);
const MARK = /\p{M}/u;

/**
 * @param {number} code
 * @param {ReadonlyArray<ReadonlyArray<number>>} ranges
 */
const within = (code, ranges) => ranges.some(([from = 0, to = 0]) => code >= from && code <= to);

/**
 * The width of one character, in thousandths of an em.
 * @param {string} char one code point
 */
const charWidth = (char) => {
	const own = /** @type {number} */ (char.codePointAt(0));
	if (MARK.test(char) || within(own, ZERO)) return 0;
	if (within(own, WIDE)) return 1000;
	const code = /** @type {number} */ (char.normalize('NFD').codePointAt(0));
	if (code >= 32 && code <= 126) return /** @type {number} */ (ARIAL[code - 32]);
	return code < 32 ? 0 : OTHER;
};

/**
 * The estimated width in pixels of a text at a font size, for when there is no canvas to measure with.
 * @param {string} text
 * @param {number} size font size in pixels
 */
export const estimateWidth = (text, size) => {
	let total = 0;
	for (const char of String(text)) total += charWidth(char);
	return (total * size) / 1000;
};

/** @typedef {(text: string, font: string) => number} Measure the width in pixels of a text in a CSS font */
/** @typedef {{ font: string, measureText: (text: string) => { width: number } }} Context2d */

/** @param {string} font */
const sizeOf = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);

/**
 * A measure on a canvas 2D context, or the estimate without one.
 * @param {Context2d | null | undefined} context
 * @returns {Measure}
 */
export const measureOf = (context) => (text, font) => {
	const canvas = context;
	if (!canvas) return estimateWidth(text, sizeOf(font));
	canvas.font = font;
	return canvas.measureText(text).width;
};

/** @type {Measure | null} */
let browserMeasure = null;

/** The browser's measure: an `OffscreenCanvas` when there is one, else the estimate. */
const defaultMeasure = () => {
	if (!browserMeasure) {
		/** @type {Context2d | null} */
		let context = null;
		try {
			const Canvas = /** @type {any} */ (globalThis).OffscreenCanvas;
			if (typeof Canvas === 'function') context = new Canvas(1, 1).getContext('2d');
		} catch {
			context = null;
		}
		browserMeasure = measureOf(context);
	}
	return browserMeasure;
};

/**
 * The characters of a text as a reader sees them (an emoji with its skin tone, a letter with its marks), so a cut never
 * falls inside one.
 * @param {string} text
 * @returns {string[]}
 */
const charactersOf = (text) => {
	const Segmenter = /** @type {any} */ (Intl).Segmenter;
	if (typeof Segmenter === 'function')
		return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
	return Array.from(text);
};

/**
 * A text fitted into a width: as it is when it fits, else cut at a word (between characters when the kept part has no
 * space late enough) with an ellipsis. `width` is the whole text's width.
 * @param {string} text
 * @param {number} limit
 * @param {Measure} measure
 * @param {string} font
 * @returns {{ text: string, cut: boolean, width: number }}
 */
export const fitWidth = (text, limit, measure, font) => {
	const width = measure(text, font);
	if (width <= limit) return { text, cut: false, width };
	const parts = charactersOf(text);
	const fits = (/** @type {number} */ count) => measure(`${parts.slice(0, count).join('').trimEnd()}…`, font) <= limit;
	let low = 0;
	let high = parts.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) low = middle;
		else high = middle - 1;
	}
	let kept = parts.slice(0, low).join('');
	const space = kept.search(/\s\S*$/);
	if (space > kept.length * 0.6) kept = kept.slice(0, space);
	return { text: `${kept.trimEnd()}…`, cut: true, width };
};

/**
 * The host (without `www.`) and the breadcrumb Google shows for an address (`https://shop.example.com › products ›
 * blue-mug`); both '' when it is not an address.
 * @param {string} url
 */
export const breadcrumbOf = (url) => {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { host: '', trail: '' };
		const host = parsed.hostname.replace(/^www\./, '');
		const parts = parsed.pathname
			.split('/')
			.filter(Boolean)
			.map((part) => {
				try {
					return decodeURIComponent(part);
				} catch {
					return part;
				}
			});
		return { host, trail: [`${parsed.protocol}//${host}`, ...parts].join(' › ') };
	} catch {
		return { host: '', trail: '' };
	}
};

/**
 * @typedef {object} SeoPreviewInput what search engines and share cards get for the page
 * @property {string} [title] the final page title
 * @property {string} [description] the final meta description
 * @property {string} [url] the page's address (its canonical address)
 * @property {string} [siteName] the site's name (else its host)
 * @property {string} [image] the share image: an http(s) address, or a path on the page's site
 */

/** @param {unknown} value */
const line = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * The share image as an address the preview may load, or ''.
 * @param {string} image
 * @param {string} url
 */
const imageOf = (image, url) => {
	if (/^https?:\/\//i.test(image)) return image;
	if (!image.startsWith('/') || image.startsWith('//')) return '';
	try {
		return new URL(image, url).toString();
	} catch {
		return '';
	}
};

/**
 * What the preview shows: the site, the breadcrumb, the title and description fitted to Google's usual widths (with
 * each one's width and limit) and the share card.
 * @param {SeoPreviewInput} input
 * @param {Measure} [measure]
 */
export const seoPreviewModel = (input, measure = defaultMeasure()) => {
	const url = line(input.url);
	const { host, trail } = breadcrumbOf(url);
	const title = line(input.title);
	const description = line(input.description);
	/** @param {string} text @param {{ font: string, width: number }} limit */
	const fitted = (text, limit) => ({
		...fitWidth(text, limit.width, measure, limit.font),
		limit: limit.width,
		empty: text === '',
	});
	return {
		site: line(input.siteName) || host,
		trail,
		title: fitted(title, SERP_LIMITS.title),
		description: fitted(description, SERP_LIMITS.description),
		card: { domain: host, title, description, image: imageOf(line(input.image), url) },
	};
};

/**
 * @param {string} text
 * @param {Record<string, string | number>} values
 */
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));

/**
 * The preview as DOM: `node` to place, `update(input)` to redraw it (as the merchant types).
 * @param {Document} doc
 * @param {SeoPreviewInput} input
 * @param {{ texts?: Partial<Record<keyof typeof SEO_PREVIEW_TEXTS, string>>, measure?: Measure }} [options]
 */
export const seoPreview = (doc, input, options = {}) => {
	const words = { ...SEO_PREVIEW_TEXTS, ...options.texts };
	const measure = options.measure ?? defaultMeasure();
	/**
	 * @param {string} tag @param {string} [className] @param {string} [text] @param {Record<string, string>} [attributes]
	 */
	const h = (tag, className, text, attributes = {}) => {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
		return node;
	};
	const node = h('div', 'ss-seo');
	/** @param {SeoPreviewInput} next */
	const draw = (next) => {
		const model = seoPreviewModel(next, measure);
		const result = h('section', 'ss-seo-result', undefined, { 'data-part': 'result', 'aria-label': words.result });
		const site = h('div', 'ss-seo-site');
		const names = h('span');
		names.append(h('span', 'ss-seo-name', model.site), h('span', 'ss-seo-trail', model.trail));
		site.append(h('span', 'ss-seo-icon', charactersOf(model.site)[0]?.toUpperCase() ?? '', { 'aria-hidden': 'true' }), names);
		const meter = h(
			'p',
			'ss-seo-meter',
			[
				fill(words.titleWidth, { width: Math.round(model.title.width), limit: model.title.limit }),
				fill(words.descriptionWidth, { width: Math.round(model.description.width), limit: model.description.limit }),
			].join(' · '),
		);
		result.append(
			h('p', 'ss-seo-head', words.result),
			site,
			model.title.empty
				? h('p', 'ss-seo-title ss-seo-empty', words.noTitle)
				: h('p', 'ss-seo-title', model.title.text, { dir: 'auto' }),
			model.description.empty
				? h('p', 'ss-seo-text ss-seo-empty', words.noDescription)
				: h('p', 'ss-seo-text', model.description.text, { dir: 'auto' }),
			meter,
		);
		const warnings = [model.title.cut ? words.titleCut : '', model.description.cut ? words.descriptionCut : ''].filter(Boolean);
		if (warnings.length > 0) {
			const warn = h('p', 'ss-seo-warn', undefined, { role: 'status' });
			warn.append(...warnings.map((text) => h('span', '', text)));
			result.append(warn);
		}
		const card = h('section', 'ss-seo-card', undefined, { 'data-part': 'card', 'aria-label': words.card });
		const frame = h('div', 'ss-seo-frame');
		const body = h('div', 'ss-seo-body');
		body.append(
			h('span', 'ss-seo-domain', model.card.domain),
			h('strong', 'ss-seo-ctitle', model.card.title || model.site, { dir: 'auto' }),
			h('span', 'ss-seo-cdesc', model.card.description, { dir: 'auto' }),
		);
		frame.append(
			model.card.image
				? h('img', '', undefined, {
						src: model.card.image,
						alt: '',
						loading: 'lazy',
						decoding: 'async',
						referrerpolicy: 'no-referrer',
					})
				: h('div', 'ss-seo-noimage', words.noImage),
			body,
		);
		card.append(h('p', 'ss-seo-head', words.card), frame);
		node.replaceChildren(result, card);
	};
	draw(input);
	return { node, update: draw };
};

const DARK = '--ss-seo-link: #99c3ff; --ss-seo-muted: #bdc1c6; --ss-seo-warn: #fbbf24;';

/** The preview's styles: Google's colors in light and dark (a widget's mode, the dashboard theme or the device). */
export const SEO_PREVIEW_CSS = `
.ss-seo { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); margin: 12px 0 0;
  --ss-seo-link: #1a0dab; --ss-seo-muted: #4d5156; --ss-seo-warn: #b45309; --ss-seo-line: rgba(127, 127, 127, 0.3);
  --ss-seo-panel: rgba(127, 127, 127, 0.08); }
:host([data-ss-mode='dark']) .ss-seo { ${DARK} }
:root[data-theme='dark'] .ss-seo { ${DARK} }
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) .ss-seo { ${DARK} } }
.ss-seo > section { min-width: 0; border: 1px solid var(--ss-seo-line); border-radius: var(--ss-radius, 8px); padding: 12px; }
.ss-seo p { margin: 0; }
.ss-seo .ss-seo-head { margin: 0 0 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ss-seo-muted); }
.ss-seo-result { font-family: arial, sans-serif; }
.ss-seo-site { display: flex; gap: 8px; align-items: center; min-width: 0; }
.ss-seo-site > span:last-child { display: grid; min-width: 0; }
.ss-seo-icon { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--ss-seo-panel); font-size: 12px; font-weight: 700; }
.ss-seo-name, .ss-seo-trail, .ss-seo-domain { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-seo-name { font-size: 14px; }
.ss-seo-trail { font-size: 12px; color: var(--ss-seo-muted); }
.ss-seo .ss-seo-title { margin: 6px 0 2px; font-size: 20px; line-height: 1.3; color: var(--ss-seo-link); overflow-wrap: anywhere; }
.ss-seo-text { font-size: 14px; line-height: 1.58; color: var(--ss-seo-muted); overflow-wrap: anywhere; }
.ss-seo-empty { font-style: italic; }
.ss-seo .ss-seo-meter { margin: 8px 0 0; font-size: 12px; color: var(--ss-seo-muted); }
.ss-seo .ss-seo-warn { margin: 4px 0 0; font-size: 12px; color: var(--ss-seo-warn); }
.ss-seo-warn span { display: block; }
.ss-seo-frame { overflow: hidden; border: 1px solid var(--ss-seo-line); border-radius: var(--ss-radius, 8px); }
.ss-seo-frame img, .ss-seo-noimage { display: block; width: 100%; aspect-ratio: 1.91 / 1; object-fit: cover; background: var(--ss-seo-panel); }
.ss-seo-noimage { display: grid; place-items: center; font-size: 12px; color: var(--ss-seo-muted); }
.ss-seo-body { display: grid; gap: 2px; padding: 8px 12px; background: var(--ss-seo-panel); }
.ss-seo-domain { font-size: 12px; text-transform: uppercase; color: var(--ss-seo-muted); }
.ss-seo-ctitle, .ss-seo-cdesc { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.ss-seo-ctitle { font-size: 15px; }
.ss-seo-cdesc { font-size: 13px; color: var(--ss-seo-muted); }
`;
