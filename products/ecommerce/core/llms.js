/**
 * llms.txt (PLAN 0.8.8): a Markdown summary of the shop for AI assistants, following the llms.txt convention — the
 * business name as the title, a short description as a quote, then sections of links: categories, the best-selling
 * products with their prices, and short policy summaries. The merchant's site serves it at `/llms.txt` from the
 * product's API (PLAN 0.4.10). The answer is bounded. Pure functions, no I/O.
 * @module
 */
import { clip } from './seo.js';

/** The longest llms.txt, in characters. */
export const MAX_LLMS_CHARS = 100_000;
/** At most this many categories are listed. */
export const MAX_LLMS_CATEGORIES = 200;
/** A policy summary is cut to this many characters. */
const POLICY_LENGTH = 300;
/** A product or category note is cut to this many characters. */
const NOTE_LENGTH = 160;

/**
 * Text safe as Markdown link text or a list item: on one line, brackets escaped.
 * @param {string} value
 */
export const markdownText = (value) =>
	String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/([\\[\]])/g, '\\$1');

/**
 * A link safe inside `( )`: spaces and parentheses encoded.
 * @param {string} url
 */
const markdownUrl = (url) => url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

/**
 * One list line: `- [name](url): note`.
 * @param {{ name: string, url: string, note?: string, depth?: number }} item
 */
const linkLine = ({ name, url, note = '', depth = 0 }) => {
	const text = markdownText(clip(note, NOTE_LENGTH));
	return `${'  '.repeat(Math.min(depth, 5))}- [${markdownText(name)}](${markdownUrl(url)})${text ? `: ${text}` : ''}`;
};

/**
 * @typedef {object} LlmsInput
 * @property {string} name the business name
 * @property {string} description the shop's description ('' = none)
 * @property {string} home the website's home page
 * @property {Array<{ name: string, url: string, description: string, depth: number }>} categories in tree order
 * @property {Array<{ name: string, url: string, price: string, summary: string }>} products
 * @property {Array<{ title: string, text: string }>} policies titles and texts ('' texts are left out)
 * @property {{ categories: string, products: string, policies: string }} headings section names
 */

/**
 * The llms.txt text, at most {@link MAX_LLMS_CHARS} characters (whole lines only).
 * @param {LlmsInput} input
 */
export const buildLlmsTxt = ({ name, description, home, categories, products, policies, headings }) => {
	const lines = [`# ${markdownText(name)}`, ''];
	const about = String(description ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	if (about) lines.push(`> ${about}`, '');
	lines.push(`- [${markdownText(name)}](${markdownUrl(home)})`, '');
	if (categories.length > 0) {
		lines.push(`## ${headings.categories}`, '');
		for (const category of categories.slice(0, MAX_LLMS_CATEGORIES))
			lines.push(linkLine({ name: category.name, url: category.url, note: category.description, depth: category.depth }));
		lines.push('');
	}
	if (products.length > 0) {
		lines.push(`## ${headings.products}`, '');
		for (const item of products)
			lines.push(linkLine({ name: item.name, url: item.url, note: [item.price, item.summary].filter(Boolean).join(' — ') }));
		lines.push('');
	}
	const written = policies.filter((policy) => policy.text.trim() !== '');
	if (written.length > 0) {
		lines.push(`## ${headings.policies}`, '');
		for (const policy of written)
			lines.push(`- ${markdownText(policy.title)}: ${markdownText(clip(policy.text, POLICY_LENGTH))}`);
		lines.push('');
	}
	let size = 0;
	/** @type {string[]} */
	const kept = [];
	for (const text of lines) {
		size += text.length + 1;
		if (size > MAX_LLMS_CHARS) break;
		kept.push(text);
	}
	return `${kept.join('\n').trimEnd()}\n`;
};

/**
 * Categories in tree order (parents before their children, by `sort` then name), each with its depth.
 * @template {{ id: string, parentId: string | null, name: string, sort: number }} C
 * @param {C[]} categories
 * @returns {Array<C & { depth: number }>}
 */
export const treeOrder = (categories) => {
	/** @type {Map<string | null, C[]>} */
	const children = new Map();
	const ids = new Set(categories.map((category) => category.id));
	for (const category of categories) {
		const parent = category.parentId && ids.has(category.parentId) ? category.parentId : null;
		children.set(parent, [...(children.get(parent) ?? []), category]);
	}
	/** @type {Array<C & { depth: number }>} */
	const out = [];
	/** @param {string | null} parent @param {number} depth */
	const walk = (parent, depth) => {
		const list = [...(children.get(parent) ?? [])].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
		for (const category of list) {
			out.push({ ...category, depth });
			if (depth < 20) walk(category.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
};
