/**
 * The language lock and message parts (PLAN 0.8.10, pure parts): the language lock tells languages of one script apart by
 * their letters and the merchant's marker words, with the merchant's thresholds, quoted phrases and romanized marker
 * lines; replies are checked whole or part by part, and a language may be accepted in Latin letters too (CH-16 to
 * CH-19, CH-38, CH-39). The languages here (Urdu, Arabic, Persian, Hindi, Russian, Ukrainian, Bulgarian, Spanish,
 * Tagalog and romanized forms) are only examples: nothing in Chat is about one language. Tables in messages of their
 * own (CH-21).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@ss/app-kit';
import { createFileSigner, createSealer } from '../adapters/crypto.js';
import { createLists } from '../adapters/lists.js';
import { detectLanguage, markerSetsOf, replyMatchesLanguage, translationOf } from '../core/language.js';
import { splitBubbles } from '../core/markdown.js';
import { buildSystemPrompt } from '../core/prompt.js';

const ROMAN = markerSetsOf(['ur-Latn: hai kya ye kitne ka bhai ji haan batao price "stock mein"']);

describe('the language of a message (CH-16, CH-17, CH-38, CH-39)', () => {
	it('tells languages of one script apart by their letters and marker words', () => {
		const any = { fallback: 'en' };
		expect(detectLanguage('یہ لیمپ کتنے کا ہے؟', any)).toMatchObject({ language: 'ur', script: 'Arabic' });
		expect(detectLanguage('كم سعر هذا المصباح؟', any).language).toBe('ar');
		expect(detectLanguage('این چراغ چند است', any).language).toBe('fa');
		expect(detectLanguage('यह लैंप कितने का है?', any)).toMatchObject({ language: 'hi', script: 'Devanagari' });
		expect(detectLanguage('سلام', any).language).toBe('ar');
		expect(detectLanguage('سلام', { fallback: 'ur' }).language).toBe('ur');
		expect(detectLanguage('كم السعر', { fallback: 'en', allowed: ['en', 'ur'] }).language).toBe('ur');
		expect(detectLanguage('خوب است', any).language).toBe('ar');
		expect(detectLanguage('خوب است', { ...any, markers: markerSetsOf(['fa: خوب است']) }).language).toBe('fa');
		expect(detectLanguage('Привет, как дела?', any).language).toBe('ru');
		expect(detectLanguage('Привіт, як справи?', any).language).toBe('uk');
		expect(detectLanguage('Къде е магазинът', any).language).toBe('bg');
		expect(detectLanguage('Привет', { fallback: 'en', allowed: ['en'] })).toMatchObject({ language: 'en', confident: false });
	});

	it('takes the merchant’s thresholds for Latin-script languages; quoted words count together', () => {
		const today = { fallback: 'en', markers: ROMAN };
		expect(detectLanguage('stock hai?', today).language).toBe('ur-Latn');
		expect(detectLanguage('is this lamp available hai', today).language).toBe('en');
		const shared = { ...today, markerShare: 0.15, minWordsForShare: 4 };
		expect(detectLanguage('stock hai?', shared).language).toBe('en');
		expect(detectLanguage('is this lamp available hai', shared).language).toBe('ur-Latn');
		expect(detectLanguage('price batao', shared).language).toBe('ur-Latn');
		expect(detectLanguage('bhai price', { ...today, minMarkers: 3, markerShare: 0.9 }).language).toBe('en');
		expect(detectLanguage('in stock?', shared).language).toBe('en');
		expect(detectLanguage('is it in stock mein?', shared).language).toBe('ur-Latn');
		expect(detectLanguage('Is this lamp in stock?', { ...today, allowed: ['ur', 'en'] }).language).toBe('en');
	});

	it('reads marker lines: romanized words under a non-Latin language, phrases, bad lines', () => {
		expect(markerSetsOf(['ur: hai kya, mein'])).toEqual([{ language: 'ur-Latn', words: ['hai', 'kya', 'mein'], phrases: [] }]);
		expect(markerSetsOf(['ur: ہے "کیا"'])).toEqual([{ language: 'ur', words: ['ہے', 'کیا'], phrases: [] }]);
		expect(markerSetsOf(['hi: hai kya'])).toEqual([{ language: 'hi-Latn', words: ['hai', 'kya'], phrases: [] }]);
		expect(markerSetsOf(['es: sí hay'])).toEqual([{ language: 'es', words: ['sí', 'hay'], phrases: [] }]);
		expect(markerSetsOf(['tl: po "salamat po" ""', 'no tag here'])).toEqual([
			{ language: 'tl', words: ['po'], phrases: ['salamat po'] },
		]);
	});
});

describe('the language of a reply (CH-16, CH-18, CH-19)', () => {
	it('accepts a language in its own script or in Latin letters when asked', () => {
		const roman = 'Ji haan, ye $45 ka hai.';
		expect(replyMatchesLanguage('یہ 45 ڈالر کا ہے', 'ur')).toBe(true);
		expect(replyMatchesLanguage(roman, 'ur', { markers: ROMAN })).toBe(false);
		expect(replyMatchesLanguage(roman, 'ur', { markers: ROMAN, latinFor: ['ur'] })).toBe(true);
		expect(replyMatchesLanguage('یہ 45 ڈالر کا ہے', 'ur-Latn', { markers: ROMAN, latinFor: ['ur'] })).toBe(true);
		expect(replyMatchesLanguage('یہ 45 ڈالر کا ہے', 'ur-Latn', { markers: ROMAN })).toBe(false);
		expect(replyMatchesLanguage('यह $45 का है', 'hi')).toBe(true);
		expect(replyMatchesLanguage('Yeh $45 ka hai', 'hi', { latinFor: ['hi'] })).toBe(true);
		expect(replyMatchesLanguage('Yeh $45 ka hai', 'hi')).toBe(false);
		expect(replyMatchesLanguage('Hola amigo', 'es', { latinFor: ['es'] })).toBe(true);
	});

	it('checks each part by presence: one marker word, or no other language', () => {
		const presence = { markers: ROMAN, mode: /** @type {const} */ ('presence') };
		expect(replyMatchesLanguage('Yes, it is in stock.', 'ur-Latn', presence)).toBe(false);
		expect(replyMatchesLanguage('Ji haan, the lamp is in stock.', 'ur-Latn', presence)).toBe(true);
		expect(replyMatchesLanguage('Yes, it is in stock.', 'ur', { ...presence, latinFor: ['ur'] })).toBe(false);
		expect(replyMatchesLanguage('Ji, ye stock mein hai.', 'ur', { ...presence, latinFor: ['ur'] })).toBe(true);
		expect(replyMatchesLanguage('Ji haan, ye hai.\n---\nThe warranty is one year.', 'ur-Latn', presence)).toBe(false);
		expect(replyMatchesLanguage('Ji haan, ye hai.\n---\n| Lamp | $45 |\n|---|---|', 'ur-Latn', presence)).toBe(true);
		expect(replyMatchesLanguage('Yes, the lamp is in stock.', 'en', presence)).toBe(true);
		expect(replyMatchesLanguage('Ji haan, the lamp is in stock.', 'en', presence)).toBe(false);
		expect(replyMatchesLanguage('Ji, the lamp is in stock.', 'en', presence)).toBe(true);
		expect(replyMatchesLanguage('The lamp یہ is in stock.', 'en', presence)).toBe(false);
		expect(replyMatchesLanguage('یہ ہے', 'ur', presence)).toBe(true);
		expect(replyMatchesLanguage('45 ✓', 'ur', presence)).toBe(true);
		expect(replyMatchesLanguage('\n---\n', 'en', presence)).toBe(false);
	});

	it('finds the unavailable message in the visitor’s language; the prompt names the other script', () => {
		const lines = ['ur-Latn: Maazrat, abhi jawab nahi.', 'UR: معذرت', 'es: Lo siento.', 'not a line'];
		expect(translationOf(lines, 'ur-Latn')).toBe('Maazrat, abhi jawab nahi.');
		expect(translationOf(lines, 'ur')).toBe('معذرت');
		expect(translationOf(lines, 'es-MX')).toBe('Lo siento.');
		expect(translationOf(lines, 'pt-BR')).toBeNull();
		const prompt = buildSystemPrompt({
			botName: 'Bot',
			business: { name: 'Shop' },
			instructions: null,
			dontKnow: 'Say so.',
			language: 'ur',
			languageAlso: 'ur-Latn',
			passages: [],
			visitor: { signedIn: false, name: null },
			page: null,
			handoff: false,
		});
		expect(prompt).toContain(
			'Answer only in Urdu (ur), whatever language the knowledge is in. Urdu (Latin) (ur-Latn) is fine too.',
		);
	});
});

describe('tables in messages of their own (CH-21)', () => {
	it('splits around each table within the most messages; off, only on --- lines', () => {
		const answer = 'Two lamps:\n| Lamp | Price |\n|---|---|\n| A | 1 |\n| B | 2 |\nWant one?\n---\n|x|\n|---|\nBye';
		expect(splitBubbles(answer, 5)).toEqual([
			'Two lamps:\n| Lamp | Price |\n|---|---|\n| A | 1 |\n| B | 2 |\nWant one?',
			'|x|\n|---|\nBye',
		]);
		expect(splitBubbles(answer, 5, { tables: true })).toEqual([
			'Two lamps:',
			'| Lamp | Price |\n|---|---|\n| A | 1 |\n| B | 2 |',
			'Want one?',
			'|x|\n|---|',
			'Bye',
		]);
		expect(splitBubbles(answer, 3, { tables: true })).toEqual([
			'Two lamps:',
			'| Lamp | Price |\n|---|---|\n| A | 1 |\n| B | 2 |',
			'Want one?\n\n|x|\n|---|\n\nBye',
		]);
		expect(splitBubbles('| a | b |\n|---|---|', 5, { tables: true })).toEqual(['| a | b |\n|---|---|']);
		expect(splitBubbles('a | b, no rule', 5, { tables: true })).toEqual(['a | b, no rule']);
	});
});

describe('attachment links (CH-8)', () => {
	it('opens only links this key signed, with every field', () => {
		const files = createFileSigner('k'.repeat(32));
		const file = { w: 'web_1', k: 'chat/guest-g1/a.png', n: 'a.png', t: 'image/png' };
		const token = files.sign(file);
		expect(files.open(token)).toEqual(file);
		expect(files.open(`${token}A`)).toBeNull();
		expect(files.open(`${token}.x`)).toBeNull();
		expect(files.open(42)).toBeNull();
		expect(createFileSigner('z'.repeat(32)).open(token)).toBeNull();
		expect(files.open(files.sign(/** @type {any} */ ({ ...file, w: 1 })))).toBeNull();
		// while ENCRYPTION_KEY changes, links signed with the previous key keep opening (RT-14)
		const changing = createFileSigner('z'.repeat(32), 'k'.repeat(32));
		expect(changing.open(token)).toEqual(file);
		expect(changing.open(changing.sign(file))).toEqual(file);
		expect(files.open(changing.sign(file))).toBeNull();
	});
});

describe('the tool signing secret through a change of ENCRYPTION_KEY (RT-14)', () => {
	it('opens with the previous key, is re-sealed with the new one, then the old key can go', async () => {
		const store = createMemoryStore({ now: () => 0 });
		const A = 'k'.repeat(32);
		const B = 'b'.repeat(32);
		const secret = await createLists({ store, sealer: createSealer(A), now: () => 0 }).toolSecret('web_1');
		const changing = createLists({ store, sealer: createSealer(B, A), now: () => 0 });
		expect(await changing.toolSecret('web_1')).toBe(secret);
		expect(await changing.resealToolSecrets()).toEqual({ resealed: 1, current: 0, unreadable: 0 });
		expect(await changing.resealToolSecrets()).toEqual({ resealed: 0, current: 1, unreadable: 0 });
		expect(await createLists({ store, sealer: createSealer(B), now: () => 0 }).toolSecret('web_1')).toBe(secret);
		expect(await createLists({ store, sealer: createSealer('c'.repeat(32)), now: () => 0 }).resealToolSecrets()).toEqual({
			resealed: 0,
			current: 0,
			unreadable: 1,
		});
	});
});
