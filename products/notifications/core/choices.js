/**
 * The merchant's own choices kept as list settings (fixed-choices N2, N4, N5, N6, N7): unsubscribe topics, the settings
 * of each template (its topic, its fallback channels, whether send limits count it), the website's fallback channels
 * per channel, the quiet hours and the unsubscribe keywords per language. Each list is saved whole (`PUT /v1/lists/<name>` or the dashboard); these are its checks.
 * No I/O.
 * @module
 */
import { TEMPLATE_KEY } from '@ss/contracts/templates';
import { CHANNELS, FALLBACK_CHANNELS } from './channels.js';

/** @typedef {import('./channels.js').Channel} Channel */
/** @typedef {import('./timing.js').QuietWindow} QuietWindow */
/** @typedef {Array<{ path: string, message: string }>} Errors */
/** @template T @typedef {{ ok: true, value: T } | { ok: false, errors: Errors }} Checked */

/** Most unsubscribe topics a website has (a system cap). */
export const MAX_TOPICS = 20;
/** Most template settings a website has (one per template key; a system cap). */
export const MAX_TEMPLATE_SETTINGS = 1000;
/** Most quiet windows (a system cap). */
export const MAX_QUIET_WINDOWS = 50;
/** Longest topic name. */
const TOPIC_NAME_LIMIT = 60;
/** A topic id: kept when the topic is renamed; links and recipients' choices name it. */
export const TOPIC_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** Most languages with unsubscribe keywords, and keywords per language (system caps). */
const MAX_KEYWORD_LANGUAGES = 30;
const MAX_KEYWORDS = 20;
/** A language tag (`en`, `pt-BR`) or `''` for any language. */
const KEYWORD_LANGUAGE = /^([a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3})?$/;
/** A local time of day. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * An unsubscribe topic (N2): recipients choose per topic which optional messages they get.
 * @typedef {{ id: string, name: string }} Topic
 */
/**
 * The merchant's settings of one template key (N2, N5, N7): its topic (null: none), its fallback channels in order
 * (null: the website's fallback channels of the channel it is sent on), and whether send limits count it (null: by the
 * send limits' rule).
 * @typedef {{ key: string, topic: string | null, fallback: Channel[] | null, capped: boolean | null }} TemplateSettings
 */
/**
 * The website's fallback channels of one channel, in order (N7).
 * @typedef {{ channel: Channel, then: Channel[] }} FallbackChain
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
const record = (value) =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};

/**
 * A topic id made from a name: lower-case letters, digits and _ (`Back in stock` → `back_in_stock`).
 * @param {string} name
 */
export const topicIdOf = (name) => {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 32);
	return /^[a-z]/.test(slug) ? slug : `topic_${slug}`.slice(0, 32).replace(/_+$/, '');
};

/**
 * Check the list `topics`: at most 20, each `{ id?, name }` (a new topic gets its id from its name; renaming keeps the
 * id), names and ids once each. The order is the order recipients see.
 * @param {unknown} input
 * @returns {Checked<Topic[]>}
 */
export const checkTopics = (input) => {
	if (!Array.isArray(input)) return { ok: false, errors: [{ path: '/value', message: 'The list is [{ id, name }].' }] };
	if (input.length > MAX_TOPICS)
		return { ok: false, errors: [{ path: '/value', message: `Add at most ${MAX_TOPICS} topics.` }] };
	/** @type {Errors} */
	const errors = [];
	/** @type {Topic[]} */
	const value = [];
	for (const [at, raw] of input.entries()) {
		const entry = record(raw);
		const name = typeof entry.name === 'string' ? entry.name.trim().replace(/\s+/g, ' ') : '';
		if (name.length === 0 || name.length > TOPIC_NAME_LIMIT) {
			errors.push({ path: `/value/${at}/name`, message: `Name the topic (at most ${TOPIC_NAME_LIMIT} characters).` });
			continue;
		}
		const id = entry.id === undefined || entry.id === null || entry.id === '' ? topicIdOf(name) : entry.id;
		if (typeof id !== 'string' || !TOPIC_ID.test(id)) {
			errors.push({ path: `/value/${at}/id`, message: 'Use 1–32 lower-case letters, digits or _, starting with a letter.' });
			continue;
		}
		if (value.some((topic) => topic.id === id))
			errors.push({ path: `/value/${at}/id`, message: `The topic ${id} is listed twice.` });
		else if (value.some((topic) => topic.name.toLowerCase() === name.toLowerCase()))
			errors.push({ path: `/value/${at}/name`, message: `Two topics are named ${name}.` });
		else value.push({ id, name });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Check an ordered list of fallback channels: channels a fallback may lead to, each once, never `from`.
 * @param {unknown} input
 * @param {string} path
 * @param {string | null} from the channel the chain starts on (null: any)
 * @returns {{ ok: true, value: Channel[] } | { ok: false, error: { path: string, message: string } }}
 */
const checkChain = (input, path, from) => {
	if (!Array.isArray(input) || input.length > FALLBACK_CHANNELS.length)
		return { ok: false, error: { path, message: `List the fallback channels in order: ${FALLBACK_CHANNELS.join(', ')}.` } };
	/** @type {Channel[]} */
	const value = [];
	for (const [at, channel] of input.entries()) {
		if (!FALLBACK_CHANNELS.includes(/** @type {any} */ (channel)) || channel === from || value.includes(channel))
			return {
				ok: false,
				error: { path: `${path}/${at}`, message: `Pick each of ${FALLBACK_CHANNELS.join(', ')} at most once.` },
			};
		value.push(/** @type {Channel} */ (channel));
	}
	return { ok: true, value };
};

/**
 * Check the list `template_settings`: one entry per template key with its topic (one of `topicIds`, or null), its
 * fallback channels (null: the website's), and whether send limits count it (null: by the rule). An entry that sets
 * nothing is dropped.
 * @param {unknown} input
 * @param {ReadonlyArray<string>} topicIds the website's topics
 * @returns {Checked<TemplateSettings[]>}
 */
export const checkTemplateSettings = (input, topicIds) => {
	if (!Array.isArray(input))
		return { ok: false, errors: [{ path: '/value', message: 'The list is [{ key, topic, fallback, capped }].' }] };
	if (input.length > MAX_TEMPLATE_SETTINGS)
		return { ok: false, errors: [{ path: '/value', message: `Add at most ${MAX_TEMPLATE_SETTINGS} template settings.` }] };
	/** @type {Errors} */
	const errors = [];
	/** @type {TemplateSettings[]} */
	const value = [];
	for (const [at, raw] of input.entries()) {
		const entry = record(raw);
		if (typeof entry.key !== 'string' || !TEMPLATE_KEY.test(entry.key)) {
			errors.push({ path: `/value/${at}/key`, message: 'Name the template key.' });
			continue;
		}
		if (value.some((other) => other.key === entry.key)) {
			errors.push({ path: `/value/${at}/key`, message: `The template ${entry.key} is listed twice.` });
			continue;
		}
		const topic = entry.topic ?? null;
		if (topic !== null && (typeof topic !== 'string' || !topicIds.includes(topic))) {
			errors.push({ path: `/value/${at}/topic`, message: 'Pick one of your topics, or none.' });
			continue;
		}
		/** @type {Channel[] | null} */
		let fallback = null;
		if (entry.fallback !== undefined && entry.fallback !== null) {
			const chain = checkChain(entry.fallback, `/value/${at}/fallback`, null);
			if (!chain.ok) {
				errors.push(chain.error);
				continue;
			}
			fallback = chain.value;
		}
		const capped = entry.capped ?? null;
		if (capped !== null && typeof capped !== 'boolean') {
			errors.push({ path: `/value/${at}/capped`, message: 'capped is true, false or null.' });
			continue;
		}
		if (topic !== null || fallback !== null || capped !== null) value.push({ key: entry.key, topic, fallback, capped });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Check the list `fallback_chains`: for each channel at most once, the channels its failed messages move to, in order.
 * @param {unknown} input
 * @returns {Checked<FallbackChain[]>}
 */
export const checkFallbackChains = (input) => {
	if (!Array.isArray(input) || input.length > FALLBACK_CHANNELS.length)
		return { ok: false, errors: [{ path: '/value', message: 'The list is [{ channel, then: [channels in order] }].' }] };
	/** @type {Errors} */
	const errors = [];
	/** @type {FallbackChain[]} */
	const value = [];
	for (const [at, raw] of input.entries()) {
		const entry = record(raw);
		const channel = entry.channel;
		if (!FALLBACK_CHANNELS.includes(/** @type {any} */ (channel)) || value.some((other) => other.channel === channel)) {
			errors.push({ path: `/value/${at}/channel`, message: `Pick each of ${FALLBACK_CHANNELS.join(', ')} at most once.` });
			continue;
		}
		const chain = checkChain(entry.then, `/value/${at}/then`, /** @type {string} */ (channel));
		if (!chain.ok) errors.push(chain.error);
		else if (chain.value.length > 0) value.push({ channel: /** @type {Channel} */ (channel), then: chain.value });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Check the list `quiet_hours`: at most 50 windows, each with its weekdays (0 = Sunday … 6 = Saturday, at least one),
 * `from` and `until` (`HH:MM`, local) and the channels it holds (none: every channel).
 * @param {unknown} input
 * @returns {Checked<QuietWindow[]>}
 */
export const checkQuietHours = (input) => {
	if (!Array.isArray(input))
		return { ok: false, errors: [{ path: '/value', message: 'The list is [{ days, from, until, channels }].' }] };
	if (input.length > MAX_QUIET_WINDOWS)
		return { ok: false, errors: [{ path: '/value', message: `Add at most ${MAX_QUIET_WINDOWS} quiet windows.` }] };
	/** @type {Errors} */
	const errors = [];
	/** @type {QuietWindow[]} */
	const value = [];
	for (const [at, raw] of input.entries()) {
		const entry = record(raw);
		const days = Array.isArray(entry.days) ? entry.days : [];
		if (
			days.length === 0 ||
			days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
			new Set(days).size !== days.length
		) {
			errors.push({ path: `/value/${at}/days`, message: 'Pick the weekdays, each once (0 = Sunday … 6 = Saturday).' });
			continue;
		}
		if (typeof entry.from !== 'string' || !TIME.test(entry.from)) {
			errors.push({ path: `/value/${at}/from`, message: 'Use a time such as 21:00.' });
			continue;
		}
		if (typeof entry.until !== 'string' || !TIME.test(entry.until)) {
			errors.push({ path: `/value/${at}/until`, message: 'Use a time such as 08:00.' });
			continue;
		}
		const channels = entry.channels === undefined ? [] : entry.channels;
		if (
			!Array.isArray(channels) ||
			channels.some((channel) => !CHANNELS.includes(channel)) ||
			new Set(channels).size !== channels.length
		) {
			errors.push({
				path: `/value/${at}/channels`,
				message: `Pick channels among ${CHANNELS.join(', ')} (none: every channel).`,
			});
			continue;
		}
		value.push({
			days: /** @type {number[]} */ ([...days]).sort((a, b) => a - b),
			from: entry.from,
			until: entry.until,
			channels: /** @type {Channel[]} */ (channels),
		});
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The fallback channels of a message, in order: its template's own (when the merchant set them), else the website's for
 * the channel it is sent on.
 * @param {{ channel: Channel, template: string | null }} message
 * @param {{ templates: ReadonlyArray<TemplateSettings>, chains: ReadonlyArray<FallbackChain> }} lists
 * @returns {Channel[]}
 */
export const fallbackChainOf = ({ channel, template }, { templates, chains }) => {
	const own = template === null ? null : (templates.find((entry) => entry.key === template)?.fallback ?? null);
	const chain = own ?? chains.find((entry) => entry.channel === channel)?.then ?? [];
	return chain.filter((next) => next !== channel);
};

/**
 * Check the list `stop_keywords` (fixed-choices N4): per language (a code such as en or pt-BR; empty: any language) its
 * unsubscribe keywords, each once (at most 20, 32 characters each).
 * @param {unknown} input
 * @returns {Checked<Array<{ language: string, words: string[] }>>}
 */
export const checkStopKeywords = (input) => {
	if (!Array.isArray(input) || input.length > MAX_KEYWORD_LANGUAGES)
		return {
			ok: false,
			errors: [{ path: '/value', message: `The list is [{ language, words }], at most ${MAX_KEYWORD_LANGUAGES} languages.` }],
		};
	/** @type {Errors} */
	const errors = [];
	/** @type {Array<{ language: string, words: string[] }>} */
	const value = [];
	for (const [at, raw] of input.entries()) {
		const entry = record(raw);
		const language = typeof entry.language === 'string' ? entry.language.trim() : '';
		if (!KEYWORD_LANGUAGE.test(language) || value.some((other) => other.language === language)) {
			errors.push({ path: `/value/${at}/language`, message: 'Use a language code such as en or pt-BR, each once.' });
			continue;
		}
		const words = Array.isArray(entry.words)
			? [...new Set(entry.words.filter((word) => typeof word === 'string').map((word) => word.trim()))].filter(Boolean)
			: [];
		if (words.length === 0 || words.length > MAX_KEYWORDS || words.some((word) => word.length > 32)) {
			errors.push({ path: `/value/${at}/words`, message: `Give 1–${MAX_KEYWORDS} keywords of at most 32 characters.` });
			continue;
		}
		value.push({ language, words });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};
