/**
 * AI copy (PLAN 0.8.8 Catalog SEO: product descriptions and meta text written with the merchant's own AI key): the
 * request for the merchant's provider, built from what the catalog knows about a product, and the suggestions read
 * from its answer. Suggestions are only shown to staff, never saved by themselves. No I/O.
 * @module
 */
import { LIMITS, cleanText, isObject } from './catalog.js';

/** The texts AI copy can suggest, with their longest length. */
export const AI_FIELDS = Object.freeze({
	description: LIMITS.description,
	summary: LIMITS.summary,
	seoTitle: 70,
	seoDescription: 160,
});

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
});

/**
 * The prompt: the product's facts and what to write, answered as one JSON object.
 * @param {{ name: string, summary: string, description: string, brand: string | null, categories: string[],
 *   specs: Array<{ name: string, value: string | number | boolean, unit: string }>, options: Array<{ name: string, values: string[] }>,
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
 * The suggestions in the model's answer: the JSON object (possibly inside a code block or text), each field cleaned
 * and cut to its length. A single field may also be answered as plain text.
 * @param {string} text
 * @param {AiField[]} fields
 * @returns {Partial<Record<AiField, string>> | null} null when nothing usable came back
 */
export const readSuggestions = (text, fields) => {
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
	if (!parsed && fields.length === 1 && text.trim()) parsed = { [/** @type {AiField} */ (fields[0])]: text.trim() };
	if (!parsed) return null;
	/** @type {Partial<Record<AiField, string>>} */
	const out = {};
	for (const field of fields) {
		const raw = parsed[field];
		if (typeof raw !== 'string') continue;
		const clean = cleanText(raw.slice(0, AI_FIELDS[field]), AI_FIELDS[field], { multiline: field === 'description' });
		if (clean) out[field] = clean;
	}
	return Object.keys(out).length > 0 ? out : null;
};
