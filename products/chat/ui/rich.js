/**
 * Rich answers in the widgets (PLAN 0.8.10 C2): an AI or staff message written in markdown (`format: 'markdown'`) shows
 * its bold, italic, code, lists, tables and links. The nodes are built from the parsed blocks of `core/markdown.js` with
 * `createElement` and text nodes, never as HTML: no images, no raw HTML and no style from the message. A link keeps its
 * target only through `safeHref` (in the parser) and opens in a new tab without opener, referrer or endorsement; any
 * other link is its label as text. Visitor and bot (`system`) messages, and any message without the markdown format,
 * stay plain text.
 * @module
 */
import { parseMarkdown } from '../core/markdown.js';
import { element } from './dom.js';

/** @typedef {import('../core/markdown.js').Inline} Inline */
/** @typedef {import('../core/markdown.js').Block} Block */

/** How a link from a message opens. */
const LINK = Object.freeze({ target: '_blank', rel: 'noopener noreferrer nofollow' });

/**
 * An element with children.
 * @param {Document} doc
 * @param {string} tag
 * @param {Node[]} children
 * @param {Record<string, string>} [attributes]
 */
const parent = (doc, tag, children, attributes = {}) => {
	const node = element(doc, tag, attributes);
	node.append(...children);
	return node;
};

/**
 * @param {Document} doc
 * @param {Inline[]} inlines
 * @returns {Node[]}
 */
const inlineNodes = (doc, inlines) =>
	inlines.map((inline) => {
		if (inline.t === 'text') return doc.createTextNode(inline.v);
		if (inline.t === 'code') return element(doc, 'code', {}, inline.v);
		if (inline.t === 'a') return parent(doc, 'a', inlineNodes(doc, inline.c), { href: inline.href, ...LINK });
		return parent(doc, inline.t === 'b' ? 'strong' : 'em', inlineNodes(doc, inline.c));
	});

/** @param {Document} doc @param {Inline[][]} cells @param {'th' | 'td'} tag */
const rowNode = (doc, cells, tag) =>
	parent(
		doc,
		'tr',
		cells.map((cell) => parent(doc, tag, inlineNodes(doc, cell))),
	);

/**
 * One block: a paragraph (its lines broken), code, a table that scrolls inside the bubble, or a list.
 * @param {Document} doc
 * @param {Block} block
 * @returns {HTMLElement}
 */
const blockNode = (doc, block) => {
	if (block.kind === 'p')
		return parent(
			doc,
			'p',
			block.lines.flatMap((line, index) => [...(index > 0 ? [element(doc, 'br')] : []), ...inlineNodes(doc, line)]),
		);
	if (block.kind === 'code') return parent(doc, 'pre', [element(doc, 'code', {}, block.text)]);
	if (block.kind === 'table') {
		const table = parent(doc, 'table', [
			parent(doc, 'thead', [rowNode(doc, block.head, 'th')]),
			parent(
				doc,
				'tbody',
				block.rows.map((cells) => rowNode(doc, cells, 'td')),
			),
		]);
		return parent(doc, 'div', [table], { class: 'table' });
	}
	return parent(
		doc,
		block.kind,
		block.items.map((item) => parent(doc, 'li', inlineNodes(doc, item))),
	);
};

/**
 * The bubble of a message's text: `div.rich` with the blocks of an AI or staff markdown message, else `p` with the text
 * as it is (also when the markdown has no blocks, such as only `---`).
 * @param {Document} doc
 * @param {{ author: string, text: string, format?: string }} message
 * @returns {HTMLElement}
 */
export const messageBody = (doc, { author, text, format }) => {
	const blocks = (author === 'ai' || author === 'staff') && format === 'markdown' ? parseMarkdown(text) : [];
	if (blocks.length === 0) return element(doc, 'p', {}, text);
	return parent(
		doc,
		'div',
		blocks.map((block) => blockNode(doc, block)),
		{ class: 'rich' },
	);
};
