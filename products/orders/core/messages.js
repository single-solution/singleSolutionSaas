/**
 * Customer status messages (pure; review A1 — customers hear about every step, not only staff): which status sends a
 * message, the channel the customer can be reached on, the merchant's template for the status, language and channel
 * (else the product's default text in that language) and the rendered text. Delivery happens elsewhere (adapters).
 * @module
 */
import { fill } from './text.js';

/** Pseudo-status of a new order. */
export const PLACED = 'placed';

/**
 * @typedef {{ status: string, lang?: string, channel?: string, subject?: string, text: string }} Template
 */

/**
 * The first preferred channel the customer can be reached on.
 * @param {{ email?: string | null, phone?: string | null }} contact
 * @param {readonly string[]} channels
 * @returns {{ channel: string, to: { email: string } | { phone: string } } | null}
 */
export const pickChannel = (contact, channels) => {
	for (const channel of channels) {
		if (channel === 'email' && contact.email) return { channel, to: { email: contact.email } };
		if ((channel === 'sms' || channel === 'whatsapp') && contact.phone) return { channel, to: { phone: contact.phone } };
	}
	return null;
};

/**
 * The best template: exact language before its base language before language-less templates; within each, the
 * channel's own template before an `any` one.
 * @param {readonly Template[]} templates
 * @param {{ status: string, lang: string, channel: string }} want
 * @returns {Template | null}
 */
export const pickTemplate = (templates, { status, lang, channel }) => {
	const base = lang.split('-')[0];
	const candidates = templates.filter((t) => t.status === status);
	for (const language of [lang, base, undefined]) {
		for (const ch of [channel, 'any']) {
			const match = candidates.find(
				(t) => (t.lang ?? undefined) === language && (t.channel === ch || (ch === 'any' && t.channel === undefined)),
			);
			if (match) return match;
		}
	}
	return null;
};

/**
 * The string catalog for a language: exact, then its base language, then English.
 * @param {Record<string, Record<string, string>>} catalogs
 * @param {string | null | undefined} lang
 * @returns {{ lang: string, strings: Record<string, string> }}
 */
export const catalogFor = (catalogs, lang) => {
	const wanted = typeof lang === 'string' && lang ? lang : 'en';
	for (const candidate of [wanted, wanted.split('-')[0] ?? 'en']) {
		const strings = catalogs[candidate];
		if (strings) return { lang: candidate, strings };
	}
	return { lang: 'en', strings: catalogs.en ?? {} };
};

/**
 * Render a message for a status.
 * @param {{ status: string, channel: string, lang: string, templates: readonly Template[], strings: Record<string, string>,
 *   values: Record<string, string | number | null | undefined> }} input
 * @returns {{ subject: string | null, text: string }}
 */
export const renderMessage = ({ status, channel, lang, templates, strings, values }) => {
	const template = pickTemplate(templates, { status, lang, channel });
	const fallbackText = strings[`updates.${status}.text`] ?? strings['updates.default.text'] ?? '{number}';
	const fallbackSubject = strings[`updates.${status}.subject`] ?? strings['updates.default.subject'] ?? null;
	const text = fill(template?.text ?? fallbackText, values).trim();
	const subjectSource = template ? (template.subject ?? fallbackSubject) : fallbackSubject;
	return { subject: channel === 'email' && subjectSource ? fill(subjectSource, values).trim().slice(0, 200) : null, text };
};
