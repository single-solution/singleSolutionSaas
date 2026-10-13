/**
 * The catalog's content fields that products, categories, brands, attributes, grades and landing pages share (PLAN
 * 0.8.10 E1, E3, E4, E6, E16): SEO fields (title, description, canonical address, social image, noindex, nofollow,
 * focus keyword), FAQs, content blocks (a summary and bullets with icons), rich descriptions cleaned to a short list
 * of tags, product videos and the extra sizes of a photo. Every check reads `input` over `existing`, so a change can
 * name only what it changes. No I/O.
 * @module
 */

/** @typedef {{ path: string, message: string }} FieldError */

/**
 * @typedef {object} SeoFields
 * @property {string} title '' = derived from the name
 * @property {string} description '' = derived from the summary or description
 * @property {string} canonicalUrl '' = the page's own address; else an https address or a path on the website
 * @property {string} ogImage '' = the main image; else an https address or a path on the website
 * @property {boolean} noindex
 * @property {boolean} nofollow
 * @property {string} focusKeyword
 */

/**
 * SEO fields as records keep them (records saved before E16 hold only the title and description).
 * @typedef {{ title: string, description: string } & Partial<SeoFields>} SeoRecord
 */

/** @typedef {{ question: string, answer: string }} Faq */
/** @typedef {{ summary: string, bullets: Array<{ text: string, icon: string }> }} Content */

/**
 * A product video (E4): a file in the merchant's storage (MP4 or WebM), a YouTube video or an https address.
 * @typedef {{ kind: 'file', key: string, type: string, size: number } | { kind: 'youtube', id: string } |
 *   { kind: 'url', url: string }} Video
 */

/** Limits of these fields. */
export const CONTENT_LIMITS = Object.freeze({
	seoTitle: 200,
	seoDescription: 500,
	address: 500,
	focusKeyword: 100,
	question: 300,
	answer: 4000,
	summary: 2000,
	bullets: 12,
	bullet: 300,
	icon: 40,
	html: 20_000,
	blur: 2048,
	pixels: 100_000,
	sizeKey: 500,
});

/** The video types a product may have. */
export const VIDEO_TYPES = Object.freeze({ 'video/mp4': 'mp4', 'video/webm': 'webm' });

/** The extra sizes an uploader may make of a photo (E6). */
export const MEDIA_SIZES = Object.freeze(/** @type {const} */ (['thumb', 'card', 'detail']));

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Trimmed text without control characters, or null when not text or too long.
 * @param {unknown} value @param {number} max @param {boolean} [multiline]
 * @returns {string | null}
 */
const text = (value, max, multiline = false) => {
	if (typeof value !== 'string') return null;
	const flat = multiline ? value.replace(/\r\n?/g, '\n') : value.replace(/[\r\n\t]+/g, ' ');
	const out = flat.replace(CONTROL, '').trim();
	return out.length > max ? null : out;
};

/**
 * An address the website links to: '' (none), an https address, or a path on the website (`/…`, never `//…`).
 * @param {unknown} value
 * @returns {string | null}
 */
export const siteAddress = (value) => {
	const address = text(value, CONTENT_LIMITS.address);
	if (address === null) return null;
	if (address === '') return '';
	// a path on the website: never `//host` or `/\host` (browsers read both as another host), nor a backslash anywhere
	if (address.startsWith('/') && !address.startsWith('//') && !/[\s\\]/.test(address)) return address;
	try {
		const url = new URL(address);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
};

/** SEO fields with nothing set. @type {Readonly<SeoFields>} */
export const EMPTY_SEO = Object.freeze({
	title: '',
	description: '',
	canonicalUrl: '',
	ogImage: '',
	noindex: false,
	nofollow: false,
	focusKeyword: '',
});

/**
 * Check SEO fields given over the existing ones (missing fields keep their value).
 * @param {unknown} value
 * @param {Partial<SeoFields> | null | undefined} existing
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {SeoFields}
 */
export const checkSeo = (value, existing, path, errors) => {
	const before = { ...EMPTY_SEO, ...(existing ?? {}) };
	if (value === undefined) return before;
	if (!isObject(value)) {
		errors.push({ path, message: 'Give the SEO fields as an object.' });
		return before;
	}
	/**
	 * @template T
	 * @param {keyof SeoFields} name @param {(v: unknown) => T | null} read @param {string} message
	 * @returns {T}
	 */
	const read = (name, read, message) => {
		if (value[name] === undefined) return /** @type {T} */ (before[name]);
		const out = read(value[name]);
		if (out === null) {
			errors.push({ path: `${path}/${name}`, message });
			return /** @type {T} */ (before[name]);
		}
		return out;
	};
	/** @param {unknown} v */
	const flag = (v) => (typeof v === 'boolean' ? v : null);
	return {
		title: read(
			'title',
			(v) => text(v, CONTENT_LIMITS.seoTitle),
			`An SEO title has at most ${CONTENT_LIMITS.seoTitle} characters.`,
		),
		description: read(
			'description',
			(v) => text(v, CONTENT_LIMITS.seoDescription),
			`An SEO description has at most ${CONTENT_LIMITS.seoDescription} characters.`,
		),
		canonicalUrl: read('canonicalUrl', siteAddress, 'The canonical address is an https address or a path on your website.'),
		ogImage: read('ogImage', siteAddress, 'The social image is an https address or a path on your website.'),
		noindex: read('noindex', flag, 'noindex is true or false.'),
		nofollow: read('nofollow', flag, 'nofollow is true or false.'),
		focusKeyword: read(
			'focusKeyword',
			(v) => text(v, CONTENT_LIMITS.focusKeyword),
			`A focus keyword has at most ${CONTENT_LIMITS.focusKeyword} characters.`,
		),
	};
};

/**
 * Check a list of FAQs.
 * @param {unknown} value
 * @param {number} max
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {Faq[] | null} null when invalid (the error is recorded)
 */
export const checkFaqs = (value, max, path, errors) => {
	if (!Array.isArray(value) || value.length > max) {
		errors.push({ path, message: `Give at most ${max} questions with their answers.` });
		return null;
	}
	/** @type {Faq[]} */
	const out = [];
	for (const [index, entry] of value.entries()) {
		const question = isObject(entry) ? text(entry.question, CONTENT_LIMITS.question) : null;
		const answer = isObject(entry) ? text(entry.answer, CONTENT_LIMITS.answer, true) : null;
		if (!question || !answer) {
			errors.push({
				path: `${path}/${index}`,
				message: `A question has 1 to ${CONTENT_LIMITS.question} characters and its answer 1 to ${CONTENT_LIMITS.answer}.`,
			});
			return null;
		}
		out.push({ question, answer });
	}
	return out;
};

/** A content block with nothing in it. @type {Readonly<Content>} */
export const EMPTY_CONTENT = Object.freeze({ summary: '', bullets: [] });

/**
 * Check a content block: a summary and at most 12 bullets, each a text with an optional icon name.
 * @param {unknown} value
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {Content | null}
 */
export const checkContent = (value, path, errors) => {
	if (!isObject(value)) {
		errors.push({ path, message: 'Give the content as { summary, bullets }.' });
		return null;
	}
	const summary = value.summary === undefined ? '' : text(value.summary, CONTENT_LIMITS.summary, true);
	if (summary === null) {
		errors.push({ path: `${path}/summary`, message: `A summary has at most ${CONTENT_LIMITS.summary} characters.` });
		return null;
	}
	const raw = value.bullets === undefined ? [] : value.bullets;
	if (!Array.isArray(raw) || raw.length > CONTENT_LIMITS.bullets) {
		errors.push({ path: `${path}/bullets`, message: `Give at most ${CONTENT_LIMITS.bullets} bullets.` });
		return null;
	}
	/** @type {Content['bullets']} */
	const bullets = [];
	for (const [index, entry] of raw.entries()) {
		const line = isObject(entry) ? text(entry.text, CONTENT_LIMITS.bullet) : text(entry, CONTENT_LIMITS.bullet);
		const icon = isObject(entry) && entry.icon !== undefined ? text(entry.icon, CONTENT_LIMITS.icon) : '';
		if (!line || icon === null) {
			errors.push({
				path: `${path}/bullets/${index}`,
				message: `A bullet has 1 to ${CONTENT_LIMITS.bullet} characters and an icon name of at most ${CONTENT_LIMITS.icon}.`,
			});
			return null;
		}
		bullets.push({ text: line, icon });
	}
	return { summary, bullets };
};

/**
 * An icon name (a name the website maps to its own icon), or null when invalid.
 * @param {unknown} value
 */
export const iconOf = (value) => text(value, CONTENT_LIMITS.icon);

// ---------------------------------------------------------------------------------------------- rich text (E3)

/** The tags a rich description may hold; `a` keeps only an https, site-relative, `mailto:` or `tel:` `href`. */
const HTML_TAGS = new Set(['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a']);
/** Elements dropped with everything inside them. */
const DROPPED = new Set([
	'script',
	'style',
	'iframe',
	'object',
	'embed',
	'template',
	'noscript',
	'svg',
	'math',
	'textarea',
	'select',
]);
/** Tags that start a new line in plain text. */
const BLOCKS = new Set(['p', 'br', 'li', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'div']);
/** Equivalent tags folded into the allowed ones. */
const SYNONYMS = Object.freeze(/** @type {Record<string, string>} */ ({ b: 'strong', i: 'em' }));

/** Named entities decoded in text. */
const ENTITIES = Object.freeze(
	/** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }),
);

/**
 * Text with HTML entities decoded (named ones of {@link ENTITIES} and numeric ones).
 * @param {string} value
 */
export const decodeEntities = (value) =>
	value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (match, name) => {
		const lower = String(name).toLowerCase();
		if (lower.startsWith('#')) {
			const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
		}
		return Object.hasOwn(ENTITIES, lower) ? /** @type {string} */ (ENTITIES[lower]) : match;
	});

/** @param {string} value */
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A contact link (SF-1): an e-mail address or a phone number, nothing a browser could run. */
const CONTACT_LINK = /^(?:mailto:[^\s"'<>\\]{3,254}|tel:\+?[0-9][0-9 ().-]{2,30})$/i;

/**
 * The `href` of an `a` tag, kept only when it is an https address, a path on the website, or a `mailto:` or `tel:`
 * link.
 * @param {string} attributes the tag's attribute text
 */
const hrefOf = (attributes) => {
	const found = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
	if (!found) return '';
	const raw = decodeEntities(found[1] ?? found[2] ?? found[3] ?? '').trim();
	return CONTACT_LINK.test(raw) ? raw : (siteAddress(raw) ?? '');
};

/**
 * Clean rich text to the allowed tags (PLAN 0.8.10 E3): `p`, `br`, `strong`, `em`, `u`, `ul`, `ol`, `li`, `h2`, `h3`,
 * `h4`, `blockquote` and `a` with an https, site-relative, `mailto:` or `tel:` `href` (SF-1). Every other tag is
 * dropped (scripts, styles and frames with their content), attributes are removed, text is escaped, and tags are
 * balanced. The result is safe to insert as HTML.
 * @param {string} html
 */
export const cleanHtml = (html) => {
	let out = '';
	/** @type {string[]} */
	const open = [];
	/** @type {string | null} the dropped element being skipped */
	let skipping = null;
	const pattern = /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<[!?][^>]*>?|([^<]+)|</g;
	for (const match of html.matchAll(pattern)) {
		const [whole, rawName, attributes = '', textPart] = match;
		if (skipping) {
			if (rawName && whole.startsWith('</') && rawName.toLowerCase() === skipping) skipping = null;
			continue;
		}
		if (textPart !== undefined || whole === '<') {
			out += escapeHtml(decodeEntities(textPart ?? '<'));
			continue;
		}
		if (!rawName) continue; // comments, doctypes, processing instructions
		const lower = rawName.toLowerCase();
		const name = SYNONYMS[lower] ?? lower;
		const closing = whole.startsWith('</');
		if (DROPPED.has(lower)) {
			if (!closing && !/\/\s*$/.test(attributes)) skipping = lower;
			continue;
		}
		if (!HTML_TAGS.has(name)) continue;
		if (name === 'br') {
			if (!closing) out += '<br>';
			continue;
		}
		if (closing) {
			const at = open.lastIndexOf(name);
			if (at === -1) continue;
			while (open.length > at) out += `</${open.pop()}>`;
			continue;
		}
		if (name === 'a') {
			const href = hrefOf(attributes);
			out += href ? `<a href="${escapeHtml(href)}">` : '<a>';
		} else out += `<${name}>`;
		open.push(name);
	}
	while (open.length > 0) out += `</${open.pop()}>`;
	return out.replace(/<(p|strong|em|u|h2|h3|h4|blockquote|li|ul|ol|a)>\s*<\/\1>/g, '').trim();
};

/**
 * Plain text from rich text: block tags become line breaks (paragraphs a blank line), entities decoded.
 * @param {string} html
 */
export const htmlToText = (html) =>
	decodeEntities(
		html
			.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
			.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (_, name) => (BLOCKS.has(String(name).toLowerCase()) ? '\n' : '')),
	)
		.replace(/\u00a0/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

/**
 * Check rich text: at most 20,000 characters as given, then cleaned.
 * @param {unknown} value
 * @returns {string | null} '' clears it; null when invalid
 */
export const checkHtml = (value) => {
	if (typeof value !== 'string' || value.length > CONTENT_LIMITS.html) return null;
	return cleanHtml(value);
};

// -------------------------------------------------------------------------------------------------- video (E4)

/** YouTube video ids. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * A YouTube id from an id or a YouTube address, or null.
 * @param {unknown} value
 */
export const youtubeId = (value) => {
	if (typeof value !== 'string') return null;
	const raw = value.trim();
	if (YOUTUBE_ID.test(raw)) return raw;
	try {
		const url = new URL(raw);
		const host = url.hostname.replace(/^www\.|^m\./, '');
		const id =
			host === 'youtu.be'
				? url.pathname.slice(1)
				: host === 'youtube.com' || host === 'youtube-nocookie.com'
					? (url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean).at(-1) ?? '')
					: '';
		return YOUTUBE_ID.test(id) ? id : null;
	} catch {
		return null;
	}
};

/**
 * Check a product video as given (a file's type and size are filled in by the route from the bucket).
 * @param {unknown} value
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {{ kind: 'file', key: string } | { kind: 'youtube', id: string } | { kind: 'url', url: string } | null | undefined}
 *   undefined when invalid
 */
export const checkVideo = (value, path, errors) => {
	if (value === null) return null;
	const kind = isObject(value) ? value.kind : undefined;
	if (kind === 'file' && isObject(value) && typeof value.key === 'string' && value.key.length <= CONTENT_LIMITS.sizeKey)
		return { kind: 'file', key: value.key };
	if (kind === 'youtube' && isObject(value)) {
		const id = youtubeId(value.id ?? value.url);
		if (id) return { kind: 'youtube', id };
	}
	if (kind === 'url' && isObject(value)) {
		const url = siteAddress(value.url);
		if (url && url.startsWith('https://')) return { kind: 'url', url };
	}
	errors.push({
		path,
		message: 'A video is { kind: "file", key }, { kind: "youtube", id } or { kind: "url", url } (https), or null.',
	});
	return undefined;
};

// --------------------------------------------------------------------------------------------- photo sizes (E6)

/**
 * The extra fields of a photo (E6): `sizes` (storage keys of smaller copies the uploader made, under the same folder),
 * `width`, `height` and `blur` (a small data URI image).
 * @param {Record<string, any>} input
 * @param {string} folder the storage folder the keys must be in (`ecommerce/products/<id>/`)
 * @param {string} path
 * @param {FieldError[]} errors
 * @returns {{ sizes?: Partial<Record<'thumb' | 'card' | 'detail', string>>, width?: number, height?: number, blur?: string }}
 */
export const mediaExtras = (input, folder, path, errors) => {
	/** @type {{ sizes?: Partial<Record<'thumb' | 'card' | 'detail', string>>, width?: number, height?: number, blur?: string }} */
	const out = {};
	if (input.sizes !== undefined && input.sizes !== null) {
		if (!isObject(input.sizes)) errors.push({ path: `${path}/sizes`, message: 'Give the sizes as { thumb, card, detail }.' });
		else {
			/** @type {Partial<Record<'thumb' | 'card' | 'detail', string>>} */
			const sizes = {};
			for (const [name, key] of Object.entries(input.sizes)) {
				if (key === null || key === undefined || key === '') continue;
				if (!MEDIA_SIZES.includes(/** @type {any} */ (name)))
					errors.push({ path: `${path}/sizes/${name}`, message: 'Sizes are thumb, card and detail.' });
				else if (
					typeof key !== 'string' ||
					!key.startsWith(folder) ||
					key.includes('..') ||
					key.length > CONTENT_LIMITS.sizeKey
				)
					errors.push({ path: `${path}/sizes/${name}`, message: 'Give the key of an upload made for this record.' });
				else sizes[/** @type {'thumb' | 'card' | 'detail'} */ (name)] = key;
			}
			out.sizes = sizes;
		}
	}
	for (const name of /** @type {const} */ (['width', 'height'])) {
		const value = input[name];
		if (value === undefined || value === null) continue;
		if (!Number.isSafeInteger(value) || value < 1 || value > CONTENT_LIMITS.pixels)
			errors.push({ path: `${path}/${name}`, message: `The ${name} is a whole number of pixels from 1.` });
		else out[name] = value;
	}
	if (input.blur !== undefined && input.blur !== null && input.blur !== '') {
		if (
			typeof input.blur !== 'string' ||
			input.blur.length > CONTENT_LIMITS.blur ||
			!/^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(input.blur)
		)
			errors.push({
				path: `${path}/blur`,
				message: `The blur image is a base64 data URI image of at most ${CONTENT_LIMITS.blur} characters.`,
			});
		else out.blur = input.blur;
	}
	return out;
};
