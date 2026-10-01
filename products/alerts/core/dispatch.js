/**
 * Dispatch rules (pure): when a message may go out (batching window, quiet hours in the website's time zone),
 * frequency-cap periods, retry backoff, which failures are worth retrying, and what the message says (templates per
 * type, channel and language with `{placeholder}`s, merchant overrides first, then the string catalog).
 * @module
 */
import { HOUR_MS, MINUTE_MS, dayKey, nextDayStart, nextWeekStart, quietHours, weekKey } from './time.js';

/**
 * @typedef {object} DispatchSettings
 * @property {string} timeZone
 * @property {boolean} quietHoursEnabled
 * @property {string} quietStart `HH:MM`
 * @property {string} quietEnd `HH:MM`
 * @property {number} batchWindowMinutes 0 = no batching
 * @property {number} maxPerDay 0 = unlimited
 * @property {number} maxPerWeek 0 = unlimited
 * @property {'defer' | 'drop'} capAction
 * @property {number} maxAttempts
 * @property {number} retryBaseMinutes
 */

/**
 * Earliest send time of a new message.
 * @param {number} now
 * @param {DispatchSettings} settings
 */
export const plannedAt = (now, settings) => {
	const ready = now + Math.max(0, settings.batchWindowMinutes) * MINUTE_MS;
	return deferForQuiet(ready, settings);
};

/**
 * Move an instant out of the quiet hours (unchanged outside them or when they are off).
 * @param {number} at
 * @param {DispatchSettings} settings
 */
export const deferForQuiet = (at, settings) => {
	if (!settings.quietHoursEnabled) return at;
	const quiet = quietHours(at, { start: settings.quietStart, end: settings.quietEnd, timeZone: settings.timeZone });
	return quiet.quiet ? quiet.endsAt : at;
};

/**
 * Frequency-cap counters a send to a contact must pass (per local day and ISO week).
 * @param {string} contactKey
 * @param {number} now
 * @param {DispatchSettings} settings
 * @returns {Array<{ key: string, limit: number, resetsAt: number }>}
 */
export const capCounters = (contactKey, now, settings) => [
	...(settings.maxPerDay > 0
		? [
				{
					key: `cap:${contactKey}:d:${dayKey(now, settings.timeZone)}`,
					limit: settings.maxPerDay,
					resetsAt: nextDayStart(now, settings.timeZone),
				},
			]
		: []),
	...(settings.maxPerWeek > 0
		? [
				{
					key: `cap:${contactKey}:w:${weekKey(now, settings.timeZone)}`,
					limit: settings.maxPerWeek,
					resetsAt: nextWeekStart(now, settings.timeZone),
				},
			]
		: []),
];

/**
 * Exponential backoff with an upper bound of one day: base × 2^(attempt − 1).
 * @param {number} attempt 1-based attempt that just failed
 * @param {number} baseMinutes
 */
export const backoffMs = (attempt, baseMinutes) =>
	Math.min(24 * HOUR_MS, Math.max(1, baseMinutes) * MINUTE_MS * 2 ** Math.max(0, Math.min(20, attempt - 1)));

/** Failure codes that never succeed on retry: configuration errors, a refused message, an unsupported channel. */
const NOT_RETRYABLE = new Set([
	'not_implemented',
	'resource_invalid',
	'invalid_argument',
	'provider_refused',
	'channel_unsupported',
]);

/**
 * Whether a provider failure is worth retrying: network trouble, timeouts, 408/425/429 and 5xx are; other 4xx answers
 * (bad address, refused content), permanent SMTP refusals (5xx reply → `provider_refused` without HTTP status) and
 * configuration errors are not.
 * @param {{ code?: string, status?: number }} failure
 */
export const isRetryable = ({ code, status }) => {
	if (typeof status === 'number' && status > 0) return status === 408 || status === 425 || status === 429 || status >= 500;
	return !NOT_RETRYABLE.has(code ?? '');
};

/**
 * Next step after a failed attempt.
 * @param {{ attempts: number, failure: { code?: string, status?: number }, now: number }} input
 * @param {DispatchSettings} settings
 * @returns {{ action: 'retry', at: number } | { action: 'fail' }}
 */
export const afterFailure = ({ attempts, failure, now }, settings) =>
	isRetryable(failure) && attempts < settings.maxAttempts
		? { action: 'retry', at: deferForQuiet(now + backoffMs(attempts, settings.retryBaseMinutes), settings) }
		: { action: 'fail' };

/**
 * Fill `{name}` placeholders with text values (unknown placeholders stay visible).
 * @param {string} template
 * @param {Readonly<Record<string, string | number>>} values
 */
export const fill = (template, values) =>
	template.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match));

/**
 * @typedef {object} TemplateOverride merchant template (feature `dispatch.templates`)
 * @property {string} type alert type, `custom:<key>`, `digest`, `confirm` or `*`
 * @property {string} channel channel or `*`
 * @property {string} lang language tag or `*`
 * @property {string} [subject]
 * @property {string} body
 */

/**
 * Language fallbacks: `pt-BR` → `pt-BR`, `pt`, default, `en`.
 * @param {string} lang
 * @param {string} defaultLang
 * @returns {string[]}
 */
export const languageChain = (lang, defaultLang) => {
	const chain = [lang, lang.split('-')[0] ?? lang, defaultLang, defaultLang.split('-')[0] ?? defaultLang, 'en'];
	return [...new Set(chain.filter((value) => typeof value === 'string' && value.length > 0))];
};

/**
 * Template text of a part (`subject` / `body` / `line`): a matching merchant override (most specific first), else
 * the catalog keys `template.<type>.<channel>.<part>`, `template.<type>.<part>` in the language chain.
 * @param {{ type: string, channel: string, lang: string, part: 'subject' | 'body' | 'line' }} key
 * @param {{ overrides: readonly TemplateOverride[], catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>, defaultLang: string }} sources
 * @returns {string | null}
 */
export const templateFor = ({ type, channel, lang, part }, { overrides, catalogs, defaultLang }) => {
	const family = type.startsWith('custom:') ? 'custom' : type;
	const langs = languageChain(lang, defaultLang);
	if (part !== 'line') {
		for (const wantLang of [...langs, '*'])
			for (const wantChannel of [channel, '*'])
				for (const wantType of [type, family, '*']) {
					const hit = overrides.find((o) => o.type === wantType && o.channel === wantChannel && o.lang === wantLang);
					const text = hit ? hit[part] : undefined;
					if (typeof text === 'string' && text.length > 0) return text;
				}
	}
	for (const wantLang of langs) {
		const catalog = catalogs[wantLang];
		if (!catalog) continue;
		for (const key of [`template.${family}.${channel}.${part}`, `template.${family}.${part}`]) {
			const text = catalog[key];
			if (typeof text === 'string' && text.length > 0) return text;
		}
	}
	return null;
};

/** Minor-unit exponent of a currency (Intl; 2 when unknown). @param {string} currency */
const digitsOf = (currency) => {
	try {
		return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		return 2;
	}
};

/**
 * Money in minor units formatted for a language (`{ amount: 129900, currency: 'PKR' }` → `Rs 1,299.00`).
 * @param {{ amount: number, currency: string } | null | undefined} money
 * @param {string} lang
 * @returns {string}
 */
export const formatMoney = (money, lang) => {
	if (!money) return '';
	const digits = digitsOf(money.currency);
	const value = money.amount / 10 ** digits;
	try {
		return new Intl.NumberFormat(lang, { style: 'currency', currency: money.currency }).format(value);
	} catch {
		return `${value.toFixed(digits)} ${money.currency}`;
	}
};

/**
 * Tidy rendered text: trailing spaces removed, runs of blank lines (left by empty optional lines) collapsed to one.
 * @param {string} text
 */
export const tidy = (text) =>
	text
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/, '').replace(/ {2,}/g, ' '))
		.filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
		.join('\n')
		.trim();

/**
 * @typedef {object} MessageItem one alert inside a message
 * @property {string} subscriptionId
 * @property {number} cycle
 * @property {string} type
 * @property {Record<string, string | number>} vars placeholder values of this alert
 */

/**
 * Render a message: one alert uses its type template; several (batching) use the digest template with one `line`
 * per alert. Returns null when no template exists for the type and channel.
 * @param {{ kind: 'alert' | 'confirm', items: readonly MessageItem[], channel: string, lang: string,
 *   common: Record<string, string | number> }} message
 * @param {{ overrides: readonly TemplateOverride[], catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>, defaultLang: string }} sources
 * @returns {{ subject: string | null, text: string } | null}
 */
export const renderMessage = ({ kind, items, channel, lang, common }, sources) => {
	const part = (/** @type {string} */ type, /** @type {'subject' | 'body' | 'line'} */ name) =>
		templateFor({ type, channel, lang, part: name }, sources);
	if (kind === 'confirm' || items.length === 1) {
		const item = items[0];
		const type = kind === 'confirm' ? 'confirm' : (item?.type ?? '');
		const body = part(type, 'body');
		if (!body) return null;
		const values = { ...common, ...(item?.vars ?? {}) };
		const subject = channel === 'email' ? part(type, 'subject') : null;
		return { subject: subject ? fill(subject, values) : null, text: tidy(fill(body, values)) };
	}
	const body = part('digest', 'body');
	const line = part('digest', 'line');
	if (!body || !line) return null;
	const lines = items.map((item) => fill(line, { ...common, ...item.vars })).join('\n');
	const values = { ...common, count: items.length, lines };
	const subject = channel === 'email' ? part('digest', 'subject') : null;
	return { subject: subject ? fill(subject, values) : null, text: tidy(fill(body, values)) };
};

/**
 * A catalog text in the language chain, filled with values ('' when the key is missing everywhere).
 * @param {string} key
 * @param {Readonly<Record<string, string | number>>} values
 * @param {{ catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>, lang: string, defaultLang: string }} sources
 */
export const catalogText = (key, values, { catalogs, lang, defaultLang }) => {
	for (const wantLang of languageChain(lang, defaultLang)) {
		const text = catalogs[wantLang]?.[key];
		if (typeof text === 'string') return fill(text, values);
	}
	return '';
};

/**
 * Placeholder values of one alert (computed when it is queued, in the subscription's language).
 * @param {{ type: string, typeName: string, itemName: string, url: string, price?: { amount: number, currency: string } | null,
 *   oldPrice?: { amount: number, currency: string } | null, dropPercent: number, quantity?: number | null }} alert
 * @param {{ catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>, lang: string, defaultLang: string }} sources
 * @returns {Record<string, string | number>}
 */
export const alertVars = (alert, sources) => {
	const price = formatMoney(alert.price, sources.lang);
	/** @type {Record<string, string | number>} */
	const values = {
		item: alert.itemName,
		url: alert.url,
		price,
		old_price: formatMoney(alert.oldPrice, sources.lang),
		drop_percent: alert.dropPercent,
		quantity: typeof alert.quantity === 'number' ? alert.quantity : '',
		type_name: alert.typeName,
	};
	values.price_line = price ? catalogText('template.line.price', values, sources) : '';
	values.link_line = alert.url ? catalogText('template.line.link', values, sources) : '';
	const family = alert.type.startsWith('custom:') ? 'custom' : alert.type;
	values.status_text = catalogText(`template.status.${family}`, values, sources);
	return values;
};
