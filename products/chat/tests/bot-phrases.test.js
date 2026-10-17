/**
 * "Never say it is a bot" (C1) in any language: Chat carries the phrases that give a bot away for the languages most
 * websites answer in, checks every set on every answer, and takes the merchant's own wording on top (a language Chat
 * does not cover, or the assistant's own name).
 */
import { describe, expect, it } from 'vitest';
import { BOT_PHRASES, botPhrases } from '../core/bot-phrases.js';
import { disclosesBot } from '../core/prompt.js';
import { normalize, tokenize } from '../core/text.js';

/** @param {string} text @param {unknown} [extra] */
const gives = (text, extra) => disclosesBot(text, botPhrases(extra));

/** One answer per language that says it is a bot or an AI. */
const REVEALING = /** @type {Array<[string, string]>} */ ([
	['en', 'As an AI language model, I cannot say.'],
	['es', 'Soy una IA, pero puedo ayudarte con tu pedido.'],
	['fr', 'Je suis une IA, mais je peux vous aider avec votre commande.'],
	['de', 'Ich bin ein Bot und helfe Ihnen gern weiter.'],
	['pt', 'Como uma IA, eu não tenho acesso a isso.'],
	['it', 'Sono un assistente virtuale, posso aiutarla con l’ordine.'],
	['nl', 'Ik ben geen mens, maar ik help u graag.'],
	['pl', 'Jestem sztuczną inteligencją, ale chętnie pomogę.'],
	['tr', 'Ben bir yapay zekayım, size yardımcı olabilirim.'],
	['id', 'Saya adalah AI, tetapi saya bisa membantu.'],
	['vi', 'Tôi là AI, nhưng tôi có thể giúp bạn.'],
	['ru', 'Я искусственный интеллект, но могу помочь с заказом.'],
	['ar', 'أنا ذكاء اصطناعي ولكن يمكنني مساعدتك في طلبك.'],
	['ur', 'میں ایک بوٹ ہوں لیکن آپ کی مدد کر سکتا ہوں۔'],
	['hi', 'मैं एक एआई हूं, लेकिन मैं आपकी मदद कर सकता हूं।'],
	['ja', '私はAIアシスタントです。ご注文をお手伝いします。'],
	['zh', '我是人工智能助手，可以帮您查询订单。'],
	['ko', '저는 AI입니다. 주문을 도와드릴게요.'],
]);

/** One ordinary shop answer per language (the lamps ship in two days) that must never be taken for a bot's confession. */
const ORDINARY = /** @type {Array<[string, string]>} */ ([
	['en', 'Our lamps ship in two days.'],
	['es', 'Nuestras lámparas se envían en dos días.'],
	['fr', "J'ai bien reçu votre commande, nos lampes partent sous deux jours."],
	['de', 'Unsere Lampen werden in zwei Tagen versandt.'],
	['pt', 'Como ia dizer, as lâmpadas saem em dois dias.'],
	['it', 'Ai nostri clienti spediamo le lampade in due giorni.'],
	['nl', 'Onze lampen worden binnen twee dagen verzonden.'],
	['pl', 'Nasze lampy wysyłamy w dwa dni.'],
	['tr', 'Lambalarımız iki gün içinde kargoya verilir.'],
	['id', 'Lampu kami dikirim dalam dua hari.'],
	['vi', 'Đèn của chúng tôi được gửi trong hai ngày.'],
	['ru', 'Наши лампы отправляются за два дня.'],
	['ar', 'نشحن مصابيحنا خلال يومين.'],
	['ur', 'ہمارے لیمپ دو دن میں بھیجے جاتے ہیں۔'],
	['hi', 'हमारे लैंप दो दिनों में भेजे जाते हैं।'],
	['ja', 'ランプは2日以内に発送します。'],
	['zh', '我们的台灯两天内发货。'],
	['ko', '램프는 이틀 안에 발송됩니다.'],
]);

describe('the phrases that give a bot away', () => {
	it.each(REVEALING)('are found in an answer in %s', (_language, answer) => {
		expect(gives(answer)).toBe(true);
	});

	it.each(ORDINARY)('are not found in an ordinary answer in %s', (_language, answer) => {
		expect(gives(answer)).toBe(false);
	});

	it('are found whatever the case, accents and apostrophes', () => {
		expect(gives("I'M A BOT, sorry.")).toBe(true);
		expect(gives('JE SUIS UNE IA')).toBe(true);
		expect(gives('en tant qu’IA, je ne peux pas')).toBe(true);
		expect(gives('Modele de langage')).toBe(true);
		expect(gives('ICH BIN EIN BOT')).toBe(true);
	});

	it('are whole words: a longer word that holds one does not count', () => {
		expect(gives('The chatbotanist waters the plants.')).toBe(false);
		expect(gives('Das Sprachmodellbau-Set ist ausverkauft.')).toBe(false);
	});

	it('hold a bot that mixes languages', () => {
		expect(gives('Hola! Como un virtual assistant, puedo ayudarte.')).toBe(true);
	});

	it('are language data: set by language tag, none a short single word that other languages or sentences use', () => {
		expect(Object.keys(BOT_PHRASES)).toEqual(
			expect.arrayContaining(['en', 'es', 'fr', 'de', 'pt', 'it', 'ar', 'hi', 'ja', 'zh', 'ru', 'tr']),
		);
		const seen = new Set();
		for (const [language, phrases] of Object.entries(BOT_PHRASES)) {
			expect(language).toMatch(/^[a-z]{2,3}$/);
			expect(phrases.length).toBeGreaterThan(0);
			for (const phrase of phrases) {
				const words = tokenize(phrase, { minLength: 1 });
				const key = words.join(' ');
				// two words or more, or one word of at least four letters ("ai" is a verb in French, a preposition in Italian)
				expect(words.length >= 2 || [...normalize(phrase)].length >= 4, `${language}: ${phrase}`).toBe(true);
				expect(seen.has(key), `${language}: ${phrase} is twice in the sets`).toBe(false);
				seen.add(key);
			}
		}
	});
});

describe('the merchant’s own phrases', () => {
	it('come on top of the built-in ones, in any language', () => {
		const built = botPhrases();
		expect(botPhrases(undefined)).toBe(built);
		expect(botPhrases([])).toBe(built);
		expect(botPhrases(['Lumi your automated helper']).length).toBe(built.length + 1);
		// nothing else counts: no list, a blank phrase, a number
		expect(botPhrases('Lumi')).toBe(built);
		expect(botPhrases(['', '   ', 5, null])).toBe(built);
	});

	it('catch the wording of a language Chat does not cover and of the assistant itself', () => {
		// Tagalog is not built in
		const tagalog = 'Ako ay isang chat assistant na awtomatiko.';
		expect(gives(tagalog)).toBe(false);
		expect(gives(tagalog, ['ako ay isang chat assistant'])).toBe(true);
		const brand = 'Hi, here is Lumi, your automated helper at Lamps & Co.';
		expect(gives(brand)).toBe(false);
		expect(gives(brand, ['Lumi, your automated helper'])).toBe(true);
	});

	it('keep the built-in phrases working', () => {
		expect(gives('Soy una IA.', ['Lumi'])).toBe(true);
	});
});
