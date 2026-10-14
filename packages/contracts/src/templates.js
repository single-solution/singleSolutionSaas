/**
 * Message templates (PLAN 0.8.5, 0.8.10 N2): the rules every template's words follow wherever they are written — a
 * merchant's template in Notifications, or a product's default template (its `schemas/messages.json`, checked by
 * `validateMessageDefaults`). One copy of the rules, so a default always passes the checks a merchant's template
 * passes. Pure and browser-safe: Notifications' `core/` and widgets use it through `@ss/contracts/templates`.
 *
 * - A template key is 1–64 lower-case letters, digits, `_`, `.` or `-`, starting with a letter; a product's own keys
 *   start with its id and a dot (`accounts.password_reset`).
 * - `{name}` is a placeholder filled from the send's value `name` as plain text; `{?name}…{/name}` is an optional
 *   section shown only when the value `name` is not empty. Names are letters, digits and `_`, starting with a letter,
 *   at most 64 characters.
 * - Email, browser push and staff push have a subject (a title): one line of at most 200 characters. The text has at
 *   most 100,000 (email), 1,600 (SMS), 4,096 (WhatsApp) or 500 (push) characters.
 * - Notifications fills `{unsubscribeUrl}` itself, in optional messages only.
 * @module
 */

/** @typedef {'email' | 'sms' | 'whatsapp' | 'push' | 'staff_push'} TemplateChannel */

/** The channels a template is written for. */
export const TEMPLATE_CHANNELS = Object.freeze(
	/** @type {TemplateChannel[]} */ (['email', 'sms', 'whatsapp', 'push', 'staff_push']),
);

/** Template keys: lower case, digits, `_`, `.` and `-`, starting with a letter. */
export const TEMPLATE_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

/** A value's name (a placeholder or an optional section). */
export const VALUE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Longest texts per channel (characters). */
export const TEXT_LIMITS = Object.freeze({ email: 100_000, sms: 1600, whatsapp: 4096, push: 500, staff_push: 500 });

/** Longest subject (email) or title (push). */
export const SUBJECT_LIMIT = 200;

/** Values Notifications fills itself (optional messages only). */
export const BUILT_IN_VALUES = Object.freeze(['unsubscribeUrl']);

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g;
/** An optional section's opening `{?name}` or closing `{/name}` tag. */
const SECTION_TAG = /\{([?/])([A-Za-z][A-Za-z0-9_]{0,63})\}/g;

/**
 * Whether a channel's templates have a subject (email) or a title (push).
 * @param {string} channel
 */
export const isTitled = (channel) => channel === 'email' || channel === 'push' || channel === 'staff_push';

/**
 * The placeholders a text uses, in order of first use.
 * @param {string} text
 * @returns {string[]}
 */
export const placeholdersOf = (text) => [
	...new Set([...text.matchAll(PLACEHOLDER)].map((match) => /** @type {string} */ (match[1]))),
];

/**
 * Every value name a text uses, in order of first use: its placeholders and the names of its optional sections.
 * @param {string} text
 * @returns {string[]}
 */
export const valueNamesOf = (text) => [
	...new Set([...text.matchAll(/\{\??([A-Za-z][A-Za-z0-9_]{0,63})\}/g)].map((match) => /** @type {string} */ (match[1]))),
];

/**
 * What is wrong with the optional sections of a text, or null: every `{?name}` is closed by a later `{/name}`,
 * sections nest without crossing, and a section never sits inside one of the same name.
 * @param {string} text
 * @returns {string | null}
 */
export const sectionProblem = (text) => {
	/** @type {string[]} */
	const open = [];
	for (const [, kind, name] of text.matchAll(SECTION_TAG)) {
		if (kind === '?') {
			if (open.includes(/** @type {string} */ (name))) return `{?${name}} is already open: close it with {/${name}} first.`;
			open.push(/** @type {string} */ (name));
		} else if (open.at(-1) === name) open.pop();
		else
			return open.includes(/** @type {string} */ (name))
				? `Close {?${open.at(-1)}} before {/${name}}.`
				: `{/${name}} closes no {?${name}}.`;
	}
	return open.length > 0 ? `Close {?${open.at(-1)}} with {/${open.at(-1)}}.` : null;
};

/**
 * What is wrong with the words of a template on a channel, or null: the text is written and fits the channel, a
 * titled channel has a subject, a subject is one line that fits, and the optional sections are well formed. The words
 * are checked as given (trim them first).
 * @param {TemplateChannel} channel
 * @param {{ subject: string, text: string }} words SMS and WhatsApp send no subject (pass `''`)
 * @returns {{ field: 'subject' | 'text', message: string } | null}
 */
export const wordsProblem = (channel, { subject, text }) => {
	const titled = isTitled(channel);
	if (text.length === 0) return { field: 'text', message: 'Write the message.' };
	if (text.length > TEXT_LIMITS[channel])
		return { field: 'text', message: `The message can have at most ${TEXT_LIMITS[channel]} characters.` };
	if (titled && subject.length === 0)
		return { field: 'subject', message: channel === 'email' ? 'Write the subject.' : 'Write the title.' };
	if (subject.length > SUBJECT_LIMIT || /[\r\n]/.test(subject))
		return { field: 'subject', message: `Use one line of at most ${SUBJECT_LIMIT} characters.` };
	const textSections = sectionProblem(text);
	if (textSections) return { field: 'text', message: textSections };
	const subjectSections = titled ? sectionProblem(subject) : null;
	if (subjectSections) return { field: 'subject', message: subjectSections };
	return null;
};
