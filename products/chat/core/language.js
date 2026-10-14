/**
 * Language handling (pure), a language lock on the server: prompt rules alone drift, so the customer's language is
 * detected from each message and an AI answer in another language is retried once or replaced. Nothing is regional:
 * non-Latin scripts are recognized from Unicode script data, and the languages that share a script are told apart by
 * the letters only some of them use plus the merchant's marker words; Latin-script languages (including romanized ones)
 * are told apart by the marker words, with thresholds the merchant sets (PLAN 0.8.10, the re-audit's CH-16, CH-17). A
 * reply is checked as a whole or part by part (`checkMode`, CH-18), and a language may be accepted in its own script or
 * in Latin letters (`acceptLatinFor`, CH-16).
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

/** Scripts recognized in text, in detection order (Japanese kana before Han: Japanese text mixes both). */
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

/**
 * Letters that set languages written in the same script apart (Unicode letters, not a market assumption): each language
 * lists every letter of this kind it uses, so such a letter in a text speaks for the languages that use it and against
 * those that do not. Letters every language of the script uses are not listed.
 */
const LANGUAGE_LETTERS = Object.freeze({
	ar: 'ةيكى',
	fa: 'پچژگکی',
	ur: 'پچژگکیٹڈڑںےۓہۂھ',
	ps: 'پچژکیټډړږښځڅېۍڼګ',
	sd: 'پچکیھٻڀٽٿڃڄڇڊڌڍڏڙڦڪڱڳڻ',
	ku: 'پچژگکیڕڵۆێە',
	ug: 'پچژگکیېۆۇۈۋەڭ',
	ru: 'ыэё',
	uk: 'іїєґ',
	bg: 'ъ',
	sr: 'ђјљњћџ',
	mk: 'ѓѕјљњќџ',
	be: 'ўіыэё',
	kk: 'әғқңөұүһіыэё',
	ky: 'ңөүыэё',
	mn: 'өүыэё',
	yi: 'ײװױ',
});

/** The lines of a markdown answer that split it into messages (C2). */
const SEPARATOR = /^[ \t]*-{3,}[ \t]*$/m;

/**
 * @typedef {object} MarkerSet
 * @property {string} language a language tag (`<language>-Latn` for a language written in Latin letters)
 * @property {string[]} words
 * @property {string[]} [phrases] words that count only together, in this order
 */
/**
 * @typedef {object} LanguageOptions
 * @property {string} fallback the language when the message shows none (the default language)
 * @property {readonly string[]} [allowed] allowed languages (empty = any)
 * @property {readonly MarkerSet[]} [markers]
 * @property {number} [minMarkers] marker words that pick a language (default 2)
 * @property {number} [markerShare] or this share of the message's words, from `minWordsForShare` words (default 0 =
 *   off: then one marker word picks a language in a message of up to 3 words)
 * @property {number} [minWordsForShare] (default 4)
 */
/**
 * @typedef {object} CheckOptions
 * @property {readonly MarkerSet[]} [markers]
 * @property {boolean} [strict] whole answers: a Latin-script language with marker words needs its share of them (C14)
 * @property {'whole' | 'presence'} [mode] `whole` (default): the whole answer; `presence`: each part (split on `---`
 *   lines) needs one marker word of the language, or a letter of its script (CH-18)
 * @property {readonly string[]} [latinFor] languages accepted in their own script or in Latin letters (CH-16)
 * @property {number} [minMarkers] `presence`: marker words of another language that make a part that language
 *   (default 2)
 */

/**
 * Primary subtag (`pt-BR` → `pt`).
 * @param {string} tag
 */
export const primary = (tag) => String(tag).toLowerCase().split('-')[0] ?? '';

/** ISO 15924 script subtags (`sr-Latn`, `zh-Hant`) → the script names used here. */
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
 * Script of a language tag: its script subtag (`sr-Latn` is Serbian in Latin letters), else the language's usual
 * script, else Latin.
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
 * How often a run of words occurs in a text's words (both joined with single spaces and padded).
 * @param {string} haystack
 * @param {string} needle
 */
const occurrences = (haystack, needle) => {
	let count = 0;
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length - 1)) count += 1;
	return count;
};

/**
 * Marker hits per language for a text.
 * @param {string} text
 * @param {readonly MarkerSet[]} markers
 * @returns {Array<{ language: string, hits: number }>} sorted by hits (desc)
 */
const markerScores = (text, markers) => {
	const words = tokenize(text, { minLength: 1 });
	const counts = new Map();
	for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
	const joined = ` ${words.join(' ')} `;
	return markers
		.map((set) => ({
			language: set.language,
			hits:
				[...new Set(set.words.flatMap((w) => tokenize(w, { minLength: 1 })))].reduce(
					(sum, w) => sum + (counts.get(w) ?? 0),
					0,
				) +
				[...new Set((set.phrases ?? []).map((phrase) => tokenize(phrase, { minLength: 1 }).join(' ')))]
					.filter((phrase) => phrase !== '')
					.reduce((sum, phrase) => sum + occurrences(joined, ` ${phrase} `), 0),
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
 * Only Latin letters (at least one)?
 * @param {string} text
 */
const latinOnly = (text) => {
	const { latin, letters } = scriptCounts(text);
	return latin > 0 && latin === letters;
};

/**
 * Marker word lines (`<language>: word word "two words"`; quoted words count only together) → marker sets. Words in
 * Latin letters under a language written in another script mark its romanized form, `<language>-Latn` (CH-39).
 * @param {readonly string[]} lines
 * @returns {MarkerSet[]}
 */
export const markerSetsOf = (lines) =>
	lines.flatMap((line) => {
		const match = /^\s*([a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\s*:\s*(.+)$/.exec(line);
		if (!match) return [];
		const found = [...String(match[2]).matchAll(/"([^"]*)"|([^\s,"]+)/g)];
		const quoted = found.flatMap((m) => (m[1] !== undefined && m[1].trim() ? [m[1].trim()] : []));
		const words = [
			...found.flatMap((m) => (m[2] !== undefined ? [m[2]] : [])),
			...quoted.filter((q) => tokenize(q, { minLength: 1 }).length <= 1),
		];
		const phrases = quoted.filter((q) => tokenize(q, { minLength: 1 }).length > 1);
		const tag = String(match[1]);
		const romanised = scriptOf(tag) !== 'Latin' && latinOnly([...words, ...phrases].join(' '));
		return [{ language: romanised ? `${primary(tag)}-Latn` : tag, words, phrases }];
	});

/** @param {string} tag */
const lettersOf = (tag) => /** @type {Record<string, string>} */ (LANGUAGE_LETTERS)[primary(tag)] ?? '';

/** Languages in the order of `LANGUAGE_SCRIPTS` (the usual language of a script first). */
const ORDER = Object.keys(LANGUAGE_SCRIPTS);

/**
 * The language of a text written in a non-Latin script, among the candidates of that script: the letters only some
 * of them use and the merchant's marker words count for a language (a letter it does not use counts against it); a tie
 * goes to the preferred languages in order, then to the script's usual language.
 * @param {string} text
 * @param {string} script
 * @param {{ candidates: string[], preferred: string[], markers: readonly MarkerSet[] }} input
 */
const pickInScript = (text, script, { candidates, preferred, markers }) => {
	const telling = new Set(ORDER.filter((tag) => scriptOf(tag) === script).flatMap((tag) => [...lettersOf(tag)]));
	const letters = [...new Set([...text.toLowerCase()].filter((ch) => telling.has(ch)))];
	const words = markerScores(text, markers);
	/** @param {string} tag */
	const score = (tag) =>
		letters.reduce((sum, ch) => sum + (lettersOf(tag).includes(ch) ? 1 : -1), 0) +
		words.filter((w) => primary(w.language) === primary(tag)).reduce((sum, w) => sum + w.hits, 0);
	/** @param {string} tag */
	const rank = (tag) => {
		const at = preferred.indexOf(tag);
		const usual = ORDER.indexOf(primary(tag));
		return at >= 0 ? at : preferred.length + (usual >= 0 ? usual : ORDER.length);
	};
	return [...candidates].sort((a, b) => score(b) - score(a) || rank(a) - rank(b))[0];
};

/**
 * Detect the language of one customer message.
 * @param {string} message
 * @param {LanguageOptions} options
 * @returns {{ language: string, script: string, confident: boolean }}
 */
export const detectLanguage = (
	message,
	{ fallback, allowed = [], markers = [], minMarkers = 2, markerShare = 0, minWordsForShare = 4 },
) => {
	const text = String(message ?? '').trim();
	const script = dominantScript(text);
	if (script) {
		/** @param {string} tag */
		const ofScript = (tag) => scriptOf(tag) === script;
		const scriptMarkers = markers.filter((set) => ofScript(set.language) && isAllowed(set.language, allowed));
		const preferred = [fallback, ...allowed].filter(ofScript);
		const candidates =
			allowed.length > 0
				? allowed.filter(ofScript)
				: [...new Set([...preferred, ...ORDER.filter(ofScript), ...scriptMarkers.map((set) => set.language)])];
		const pick = pickInScript(text, script, { candidates, preferred, markers: scriptMarkers });
		if (pick) return { language: pick, script, confident: true };
		return { language: fallback, script: scriptOf(fallback), confident: false };
	}
	const latinMarkers = markers.filter((set) => scriptOf(set.language) === 'Latin' && isAllowed(set.language, allowed));
	const [best, second] = markerScores(text, latinMarkers);
	const words = Math.max(1, tokenize(text, { minLength: 1 }).length);
	const enough =
		best !== undefined &&
		(best.hits >= minMarkers ||
			(markerShare > 0 ? words >= minWordsForShare && best.hits / words >= markerShare : words <= 3 && best.hits >= 1));
	if (best && enough && best.hits > (second?.hits ?? 0)) return { language: best.language, script: 'Latin', confident: true };
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

/** The least share of a reply's words that must be marker words of its language in a strict check. */
const STRICT_SHARE = 0.1;

/**
 * The forms a reply may take: the language itself, and with `latinFor` also its other script (its own script for
 * `<language>-Latn`, Latin letters for a language written in another script).
 * @param {string} required
 * @param {readonly string[]} latinFor
 */
export const languageForms = (required, latinFor) => {
	const base = primary(required);
	const own = /** @type {Record<string, string>} */ (LANGUAGE_SCRIPTS)[base];
	if (!own || !latinFor.some((tag) => primary(tag) === base)) return [required];
	return scriptOf(required) === 'Latin' ? [required, base] : [required, `${base}-Latn`];
};

/**
 * The whole answer (C14): non-Latin languages need their script to dominate; Latin-script languages must not be
 * dominated by another script nor clearly by another configured Latin language. With `strict`, a Latin-script language
 * that has marker words must also have its share of them: at least one, and at least `STRICT_SHARE` of the words.
 * @param {string} text
 * @param {string} required
 * @param {CheckOptions} options
 */
const wholeMatches = (text, required, { markers = [], strict = false }) => {
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
	if (strict && markers.some((set) => primary(set.language) === primary(required))) {
		const words = tokenize(text, { minLength: 1 }).length;
		if (mine === 0 || mine / Math.max(1, words) < STRICT_SHARE || (other !== undefined && other.hits > mine)) return false;
	}
	if (!other) return true;
	return !(other.hits >= 3 && other.hits >= 2 * Math.max(1, mine) && mine < 2);
};

/**
 * One part of an answer by presence (CH-18): a non-Latin language needs a letter of its script; a Latin-script
 * language with marker words needs one of them; one without needs no letters of another script and fewer than
 * `minMarkers` marker words of each other language.
 * @param {string} part
 * @param {string} required
 * @param {CheckOptions} options
 */
const presenceMatches = (part, required, { markers = [], minMarkers = 2 }) => {
	if (isLanguageNeutral(part)) return true;
	const target = scriptOf(required);
	const { latin, scripts, letters } = scriptCounts(part);
	if (letters === 0) return true;
	if (target !== 'Latin') return (scripts[target] ?? 0) + (target === 'Japanese' ? (scripts.Han ?? 0) : 0) > 0;
	const latinSets = markers.filter((set) => scriptOf(set.language) === 'Latin');
	const scores = markerScores(part, latinSets);
	if (latinSets.some((set) => primary(set.language) === primary(required)))
		return scores.some((s) => primary(s.language) === primary(required) && s.hits >= 1);
	return latin === letters && scores.every((s) => s.hits < minMarkers);
};

/**
 * Does an answer match the required language? `whole` (default) checks the whole answer; `presence` each part between
 * `---` lines (CH-18). With `latinFor`, the language may also be written in its other script (CH-16).
 * @param {string} reply
 * @param {string} required
 * @param {CheckOptions} [options]
 */
export const replyMatchesLanguage = (reply, required, options = {}) => {
	const text = String(reply ?? '').trim();
	if (!text) return false;
	const forms = languageForms(required, options.latinFor ?? []);
	if (options.mode !== 'presence') return forms.some((form) => wholeMatches(text, form, options));
	const parts = text
		.split(new RegExp(SEPARATOR.source, 'gm'))
		.map((part) => part.trim())
		.filter(Boolean);
	return parts.length > 0 && parts.every((part) => forms.some((form) => presenceMatches(part, form, options)));
};

/**
 * A text for a language from lines `<language>: text`: the line of the exact language, else of its primary subtag
 * (`pt` for `pt-BR`, `sr` for `sr-Latn`), else null.
 * @param {readonly string[]} lines
 * @param {string} language
 * @returns {string | null}
 */
export const translationOf = (lines, language) => {
	const found = lines.flatMap((line) => {
		const match = /^\s*([a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\s*:\s*(.+)$/.exec(line);
		return match ? [{ tag: String(match[1]).toLowerCase(), text: String(match[2]).trim() }] : [];
	});
	const wanted = language.toLowerCase();
	return found.find((line) => line.tag === wanted)?.text ?? found.find((line) => line.tag === primary(wanted))?.text ?? null;
};

/**
 * Human name of a language in English (for the model), e.g. `pt-BR` → `Brazilian Portuguese`.
 * @param {string} tag
 */
export const languageName = (tag) => {
	try {
		return new Intl.DisplayNames(['en-US'], { type: 'language' }).of(tag) ?? tag;
	} catch {
		return tag;
	}
};
