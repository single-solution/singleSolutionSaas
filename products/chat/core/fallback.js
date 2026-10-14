/**
 * Fallback answers (PLAN 0.8.10 C3; pure): the merchant's own answers, used before the on-failure message when the AI
 * fails, a cap is reached or the answer is refused. The list `fallback_answers` holds `{ intent, language, keywords,
 * text }` items; the first entry whose language and keywords match the visitor's message wins. `text` may hold
 * `{deals_table}`, `{top_products}`, `{products_under}`, `{my_orders}` and `{comparison}` (C18: the two products the
 * message names around one of the answer's keywords, side by side), filled from the shop tools that are on; an entry
 * whose placeholder cannot be filled (its tool is off, the visitor is not signed in, no budget in the message, no two
 * products found, or Ecommerce cannot answer) is skipped.
 * @module
 */
import { aroundPhrase, containsPhrase, normalise, tokenize } from './text.js';

/** What an answer is for (C3); the merchant picks one per answer. */
export const FALLBACK_INTENTS = Object.freeze(
	/** @type {const} */ (['greeting', 'deals', 'products', 'budget', 'my_orders', 'compare', 'other']),
);
/** The placeholders and the shop feature each one needs. */
export const PLACEHOLDERS = Object.freeze({
	deals_table: 'shop_deals',
	top_products: 'shop_top',
	products_under: 'shop_search',
	my_orders: 'shop_my_orders',
	comparison: 'shop_search',
});
/** The list's limits, the same in Settings and in the server's check. */
export const FALLBACK_LIMITS = Object.freeze({ answers: 50, keywords: 30, keywordLength: 100, text: 2000 });
/** Words on each side of the keyword a comparison searches the catalog with, at most (C18). */
const COMPARE_WORDS = 4;
/** Options and specs a comparison shows, at most (C18). */
const COMPARE_ROWS = 20;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/**
 * @typedef {object} FallbackAnswer
 * @property {(typeof FALLBACK_INTENTS)[number]} intent
 * @property {string} language '' = any, else a language-lock language
 * @property {string[]} keywords any one of them in the message (none = any message)
 * @property {string} text markdown with placeholders
 */
/**
 * What is wrong with an answer: a field, or `compareKeywords` (`{comparison}` needs keywords: the words between the two
 * products).
 * @typedef {'item' | 'intent' | 'language' | 'keywords' | 'compareKeywords' | 'text'} FallbackProblem
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
 * An answer as it is kept: language and text trimmed, keywords trimmed with the empty ones dropped (blank lines of the
 * editor). A missing language or keyword list means any.
 * @param {Record<string, unknown>} item
 */
const keptOf = (item) => ({
	intent: item.intent,
	language: typeof item.language === 'string' ? item.language.trim() : '',
	keywords: (Array.isArray(item.keywords) ? item.keywords : [])
		.map((keyword) => (typeof keyword === 'string' ? keyword.trim() : keyword))
		.filter((keyword) => keyword !== ''),
	text: typeof item.text === 'string' ? item.text.trim() : '',
});

/** @param {unknown} value */
const missing = (value) => value === undefined || value === null;

/**
 * What is wrong with one answer, field by field (none: it is fine). The server's check and the Settings editor both
 * use it, so the editor refuses exactly what the server would. A language or keyword list of the wrong type is wrong,
 * never read as "any" (which would answer every message).
 * @param {unknown} item
 * @returns {FallbackProblem[]}
 */
export const fallbackProblems = (item) => {
	if (!isObject(item)) return ['item'];
	const { intent, language, keywords, text } = keptOf(item);
	/** @type {FallbackProblem[]} */
	const problems = [];
	if (!FALLBACK_INTENTS.includes(/** @type {any} */ (intent))) problems.push('intent');
	if ((!missing(item.language) && typeof item.language !== 'string') || (language !== '' && !LANGUAGE.test(language)))
		problems.push('language');
	if (
		(!missing(item.keywords) && !Array.isArray(item.keywords)) ||
		keywords.length > FALLBACK_LIMITS.keywords ||
		keywords.some((keyword) => typeof keyword !== 'string' || keyword.length > FALLBACK_LIMITS.keywordLength)
	)
		problems.push('keywords');
	else if (keywords.length === 0 && text.includes('{comparison}')) problems.push('compareKeywords');
	if (text === '' || text.length > FALLBACK_LIMITS.text) problems.push('text');
	return problems;
};

/** The server's words for each problem. */
const PROBLEM_TEXTS = Object.freeze({
	item: 'not valid.',
	intent: `the intent is one of ${FALLBACK_INTENTS.join(', ')}.`,
	language: 'the language is empty (any) or a code such as en.',
	keywords: `the keywords are a list of up to ${FALLBACK_LIMITS.keywords} words or phrases of up to ${FALLBACK_LIMITS.keywordLength} characters.`,
	compareKeywords: '{comparison} needs keywords: the words between the two products, such as vs.',
	text: `write the answer (up to ${FALLBACK_LIMITS.text} characters).`,
});

/**
 * Check the list setting.
 * @param {unknown} raw
 * @returns {{ ok: true, value: FallbackAnswer[] } | { ok: false, errors: string[] }}
 */
export const checkFallbackAnswers = (raw) => {
	if (!Array.isArray(raw)) return { ok: false, errors: ['Send a list of fallback answers.'] };
	if (raw.length > FALLBACK_LIMITS.answers) return { ok: false, errors: [`Up to ${FALLBACK_LIMITS.answers} fallback answers.`] };
	const errors = raw.flatMap((item, index) =>
		fallbackProblems(item).map((problem) => `Answer ${index + 1}: ${PROBLEM_TEXTS[problem]}`),
	);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: raw.map((item) => /** @type {FallbackAnswer} */ (keptOf(/** @type {Record<string, unknown>} */ (item)))),
	};
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
 * A markdown list of products: name (linked to its page), price as the product page shows it (with its "was" price)
 * and stock.
 * @param {Array<{ name: string, price: string, wasPrice?: string, link?: string | null, inStock?: boolean }>} products
 * @param {{ outOfStock: string, was: (price: string) => string }} words `was`: the "was" price in words
 */
export const productList = (products, words) =>
	products
		.map(
			(p) =>
				`- ${p.link ? `[${p.name.replace(/[[\]]/g, '')}](${p.link})` : p.name} — ${p.price}${p.wasPrice ? ` (${words.was(p.wasPrice)})` : ''}${p.inStock === false ? ` (${words.outOfStock})` : ''}`,
		)
		.join('\n');

/**
 * The words that name the two products of a comparison (C18): those before and after the first of the keywords that
 * stands between words in the message (in one sentence), at most `COMPARE_WORDS` on each side, nearest the keyword
 * first kept; null when no keyword does.
 * @param {string} message
 * @param {string[]} keywords
 * @returns {{ left: string[], right: string[] } | null}
 */
export const comparedNames = (message, keywords) => {
	for (const keyword of keywords) {
		const around = aroundPhrase(message, keyword);
		if (around) return { left: around.before.slice(-COMPARE_WORDS), right: around.after.slice(0, COMPARE_WORDS) };
	}
	return null;
};

/**
 * The searches that look for one side of a comparison, most words first: the side's words, then fewer, dropping
 * the word farthest from the keyword each time (the left side's first words, the right side's last).
 * @param {string[]} words
 * @param {'left' | 'right'} side
 */
export const compareSearches = (words, side) =>
	words.map((_, dropped) => (side === 'left' ? words.slice(dropped) : words.slice(0, words.length - dropped)).join(' '));

/**
 * The product a comparison side means among a search's products: only those whose name holds one of the searched
 * words (short words such as "a" do not count, so a stray word never picks a product), never the other side's
 * product; the one named exactly as searched, else the first; null when none is left.
 * @template {{ id: string, name: string }} P
 * @param {P[]} products
 * @param {string} searched
 * @param {string | null} taken the other side's product id
 * @returns {P | null}
 */
export const comparedProduct = (products, searched, taken) => {
	const words = tokenize(searched);
	const named = products.filter((product) => {
		const name = new Set(tokenize(product.name));
		return product.id !== taken && words.some((word) => name.has(word));
	});
	const wanted = normalise(searched);
	return named.find((product) => normalise(product.name) === wanted) ?? named[0] ?? null;
};

/**
 * Two products side by side as a markdown table (C18): a column each (its name linked to its page), then price (with
 * the "was" price), availability, brand and condition (when one has them), and their options and specs by name (a
 * dash where one has none), at most 20 of those.
 * @param {import('./shop.js').CompareFacts[]} products
 * @param {{ price: string, availability: string, inStock: string, outOfStock: string, brand: string, condition: string,
 *   yes: string, no: string, was: (price: string) => string }} words the widget texts
 */
export const comparisonTable = (products, words) => {
	const MISSING = '—';
	const head = ['', ...products.map((p) => (p.link ? `[${p.name.replace(/[[\]]/g, '')}](${p.link})` : p.name))];
	/** @type {string[][]} */
	const rows = [
		[words.price, ...products.map((p) => (p.wasPrice ? `${p.price} (${words.was(p.wasPrice)})` : p.price))],
		[words.availability, ...products.map((p) => (p.inStock ? words.inStock : words.outOfStock))],
	];
	if (products.some((p) => p.brand)) rows.push([words.brand, ...products.map((p) => p.brand ?? MISSING)]);
	if (products.some((p) => p.grade)) rows.push([words.condition, ...products.map((p) => p.grade ?? MISSING)]);
	/** @type {string[]} */
	const names = [];
	for (const p of products)
		for (const detail of p.details)
			if (!names.some((name) => normalise(name) === normalise(detail.name))) names.push(detail.name);
	for (const name of names.slice(0, COMPARE_ROWS))
		rows.push([
			name,
			...products.map((p) => {
				const value = p.details.find((detail) => normalise(detail.name) === normalise(name))?.value;
				return value === undefined ? MISSING : value === true ? words.yes : value === false ? words.no : value;
			}),
		]);
	return tableOf(head, rows);
};
