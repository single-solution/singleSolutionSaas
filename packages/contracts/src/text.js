/**
 * Text helpers every unit shares (`@ss/contracts/text`): HTML escaping and character references, the widget script
 * tag, the support contact channels, path patterns and the Luhn check digit. Pure and browser-safe (no Node.js
 * imports), so servers, products' `core/` and widget bundles use the same code.
 * @module
 */
import { normalizeEmail } from './email.js';

// ------------------------------------------------------------------------------------------------------------- HTML

/** The characters HTML gives a meaning, as decimal character references (valid in HTML, XML and SVG alike). */
const HTML_SPECIAL = /[&<>"']/g;

/**
 * Text safe inside an HTML (or XML) element and inside a quoted attribute: `&`, `<`, `>`, `"` and `'` become `&#38;`,
 * `&#60;`, `&#62;`, `&#34;` and `&#39;`. Null and undefined become ''; any other value its `String` form.
 * @param {unknown} value
 * @returns {string}
 */
export const escapeHtml = (value) =>
	String(value ?? '').replace(HTML_SPECIAL, (char) => `&#${/** @type {string} */ (char).charCodeAt(0)};`);

/** The Latin-1 named references, in code point order from U+00A0 (`&nbsp;`) to U+00FF (`&yuml;`). */
const LATIN1_NAMES =
	'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro ' +
	'para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil ' +
	'Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave ' +
	'Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml ' +
	'igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute ' +
	'thorn yuml';

/** The other named references decoded (name:hexadecimal code point): markup, punctuation and usual symbols. */
const OTHER_NAMES =
	'quot:22 amp:26 apos:27 lt:3C gt:3E QUOT:22 AMP:26 LT:3C GT:3E COPY:A9 REG:AE OElig:152 oelig:153 Scaron:160 ' +
	'scaron:161 Yuml:178 fnof:192 circ:2C6 tilde:2DC ensp:2002 emsp:2003 thinsp:2009 zwnj:200C zwj:200D lrm:200E ' +
	'rlm:200F ndash:2013 mdash:2014 lsquo:2018 rsquo:2019 sbquo:201A ldquo:201C rdquo:201D bdquo:201E dagger:2020 ' +
	'Dagger:2021 bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203A oline:203E ' +
	'frasl:2044 euro:20AC trade:2122 larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 minus:2212';

/** Named reference → its text (names are case-sensitive, as in HTML). */
const NAMED = new Map([
	...LATIN1_NAMES.split(' ').map((name, index) => /** @type {[string, string]} */ ([name, String.fromCodePoint(0xa0 + index)])),
	...OTHER_NAMES.split(' ').map((entry) => {
		const [name = '', hex = ''] = entry.split(':');
		return /** @type {[string, string]} */ ([name, String.fromCodePoint(Number.parseInt(hex, 16))]);
	}),
]);

/** Numeric references to U+0080–U+009F that HTML reads as windows-1252 (hexadecimal reference:code point). */
const WINDOWS_1252 = new Map(
	(
		'80:20AC 82:201A 83:192 84:201E 85:2026 86:2020 87:2021 88:2C6 89:2030 8A:160 8B:2039 8C:152 8E:17D 91:2018 ' +
		'92:2019 93:201C 94:201D 95:2022 96:2013 97:2014 98:2DC 99:2122 9A:161 9B:203A 9C:153 9E:17E 9F:178'
	)
		.split(' ')
		.map((entry) => {
			const [from = '', to = ''] = entry.split(':');
			return /** @type {[number, number]} */ ([Number.parseInt(from, 16), Number.parseInt(to, 16)]);
		}),
);

const REFERENCE = /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*));/g;

/**
 * The text of a numeric character reference, as HTML reads it: 0, surrogates and numbers past U+10FFFF become U+FFFD
 * (the replacement character), U+0080–U+009F the windows-1252 character.
 * @param {number} code
 */
const characterOf = (code) =>
	code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
		? '\uFFFD'
		: String.fromCodePoint(WINDOWS_1252.get(code) ?? code);

/**
 * A text with its character references decoded: decimal (`&#36;`) and hexadecimal (`&#x20B9;`) ones, and the named ones
 * of Latin-1 and usual punctuation (`&amp;`, `&nbsp;` as U+00A0, `&eacute;`, `&rsquo;`, `&hellip;`, `&euro;` …; names
 * are case-sensitive). A reference needs its `;`; an unknown name stays as written. Invalid code points never throw or
 * make broken text: they become U+FFFD.
 * @param {string} text
 * @returns {string}
 */
export const decodeEntities = (text) =>
	text.replace(REFERENCE, (match, decimal, hex, name) =>
		name !== undefined
			? (NAMED.get(name) ?? match)
			: characterOf(decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16)),
	);

/**
 * The tag that loads a product's widget script on a website (the install snippet of the Portal and of each product's
 * docs): `<script src="…" data-token="…" async></script>`, its attribute values escaped.
 * @param {{ src: string, token?: string | null, loading?: 'async' | 'blocking' }} options `src`: the script's
 *   address; `token`: the website's browser token (null or left out: no `data-token`); `loading` (the manifest's
 *   `widgetScriptLoading`, default `async`): `blocking` for a script that must run in page order (no `async`)
 * @returns {string}
 */
export const widgetScriptTag = ({ src, token = null, loading = 'async' }) =>
	`<script src="${escapeHtml(src)}"${token === null ? '' : ` data-token="${escapeHtml(token)}"`}${loading === 'async' ? ' async' : ''}></script>`;

// ------------------------------------------------------------------------------------------------------ support contact

/**
 * Kinds of a support contact channel (fixed-choices audit K10): an email address (`mailto:`), a phone number in
 * international form (`tel:+…`), or any https link (a chat app such as `https://wa.me/…`, a help center, a form). The
 * label is the operator's own ("WhatsApp", "Help center").
 */
export const SUPPORT_CHANNEL_TYPES = Object.freeze(/** @type {const} */ (['email', 'phone', 'link']));
/** The most channels, and the longest label. */
export const SUPPORT_CHANNELS_MAX = 10;
const SUPPORT_LABEL_MAX = 60;

/** @typedef {{ type: 'email' | 'phone' | 'link', label: string, url: string }} SupportChannel */

const TEL = /^tel:\+[1-9]\d{6,14}$/;

/**
 * The address of a channel from what people type: `mailto:<address>` (the address checked and in small letters),
 * `tel:+<digits>` (spaces, dots, dashes and brackets dropped), or the https link itself; null when it does not fit
 * the type. A value that already has its scheme is taken as it is.
 * @param {string} type
 * @param {string} value
 * @returns {string | null}
 */
export const supportChannelUrl = (type, value) => {
	const text = String(value ?? '').trim();
	if (type === 'email') {
		const email = normalizeEmail(text.replace(/^mailto:/i, ''));
		return email === null ? null : `mailto:${email}`;
	}
	if (type === 'phone') {
		const url = `tel:${text.replace(/^tel:/i, '').replace(/[\s().-]/g, '')}`;
		return TEL.test(url) ? url : null;
	}
	if (type === 'link') {
		if (text.length > 2048) return null;
		try {
			const url = new URL(text);
			return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
		} catch {
			return null;
		}
	}
	return null;
};

/**
 * Why a channel cannot be used (null when it can): an unknown type, an empty or long label, an address that does not
 * fit the type.
 * @param {unknown} channel
 * @returns {string | null}
 */
export const supportChannelProblem = (channel) => {
	if (typeof channel !== 'object' || channel === null) return 'must be an object';
	const { type, label, url } = /** @type {Record<string, unknown>} */ (channel);
	if (typeof type !== 'string' || !(/** @type {readonly string[]} */ (SUPPORT_CHANNEL_TYPES).includes(type)))
		return `type must be ${SUPPORT_CHANNEL_TYPES.join(', ')}`;
	if (typeof label !== 'string' || label.trim() === '' || label.length > SUPPORT_LABEL_MAX)
		return `label must be 1 to ${SUPPORT_LABEL_MAX} characters`;
	if (typeof url !== 'string' || supportChannelUrl(type, url) !== url)
		return type === 'email'
			? 'url must be mailto: and an email address'
			: type === 'phone'
				? 'url must be tel: and a number with its country code'
				: 'url must be an https link';
	return null;
};

/**
 * What people read of a channel: the email address, the phone number or the link.
 * @param {SupportChannel} channel
 * @returns {string}
 */
export const supportChannelValue = (channel) => channel.url.replace(/^(?:mailto|tel):/, '');

/**
 * The support contact in one line, each channel as what people read and its label (`help@example.com (Email),
 * https://wa.me/15550100 (WhatsApp)`); '' without channels.
 * @param {ReadonlyArray<SupportChannel>} channels
 * @returns {string}
 */
export const supportContactLine = (channels) =>
	channels.map((channel) => `${supportChannelValue(channel)} (${channel.label})`).join(', ');

// -------------------------------------------------------------------------------------------------------- path patterns

/**
 * A path's segments, decoded (`%C3%A9` is `é`), without the query string, the fragment and empty segments.
 * @param {string} value
 */
const segmentsOf = (value) =>
	value
		.replace(/[?#][\s\S]*$/, '')
		.split('/')
		.filter((segment) => segment !== '')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});

/**
 * Whether one segment matches one pattern segment, where `*` is any run of characters (possibly none).
 * @param {string} part
 * @param {string} segment
 */
const segmentMatches = (part, segment) => {
	if (!part.includes('*')) return part === segment;
	const pieces = part.split('*');
	const head = /** @type {string} */ (pieces[0]);
	const tail = /** @type {string} */ (pieces.at(-1));
	if (segment.length < head.length + tail.length || !segment.startsWith(head) || !segment.endsWith(tail)) return false;
	const end = segment.length - tail.length;
	let at = head.length;
	for (const piece of pieces.slice(1, -1)) {
		const found = segment.indexOf(piece, at);
		if (found === -1 || found + piece.length > end) return false;
		at = found + piece.length;
	}
	return true;
};

/**
 * Whether a page's path matches a path pattern (the "hide on pages" and page rules of every product). The rules:
 *
 * - a pattern is a path from `/` (spaces around it ignored); anything else matches nothing; `/` is the home page;
 * - `**` as a whole segment is any number of segments, none included (`/shop/**` is `/shop` and all below it);
 * - `*` elsewhere is any run of characters inside one segment (`/shop/*` is one level below `/shop`; `/sale-*` is
 *   `/sale-summer`, `/sale-` too);
 * - anything else matches itself, case-sensitively;
 * - on both sides the query string, the fragment, empty segments (so a trailing `/`) are ignored, and segments are
 *   compared decoded (`/café` is `/caf%C3%A9`).
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export const pathMatches = (pattern, path) => {
	const trimmed = pattern.trim();
	if (!trimmed.startsWith('/')) return false;
	const parts = segmentsOf(trimmed);
	const segments = segmentsOf(path);
	/** Results already worked out (keeps many `**` linear). @type {Map<number, boolean>} */
	const known = new Map();
	/** @param {number} i @param {number} j @returns {boolean} */
	const match = (i, j) => {
		const key = i * (segments.length + 1) + j;
		const found = known.get(key);
		if (found !== undefined) return found;
		const part = parts[i];
		const result =
			part === undefined
				? j === segments.length
				: part === '**'
					? match(i + 1, j) || (j < segments.length && match(i, j + 1))
					: j < segments.length && segmentMatches(part, /** @type {string} */ (segments[j])) && match(i + 1, j + 1);
		known.set(key, result);
		return result;
	};
	return match(0, 0);
};

// --------------------------------------------------------------------------------------------------------------- Luhn

/**
 * Whether a string of ASCII digits passes the Luhn check (its last digit is the check digit), as payment cards, IMEIs
 * and many other numbers do. At least 2 digits; anything but digits fails. Callers add their own length rules.
 * @param {unknown} digits
 * @returns {boolean}
 */
export const luhnValid = (digits) => {
	if (typeof digits !== 'string' || !/^\d{2,}$/.test(digits)) return false;
	let sum = 0;
	for (let index = 0; index < digits.length; index += 1) {
		let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
		if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
		sum += digit;
	}
	return sum % 10 === 0;
};
