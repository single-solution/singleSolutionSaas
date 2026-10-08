/**
 * Language handling (pure), generalised from the ibrahimMobiles server-side language lock: prompt rules alone drift,
 * so the customer's language is detected from each message and an AI answer in another language is retried once or
 * replaced. Nothing is regional: non-Latin scripts are recognised from Unicode script data; Latin-script languages
 * (including romanised ones) are told apart by the merchant's configurable marker words (`window.language_markers`).
 * @module
 */
import { tokenize } from './text.js';

/** Unicode script of the languages written in a non-Latin script (Unicode data, not a market assumption). */
const LANGUAGE_SCRIPTS = Object.freeze({
	ar: 'Arabic',
	fa: 'Arabic',
	ur: 'Arabic',
	ps: 'Arabic',
	ku: 'Arabic',
	sd: 'Arabic',
	ug: 'Arabic',
	he: 'Hebrew',
	yi: 'Hebrew',
	ru: 'Cyrillic',
	uk: 'Cyrillic',
	bg: 'Cyrillic',
	sr: 'Cyrillic',
	mk: 'Cyrillic',
	be: 'Cyrillic',
	kk: 'Cyrillic',
	ky: 'Cyrillic',
	mn: 'Cyrillic',
	el: 'Greek',
	hi: 'Devanagari',
	mr: 'Devanagari',
	ne: 'Devanagari',
	sa: 'Devanagari',
	bn: 'Bengali',
	as: 'Bengali',
	pa: 'Gurmukhi',
	gu: 'Gujarati',
	or: 'Oriya',
	ta: 'Tamil',
	te: 'Telugu',
	kn: 'Kannada',
	ml: 'Malayalam',
	si: 'Sinhala',
	th: 'Thai',
	lo: 'Lao',
	km: 'Khmer',
	my: 'Myanmar',
	ka: 'Georgian',
	hy: 'Armenian',
	am: 'Ethiopic',
	ko: 'Hangul',
	ja: 'Japanese',
	zh: 'Han',
});

/** Scripts recognised in text, in detection order (Japanese kana before Han: Japanese text mixes both). */
const SCRIPT_PATTERNS = Object.freeze([
	['Japanese', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
	['Hangul', /\p{Script=Hangul}/gu],
	['Han', /\p{Script=Han}/gu],
	['Arabic', /\p{Script=Arabic}/gu],
	['Hebrew', /\p{Script=Hebrew}/gu],
	['Cyrillic', /\p{Script=Cyrillic}/gu],
	['Greek', /\p{Script=Greek}/gu],
	['Devanagari', /\p{Script=Devanagari}/gu],
	['Bengali', /\p{Script=Bengali}/gu],
	['Gurmukhi', /\p{Script=Gurmukhi}/gu],
	['Gujarati', /\p{Script=Gujarati}/gu],
	['Oriya', /\p{Script=Oriya}/gu],
	['Tamil', /\p{Script=Tamil}/gu],
	['Telugu', /\p{Script=Telugu}/gu],
	['Kannada', /\p{Script=Kannada}/gu],
	['Malayalam', /\p{Script=Malayalam}/gu],
	['Sinhala', /\p{Script=Sinhala}/gu],
	['Thai', /\p{Script=Thai}/gu],
	['Lao', /\p{Script=Lao}/gu],
	['Khmer', /\p{Script=Khmer}/gu],
	['Myanmar', /\p{Script=Myanmar}/gu],
	['Georgian', /\p{Script=Georgian}/gu],
	['Armenian', /\p{Script=Armenian}/gu],
	['Ethiopic', /\p{Script=Ethiopic}/gu],
]);

/** @typedef {{ language: string, words: string[] }} MarkerSet */
/**
 * @typedef {object} LanguageOptions
 * @property {string} fallback language when nothing is detected (the conversation's last language or the default)
 * @property {readonly string[]} [allowed] allowed languages (empty = any)
 * @property {readonly MarkerSet[]} [markers]
 * @property {number} [minMarkers] markers needed to pick a Latin-script language (default 2)
 */

/**
 * Primary subtag (`pt-BR` → `pt`).
 * @param {string} tag
 */
const primary = (tag) => String(tag).toLowerCase().split('-')[0] ?? '';

/** ISO 15924 script subtags (`ur-Latn`, `sr-Cyrl`) → the script names used here. */
const SCRIPT_SUBTAGS = Object.freeze({
	latn: 'Latin',
	arab: 'Arabic',
	hebr: 'Hebrew',
	cyrl: 'Cyrillic',
	grek: 'Greek',
	deva: 'Devanagari',
	beng: 'Bengali',
	guru: 'Gurmukhi',
	gujr: 'Gujarati',
	orya: 'Oriya',
	taml: 'Tamil',
	telu: 'Telugu',
	knda: 'Kannada',
	mlym: 'Malayalam',
	sinh: 'Sinhala',
	thai: 'Thai',
	laoo: 'Lao',
	khmr: 'Khmer',
	mymr: 'Myanmar',
	geor: 'Georgian',
	armn: 'Armenian',
	ethi: 'Ethiopic',
	hang: 'Hangul',
	kore: 'Hangul',
	jpan: 'Japanese',
	hans: 'Han',
	hant: 'Han',
	hani: 'Han',
});

/**
 * Script of a language tag: its script subtag (`ur-Latn` is romanised Urdu), else the language's usual script, else
 * Latin.
 * @param {string} tag
 */
const scriptOf = (tag) => {
	const subtag = String(tag)
		.split('-')
		.slice(1)
		.find((part) => /^[A-Za-z]{4}$/.test(part));
	const fromSubtag = subtag ? /** @type {Record<string, string>} */ (SCRIPT_SUBTAGS)[subtag.toLowerCase()] : undefined;
	return fromSubtag ?? /** @type {Record<string, string>} */ (LANGUAGE_SCRIPTS)[primary(tag)] ?? 'Latin';
};

/**
 * Letters per script in a text.
 * @param {string} text
 * @returns {{ latin: number, scripts: Record<string, number>, letters: number }}
 */
const scriptCounts = (text) => {
	/** @type {Record<string, number>} */
	const scripts = {};
	for (const [name, pattern] of SCRIPT_PATTERNS) {
		const found = String(text).match(/** @type {RegExp} */ (pattern))?.length ?? 0;
		if (found > 0) scripts[/** @type {string} */ (name)] = found;
	}
	const latin = String(text).match(/\p{Script=Latin}/gu)?.length ?? 0;
	const letters = latin + Object.values(scripts).reduce((sum, n) => sum + n, 0);
	return { latin, scripts, letters };
};

/**
 * The dominant non-Latin script of a text (≥ 20 % of its letters), or null.
 * @param {string} text
 * @returns {string | null}
 */
const dominantScript = (text) => {
	const { scripts, letters } = scriptCounts(text);
	if (letters === 0) return null;
	/** @type {Record<string, number>} */
	const merged = { ...scripts };
	// Japanese text mixes kana and Han: any kana make the Han letters Japanese
	if (merged.Japanese) {
		merged.Japanese += merged.Han ?? 0;
		delete merged.Han;
	}
	let best = null;
	let bestCount = 0;
	for (const [name, count] of Object.entries(merged)) {
		if (count > bestCount) {
			best = name;
			bestCount = count;
		}
	}
	return best !== null && bestCount / letters >= 0.2 ? best : null;
};

/**
 * Marker hits per language for a Latin-script text.
 * @param {string} text
 * @param {readonly MarkerSet[]} markers
 * @returns {Array<{ language: string, hits: number }>} sorted by hits (desc)
 */
const markerScores = (text, markers) => {
	const words = tokenize(text, { minLength: 1 });
	const counts = new Map();
	for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
	return markers
		.map((set) => ({
			language: set.language,
			hits: [...new Set(set.words.flatMap((w) => tokenize(w, { minLength: 1 })))].reduce(
				(sum, w) => sum + (counts.get(w) ?? 0),
				0,
			),
		}))
		.sort((a, b) => b.hits - a.hits);
};

/**
 * Is a language allowed? (empty allow-list = any; `pt` admits `pt-BR` and the reverse).
 * @param {string} tag
 * @param {readonly string[] | undefined} allowed
 */
const isAllowed = (tag, allowed) =>
	!allowed || allowed.length === 0 || allowed.some((a) => a === tag || primary(a) === primary(tag));

/**
 * Detect the language of one customer message.
 * @param {string} message
 * @param {LanguageOptions} options
 * @returns {{ language: string, script: string, confident: boolean }}
 */
export const detectLanguage = (message, { fallback, allowed = [], markers = [], minMarkers = 2 }) => {
	const text = String(message ?? '').trim();
	const script = dominantScript(text);
	if (script) {
		const candidates = Object.entries(LANGUAGE_SCRIPTS)
			.filter(([, s]) => s === script)
			.map(([tag]) => tag);
		// prefer the fallback or an allowed language of that script, else the first language of the script
		const pick =
			[fallback, ...allowed].find((tag) => scriptOf(tag) === script) ?? (allowed.length === 0 ? candidates[0] : undefined);
		if (pick && isAllowed(pick, allowed)) return { language: pick, script, confident: true };
		return { language: fallback, script: scriptOf(fallback), confident: false };
	}
	const latinMarkers = markers.filter((set) => scriptOf(set.language) === 'Latin' && isAllowed(set.language, allowed));
	const [best, second] = markerScores(text, latinMarkers);
	const words = Math.max(1, tokenize(text, { minLength: 1 }).length);
	if (best && best.hits > (second?.hits ?? 0) && (best.hits >= minMarkers || (words <= 3 && best.hits >= 1))) {
		return { language: best.language, script: 'Latin', confident: true };
	}
	return { language: fallback, script: scriptOf(fallback), confident: false };
};

/**
 * Markdown tables and code are language-neutral data blocks.
 * @param {string} text
 */
export const isLanguageNeutral = (text) => {
	const lines = String(text)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.length > 0 && lines.every((line) => /^\|.+\|$/.test(line) || /^[-:| ]+$/.test(line));
};

/**
 * Does an answer match the required language? Non-Latin languages need their script to dominate; Latin-script
 * languages must not be dominated by another script nor clearly by another configured Latin language.
 * @param {string} reply
 * @param {string} required
 * @param {{ markers?: readonly MarkerSet[] }} [options]
 */
export const replyMatchesLanguage = (reply, required, { markers = [] } = {}) => {
	const text = String(reply ?? '').trim();
	if (!text) return false;
	if (isLanguageNeutral(text)) return true;
	const target = scriptOf(required);
	const { latin, scripts, letters } = scriptCounts(text);
	if (letters === 0) return true;
	if (target !== 'Latin') {
		const own = (scripts[target] ?? 0) + (target === 'Japanese' ? (scripts.Han ?? 0) : 0);
		return own / letters >= 0.3;
	}
	if (latin / letters < 0.5) return false;
	const scores = markerScores(
		text,
		markers.filter((set) => scriptOf(set.language) === 'Latin'),
	);
	const mine = scores.find((s) => primary(s.language) === primary(required))?.hits ?? 0;
	const other = scores.find((s) => primary(s.language) !== primary(required));
	if (!other) return true;
	return !(other.hits >= 3 && other.hits >= 2 * Math.max(1, mine) && mine < 2);
};

/**
 * Human name of a language in English (for the model), e.g. `pt-BR` → `Brazilian Portuguese`.
 * @param {string} tag
 */
export const languageName = (tag) => {
	try {
		return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
	} catch {
		return tag;
	}
};
