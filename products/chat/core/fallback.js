/**
 * Fallback answers (PLAN 0.8.10 C3; pure): the merchant's own answers, used before the on-failure message when the AI
 * fails, a cap is reached or the answer is refused. The list `fallback_answers` holds `{ intent, language, keywords,
 * text }` items; the first entry whose language and keywords match the visitor's message wins. `text` may hold
 * `{deals_table}`, `{top_products}`, `{products_under}` and `{my_orders}`, filled from the shop tools that are on; an
 * entry whose placeholder cannot be filled (its tool is off, the visitor is not signed in, no budget in the message, or
 * Ecommerce cannot answer) is skipped.
 * @module
 */
import { containsPhrase } from './text.js';

const INTENTS = Object.freeze(/** @type {const} */ (['greeting', 'deals', 'products', 'budget', 'my_orders', 'other']));
/** The placeholders and the shop feature each one needs. */
export const PLACEHOLDERS = Object.freeze({
	deals_table: 'shop_deals',
	top_products: 'shop_top',
	products_under: 'shop_search',
	my_orders: 'shop_my_orders',
});
/** Most entries in the list. */
const MAX_FALLBACKS = 50;
const MAX_KEYWORDS = 30;
const MAX_TEXT = 2000;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/**
 * @typedef {object} FallbackAnswer
 * @property {(typeof INTENTS)[number]} intent
 * @property {string} language '' = any, else a language-lock language
 * @property {string[]} keywords any one of them in the message (none = any message)
 * @property {string} text markdown with placeholders
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The placeholders a text uses.
 * @param {string} text
 * @returns {Array<keyof typeof PLACEHOLDERS>}
 */
export const placeholdersOf = (text) =>
	/** @type {Array<keyof typeof PLACEHOLDERS>} */ (Object.keys(PLACEHOLDERS).filter((name) => text.includes(`{${name}}`)));

/**
 * Check the list setting.
 * @param {unknown} raw
 * @returns {{ ok: true, value: FallbackAnswer[] } | { ok: false, errors: string[] }}
 */
export const checkFallbackAnswers = (raw) => {
	if (!Array.isArray(raw)) return { ok: false, errors: ['Send a list of fallback answers.'] };
	if (raw.length > MAX_FALLBACKS) return { ok: false, errors: [`Up to ${MAX_FALLBACKS} fallback answers.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {FallbackAnswer[]} */
	const value = [];
	raw.forEach((item, index) => {
		const at = `Answer ${index + 1}`;
		if (!isObject(item)) return void errors.push(`${at}: not valid.`);
		const intent = INTENTS.includes(/** @type {any} */ (item.intent))
			? /** @type {FallbackAnswer['intent']} */ (item.intent)
			: null;
		if (!intent) errors.push(`${at}: the intent is one of ${INTENTS.join(', ')}.`);
		const language = typeof item.language === 'string' ? item.language.trim() : '';
		if (language !== '' && !LANGUAGE.test(language)) errors.push(`${at}: the language is empty (any) or a code such as en.`);
		const keywords = (Array.isArray(item.keywords) ? item.keywords : [])
			.filter((keyword) => typeof keyword === 'string' && keyword.trim() !== '')
			.map((keyword) => String(keyword).trim());
		if (keywords.length > MAX_KEYWORDS || keywords.some((keyword) => keyword.length > 100))
			errors.push(`${at}: up to ${MAX_KEYWORDS} keywords of up to 100 characters.`);
		const text = typeof item.text === 'string' ? item.text.trim() : '';
		if (text === '' || text.length > MAX_TEXT) errors.push(`${at}: write the answer (up to ${MAX_TEXT} characters).`);
		if (intent) value.push({ intent, language, keywords, text });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/** @param {string} tag */
const primary = (tag) => tag.toLowerCase().split('-')[0] ?? '';

/**
 * The entries that may answer a message, in list order: the language is any or the visitor's (language lock on), and
 * a keyword is in the message (or the entry has none).
 * @param {FallbackAnswer[]} items
 * @param {{ message: string, language: string | null }} input `language`: the visitor's, null without the language lock
 */
export const matchingFallbacks = (items, { message, language }) => {
	return items.filter(
		(item) =>
			(item.language === '' || (language !== null && primary(item.language) === primary(language))) &&
			(item.keywords.length === 0 || item.keywords.some((keyword) => containsPhrase(message, keyword))),
	);
};

/**
 * A budget in a message: the first number (separators allowed, `k` = thousand), in whole units; null when none.
 * @param {string} message
 */
export const budgetOf = (message) => {
	const match = /(\d{1,3}(?:[,. ]\d{3})+|\d+(?:[.,]\d+)?)\s*(k)?(?![\p{L}\d])/iu.exec(message);
	if (!match) return null;
	const raw = String(match[1]);
	const grouped = /^\d{1,3}(?:[,. ]\d{3})+$/.test(raw);
	const number = grouped ? Number(raw.replace(/[,. ]/g, '')) : Number(raw.replace(',', '.'));
	const amount = match[2] ? number * 1000 : number;
	return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
};

/**
 * Fill a fallback answer's placeholders; null when one is missing.
 * @param {string} text
 * @param {Partial<Record<keyof typeof PLACEHOLDERS, string | null>>} values
 */
export const fillFallback = (text, values) => {
	let out = text;
	for (const name of placeholdersOf(text)) {
		const value = values[name];
		if (typeof value !== 'string' || value === '') return null;
		out = out.split(`{${name}}`).join(value);
	}
	return out;
};

/** @param {string} value */
const cell = (value) => value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * A markdown table.
 * @param {string[]} head
 * @param {string[][]} rows
 */
export const tableOf = (head, rows) =>
	[
		`| ${head.map(cell).join(' | ')} |`,
		`| ${head.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
	].join('\n');

/**
 * A markdown list of products: name (linked to its page), price and stock.
 * @param {Array<{ name: string, price: string, link?: string | null, inStock?: boolean }>} products
 * @param {{ outOfStock: string }} words
 */
export const productList = (products, words) =>
	products
		.map(
			(p) =>
				`- ${p.link ? `[${p.name.replace(/[[\]]/g, '')}](${p.link})` : p.name} — ${p.price}${p.inStock === false ? ` (${words.outOfStock})` : ''}`,
		)
		.join('\n');
