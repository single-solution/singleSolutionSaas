/**
 * Rich answers (PLAN 0.8.10 C2; pure): AI and staff messages carry `format: 'markdown'` with a small subset — bold,
 * italic, lists, tables and links. The server keeps a link only when it is site-relative, on the website's own domain,
 * or allowed by the moderation link policy (while moderation is on); any other link keeps just its label. An AI answer
 * splits on `---` lines into at most `bubbles` messages. The widgets render the parsed blocks as DOM nodes, never as
 * HTML.
 * @module
 */

/** @typedef {{ t: 'text', v: string } | { t: 'b' | 'i', c: Inline[] } | { t: 'a', href: string, c: Inline[] }} Inline */
/**
 * @typedef {{ kind: 'p', lines: Inline[][] } | { kind: 'ul' | 'ol', items: Inline[][] }
 *   | { kind: 'table', head: Inline[][], rows: Inline[][][] }} Block
 */

/** The message formats: plain text (visitor and bot messages, older messages) and the markdown subset. */
export const FORMATS = Object.freeze(/** @type {const} */ (['text', 'markdown']));

const SEPARATOR = /^[ \t]*-{3,}[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:([-*+])|(\d{1,3})[.)])[ \t]+(.*)$/;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;
const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)/g;
const INLINE =
	/\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\n]+?)\*|(?<![\p{L}\p{N}])_([^_\n]+?)_(?![\p{L}\p{N}])/gu;

/**
 * Split an AI answer on `---` lines into at most `max` messages; the rest joins the last one. Empty parts are dropped.
 * @param {string} text
 * @param {number} max 1–5
 * @returns {string[]}
 */
export const splitBubbles = (text, max) => {
	/** @type {string[][]} */
	const parts = [[]];
	for (const line of String(text ?? '').split('\n')) {
		if (SEPARATOR.test(line)) parts.push([]);
		else /** @type {string[]} */ (parts.at(-1)).push(line);
	}
	const texts = parts.map((lines) => lines.join('\n').trim()).filter((part) => part !== '');
	const limit = Math.max(1, Math.min(5, Math.floor(max) || 1));
	if (texts.length <= limit) return texts;
	return [...texts.slice(0, limit - 1), texts.slice(limit - 1).join('\n\n')];
};

/**
 * Is a link target on the website (site-relative, or https/http on its own domain or `www.` of it)?
 * @param {string} target
 * @param {string} websiteDomain
 */
const onWebsite = (target, websiteDomain) => {
	if (target.startsWith('/') && !target.startsWith('//')) return true;
	try {
		const url = new URL(target);
		const host = url.hostname.toLowerCase();
		const domain = websiteDomain.toLowerCase();
		return (
			(url.protocol === 'https:' || url.protocol === 'http:') && domain !== '' && (host === domain || host === `www.${domain}`)
		);
	} catch {
		return false;
	}
};

/**
 * Keep the links of a markdown message that are on the website, or that `allowed` accepts (the moderation link policy
 * while moderation is on); every other link keeps only its label.
 * @param {string} text
 * @param {{ websiteDomain: string, allowed?: ((target: string) => boolean) | null }} context
 */
export const keepLinks = (text, { websiteDomain, allowed = null }) =>
	String(text ?? '').replace(MARKDOWN_LINK, (match, label, target) =>
		onWebsite(target, websiteDomain) || (allowed !== null && allowed(target)) ? match : label,
	);

/**
 * A link target the widgets may open: site-relative, http(s), mailto or tel; else null.
 * @param {string} target
 */
export const safeHref = (target) => {
	const value = target.trim();
	if (value.startsWith('/') && !value.startsWith('//')) return value;
	if (/^(?:mailto|tel):[^\s]+$/i.test(value)) return value;
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
};

/**
 * Inline marks of one line.
 * @param {string} text
 * @returns {Inline[]}
 */
export const parseInline = (text) => {
	/** @type {Inline[]} */
	const out = [];
	let at = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > at) out.push({ t: 'text', v: text.slice(at, index) });
		const [whole, label, target, bold1, bold2, italic1, italic2] = match;
		if (label !== undefined && target !== undefined) {
			const href = safeHref(target);
			out.push(href ? { t: 'a', href, c: parseInline(label) } : { t: 'text', v: label });
		} else if (bold1 !== undefined || bold2 !== undefined) out.push({ t: 'b', c: parseInline(String(bold1 ?? bold2)) });
		else out.push({ t: 'i', c: parseInline(String(italic1 ?? italic2)) });
		at = index + whole.length;
	}
	if (at < text.length) out.push({ t: 'text', v: text.slice(at) });
	return out;
};

/** @param {string} line */
const cellsOf = (line) =>
	line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => parseInline(cell.trim()));

/**
 * The blocks of a markdown message: paragraphs (single newlines kept), bullet and numbered lists, and tables;
 * headings (`#`) become bold paragraphs.
 * @param {string} text
 * @returns {Block[]}
 */
export const parseMarkdown = (text) => {
	const lines = String(text ?? '')
		.replace(/\r\n?/g, '\n')
		.split('\n');
	/** @type {Block[]} */
	const blocks = [];
	/** @type {Inline[][]} */
	let paragraph = [];
	const endParagraph = () => {
		if (paragraph.length > 0) blocks.push({ kind: 'p', lines: paragraph });
		paragraph = [];
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = /** @type {string} */ (lines[i]);
		const next = lines[i + 1];
		if (line.trim() === '' || SEPARATOR.test(line)) {
			endParagraph();
			continue;
		}
		if (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-')) {
			endParagraph();
			const head = cellsOf(line);
			/** @type {Inline[][][]} */
			const rows = [];
			i += 1;
			while (i + 1 < lines.length && String(lines[i + 1]).includes('|') && String(lines[i + 1]).trim() !== '') {
				i += 1;
				rows.push(cellsOf(String(lines[i])));
			}
			blocks.push({ kind: 'table', head, rows });
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item) {
			endParagraph();
			const kind = item[1] ? 'ul' : 'ol';
			const last = blocks.at(-1);
			const content = parseInline(String(item[3]));
			if (last && last.kind === kind && (lines[i - 1] ?? '').trim() !== '') last.items.push(content);
			else blocks.push({ kind, items: [content] });
			continue;
		}
		const heading = /^[ \t]*#{1,6}[ \t]+(.*)$/.exec(line);
		if (heading) {
			endParagraph();
			blocks.push({ kind: 'p', lines: [[{ t: 'b', c: parseInline(String(heading[1])) }]] });
			continue;
		}
		paragraph.push(parseInline(line.trim()));
	}
	endParagraph();
	return blocks;
};

/**
 * The text of a markdown message without its marks (alerts, transcripts, previews).
 * @param {string} text
 */
export const plainOf = (text) =>
	String(text ?? '')
		.replace(MARKDOWN_LINK, '$1')
		.replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, (_m, a, b) => a ?? b)
		.replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1$2')
		.replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
		.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
		.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
