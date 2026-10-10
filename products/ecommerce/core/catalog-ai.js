/**
 * AI copy (PLAN 0.8.8 Catalog SEO: product descriptions and meta text written with the merchant's own AI key): the
 * request for the merchant's provider, built from what the catalog knows about a product, and the suggestions read
 * from its answer. Suggestions are only shown to staff, never saved by themselves. No I/O.
 * @module
 */
import { LIMITS, cleanText, isObject } from './catalog.js';
import { checkFaqs } from './catalog-content.js';

/** The texts AI copy can suggest, with their longest length. */
const AI_FIELDS = Object.freeze({
	description: LIMITS.description,
	summary: LIMITS.summary,
	seoTitle: 70,
	seoDescription: 160,
	faqs: 8,
});

/** What a landing page's copy suggestions may hold (E15), with their longest lengths (FAQs: how many). */
const LANDING_FIELDS = Object.freeze({ h1: 120, title: 70, description: 160, intro: 2000, faqs: 8 });

/** @typedef {keyof typeof AI_FIELDS} AiField */

/**
 * Check the request.
 * @param {unknown} body
 * @returns {{ ok: true, value: { fields: AiField[], tone: string, language: string } } | { ok: false, path: string, message: string }}
 */
export const checkAiRequest = (body) => {
	const input = isObject(body) ? body : {};
	const fields = Array.isArray(input.fields) ? [...new Set(input.fields)] : [];
	if (fields.length === 0 || !fields.every((field) => Object.hasOwn(AI_FIELDS, field)))
		return { ok: false, path: '/fields', message: `Pick fields among ${Object.keys(AI_FIELDS).join(', ')}.` };
	const tone = input.tone === undefined ? '' : cleanText(input.tone, 100);
	if (tone === null) return { ok: false, path: '/tone', message: 'A tone has at most 100 characters.' };
	const language = input.language === undefined ? '' : cleanText(input.language, 40);
	if (language === null) return { ok: false, path: '/language', message: 'A language has at most 40 characters.' };
	return { ok: true, value: { fields: /** @type {AiField[]} */ (fields), tone, language } };
};

/** What each field is, for the model. */
const FIELD_NOTES = Object.freeze({
	description: (/** @type {number} */ words) =>
		`"description": the product description, plain text, paragraphs separated by a blank line, about ${words} words`,
	summary: () => '"summary": one or two plain sentences (at most 300 characters)',
	seoTitle: () => '"seoTitle": a page title for search engines (at most 60 characters)',
	seoDescription: () => '"seoDescription": a meta description for search engines (at most 155 characters)',
	faqs: () =>
		'"faqs": 3 to 6 questions shoppers ask about this product with short factual answers, as [{ "question", "answer" }]',
});

/**
 * The prompt: the product's facts and what to write, answered as one JSON object.
 * @param {{ name: string, summary: string, description: string, brand: string | null, categories: string[],
 *   specs: Array<{ name: string, value: string | number | boolean | Array<string | number>, unit: string }>, options: Array<{ name: string, values: string[] }>,
 *   kind: string }} facts
 * @param {{ fields: AiField[], tone: string, language: string, words: number }} request
 * @returns {{ system: string, prompt: string }}
 */
export const aiPrompt = (facts, { fields, tone, language, words }) => {
	const lines = [
		`Name: ${facts.name}`,
		facts.brand ? `Brand: ${facts.brand}` : '',
		facts.categories.length > 0 ? `Categories: ${facts.categories.join(', ')}` : '',
		`Kind: ${facts.kind}`,
		...facts.specs.map((spec) => `${spec.name}: ${String(spec.value)}${spec.unit ? ` ${spec.unit}` : ''}`),
		...facts.options.map((axis) => `Available ${axis.name}: ${axis.values.join(', ')}`),
		facts.summary ? `Current summary: ${facts.summary}` : '',
		facts.description ? `Current description: ${facts.description.slice(0, 4000)}` : '',
	].filter(Boolean);
	const system = [
		'You write product copy for an online shop.',
		'Use only the facts given; never invent specifications, prices, offers or guarantees.',
		`Write in ${language || 'the language of the product facts'}.`,
		tone ? `Tone: ${tone}.` : '',
		'Answer with one JSON object and nothing else.',
	]
		.filter(Boolean)
		.join(' ');
	const prompt = [
		'Product facts:',
		...lines,
		'',
		`Write these fields: ${fields.map((field) => FIELD_NOTES[field](words)).join('; ')}.`,
	].join('\n');
	return { system, prompt };
};

/**
 * The suggestions in the AI's answer: the JSON object it was asked for (or the whole text when one text field was
 * asked), each text field cleaned and cut to its length, FAQs checked and cut to their count.
 * @template {string} F
 * @param {string} text
 * @param {F[]} fields
 * @param {Readonly<Record<F, number>>} [limits] each field's longest length (FAQs: how many)
 * @returns {Partial<Record<F, string | import('./catalog-content.js').Faq[]>> | null} null when nothing usable came back
 */
export const readSuggestions = (text, fields, limits = /** @type {any} */ (AI_FIELDS)) => {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	/** @type {Record<string, unknown> | null} */
	let parsed = null;
	if (start !== -1 && end > start)
		try {
			const value = JSON.parse(text.slice(start, end + 1));
			parsed = isObject(value) ? value : null;
		} catch {
			parsed = null;
		}
	if (!parsed && fields.length === 1 && fields[0] !== 'faqs' && text.trim()) parsed = { [String(fields[0])]: text.trim() };
	if (!parsed) return null;
	/** @type {Partial<Record<F, string | import('./catalog-content.js').Faq[]>>} */
	const out = {};
	for (const field of fields) {
		const raw = parsed[field];
		const limit = limits[field];
		if (field === 'faqs') {
			const faqs = Array.isArray(raw) ? checkFaqs(raw.slice(0, limit), limit, '/faqs', []) : null;
			if (faqs && faqs.length > 0) out[field] = faqs;
			continue;
		}
		if (typeof raw !== 'string') continue;
		const clean = cleanText(raw.slice(0, limit), limit, { multiline: field === 'description' || field === 'intro' });
		if (clean) out[field] = clean;
	}
	return Object.keys(out).length > 0 ? out : null;
};

/** @typedef {keyof typeof LANDING_FIELDS} LandingField */

/**
 * Check a landing page copy request (E15): the fields wanted, a tone and a language.
 * @param {unknown} body
 * @returns {{ ok: true, value: { fields: LandingField[], tone: string, language: string } } | { ok: false, path: string, message: string }}
 */
export const checkLandingAiRequest = (body) => {
	const input = isObject(body) ? body : {};
	const fields = Array.isArray(input.fields) ? [...new Set(input.fields)] : Object.keys(LANDING_FIELDS);
	if (fields.length === 0 || !fields.every((field) => Object.hasOwn(LANDING_FIELDS, field)))
		return { ok: false, path: '/fields', message: `Pick fields among ${Object.keys(LANDING_FIELDS).join(', ')}.` };
	const tone = input.tone === undefined ? '' : cleanText(input.tone, 100);
	const language = input.language === undefined ? '' : cleanText(input.language, 40);
	if (tone === null || language === null)
		return { ok: false, path: '/tone', message: 'A tone has at most 100 characters and a language 40.' };
	return { ok: true, value: { fields: /** @type {LandingField[]} */ (fields), tone, language } };
};

/** What each landing field is, for the prompt. */
const LANDING_NOTES = Object.freeze({
	h1: '"h1": the page heading (at most 80 characters)',
	title: '"title": a page title for search engines (at most 60 characters)',
	description: '"description": a meta description for search engines (at most 155 characters)',
	intro: '"intro": an introduction of two short plain paragraphs separated by a blank line',
	faqs: '"faqs": 3 to 6 questions shoppers ask about these products with short factual answers, as [{ "question", "answer" }]',
});

/**
 * The prompt for a landing page's copy (E15): what it lists (category, brand, grade) and some of its products.
 * @param {{ category: string | null, brand: string | null, grade: string | null, products: string[] }} facts
 * @param {{ fields: LandingField[], tone: string, language: string }} request
 */
export const landingPrompt = (facts, { fields, tone, language }) => {
	const system = [
		'You write copy for a page of an online shop that lists products.',
		'Use only the facts given; never invent specifications, prices, offers or guarantees.',
		`Write in ${language || 'the language of the facts'}.`,
		tone ? `Tone: ${tone}.` : '',
		'Answer with one JSON object and nothing else.',
	]
		.filter(Boolean)
		.join(' ');
	const prompt = [
		'Page facts:',
		facts.category ? `Category: ${facts.category}` : '',
		facts.brand ? `Brand: ${facts.brand}` : '',
		facts.grade ? `Condition grade: ${facts.grade}` : '',
		facts.products.length > 0 ? `Some products: ${facts.products.slice(0, 20).join(', ')}` : '',
		'',
		`Write these fields: ${fields.map((field) => LANDING_NOTES[field]).join('; ')}.`,
	]
		.filter((line, index, all) => line !== '' || all[index - 1] !== '')
		.join('\n');
	return { system, prompt, limits: LANDING_FIELDS };
};
