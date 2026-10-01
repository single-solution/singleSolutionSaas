/**
 * Rendering helpers shared by the chat renderers: the DOM builder over the injected `dom`, message text with the
 * small markdown subset answers use (`**bold**`, `[label](link)` — safe links only, line breaks) and system notices
 * (handoff, offline, closed). Text is always inserted as text nodes, never as HTML.
 * @module
 */

/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<any>} [children]
 */
export const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children)
		if (child !== null && child !== undefined) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * Is a link target safe to render? Site-relative paths, https/http, mailto: and tel:.
 * @param {string} href
 */
export const safeHref = (href) => /^(?:\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(href.trim()) && !/[\s"'<>`]/.test(href.trim());

const INLINE = /\*\*([^*\n]{1,500})\*\*|\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)/g;

/**
 * Message text as nodes: paragraphs per line, bold and safe links.
 * @param {DomLike} dom
 * @param {string} text
 * @returns {any[]}
 */
export const richText = (dom, text) =>
	String(text ?? '')
		.split('\n')
		.map((line) => {
			/** @type {any[]} */
			const parts = [];
			let last = 0;
			for (const match of line.matchAll(INLINE)) {
				if ((match.index ?? 0) > last) parts.push(line.slice(last, match.index));
				if (match[1] !== undefined) parts.push(el(dom, 'strong', {}, [match[1]]));
				else if (match[3] !== undefined && safeHref(match[3])) {
					const external = /^https?:/i.test(match[3]);
					parts.push(
						el(dom, 'a', { href: match[3], ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, [
							match[2] ?? '',
						]),
					);
				} else parts.push(match[2] ?? '');
				last = (match.index ?? 0) + match[0].length;
			}
			if (last < line.length) parts.push(line.slice(last));
			return el(dom, 'p', { class: 'ss-chat__line' }, parts.length > 0 ? parts : [' ']);
		});

/**
 * A system notice inside the conversation.
 * @param {DomLike} dom
 * @param {string} text
 */
export const notice = (dom, text) => el(dom, 'li', { class: 'ss-chat__notice', role: 'note' }, richText(dom, text));
