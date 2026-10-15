/**
 * The visitor's consent (PLAN 0.8.9, G3): the merchant's consent categories (the `consent_categories` list: seeded
 * necessary, preferences, analytics, marketing and sale or sharing of personal data), the visitor's choice kept in
 * their own browser, and the Google Consent Mode v2 signals that follow from it. A category is `required` (always on),
 * `opt_in` (off until the visitor agrees) or `opt_out` (on until the visitor refuses, also off for a browser that sends
 * Global Privacy Control); it grants its signals, and a signal is granted when every category that lists it is. Tags
 * load once their signals are: Google Analytics needs analytics_storage; the Meta and TikTok pixels and Google Ads need
 * ad_storage and ad_user_data; the Tag Manager container loads once a category beyond the required ones is granted
 * (Consent Mode tells its tags the rest); a category's own scripts load once it is granted.
 * @module
 */
import { CONSENT_MONTHS, CONSENT_SIGNALS, MAX_CONSENT_MONTHS } from './widgets.js';

/**
 * A consent category as the page script gets it.
 * @typedef {{ key: string, name: string, description: string, mode: 'required' | 'opt_in' | 'opt_out',
 *   signals: string[] }} Category
 */
/** The visitor's choice: each category on or off, and when it was made. @typedef {{ categories: Record<string, boolean>, at: string }} Choice */
/** Each category on or off now. @typedef {Record<string, boolean>} Granted */

/** The signals each tag needs (G3). */
export const TAG_SIGNALS = Object.freeze({
	ga4: Object.freeze(['analytics_storage']),
	ads: Object.freeze(['ad_storage', 'ad_user_data']),
	meta: Object.freeze(['ad_storage', 'ad_user_data']),
	tiktok: Object.freeze(['ad_storage', 'ad_user_data']),
});

/** The signal anonymous analytics wait for while they count only after consent. */
export const ANALYTICS_SIGNALS = Object.freeze(['analytics_storage']);

const DAY_MS = 86_400_000;

/**
 * The months a choice holds (G6): the merchant's setting when it is a whole number from 1 to
 * {@link MAX_CONSENT_MONTHS}, else {@link CONSENT_MONTHS}.
 * @param {unknown} value the consent banner's `askAgainMonths` setting
 */
export const consentMonthsOf = (value) =>
	typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_CONSENT_MONTHS ? value : CONSENT_MONTHS;

/**
 * The time a number of calendar months after another (UTC; the 31st plus a month is the last day of a shorter month).
 * @param {number} at
 * @param {number} months
 */
const monthsAfter = (at, months) => {
	const date = new Date(at);
	const day = date.getUTCDate();
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() + months);
	const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
	date.setUTCDate(Math.min(day, last));
	return date.getTime();
};

/**
 * A choice kept in the browser, or null when there is none, it cannot be read, it is `months` calendar months old (G6)
 * or it says nothing about a category the merchant asks about now (one added since), so the visitor is asked again.
 * @param {string | null} stored
 * @param {number} now
 * @param {number} months
 * @param {ReadonlyArray<Category>} categories
 * @returns {Choice | null}
 */
export const readChoice = (stored, now, months, categories) => {
	if (!stored) return null;
	try {
		const value = JSON.parse(stored);
		const at = Date.parse(value?.at);
		const kept = value?.categories;
		if (typeof kept !== 'object' || kept === null || Number.isNaN(at)) return null;
		if (now >= monthsAfter(at, consentMonthsOf(months)) || at - now > DAY_MS) return null;
		/** @type {Record<string, boolean>} */
		const picked = {};
		for (const category of categories) {
			if (category.mode === 'required') picked[category.key] = true;
			else if (typeof kept[category.key] === 'boolean') picked[category.key] = kept[category.key];
			else return null;
		}
		return { categories: picked, at: value.at };
	} catch {
		return null;
	}
};

/**
 * A new choice, as kept in the browser: a required category on; an opt-in one on only when picked; an opt-out one on
 * unless picked off.
 * @param {Record<string, unknown>} picked each category's key, true or false
 * @param {number} now
 * @param {ReadonlyArray<Category>} categories
 * @returns {Choice}
 */
export const makeChoice = (picked, now, categories) => ({
	categories: Object.fromEntries(
		categories.map((category) => [
			category.key,
			category.mode === 'required'
				? true
				: category.mode === 'opt_out'
					? picked?.[category.key] !== false
					: picked?.[category.key] === true,
		]),
	),
	at: new Date(now).toISOString(),
});

/**
 * Each category on or off now: the visitor's choice; without one, while tags wait for consent (`consentRequired`), the
 * required and opt-out categories, else every category; an opt-out category is off for a browser that sends Global
 * Privacy Control (`gpc`) until the visitor turns it on.
 * @param {Choice | null} choice
 * @param {ReadonlyArray<Category>} categories
 * @param {{ consentRequired?: boolean, gpc?: boolean }} [options]
 * @returns {Granted}
 */
export const grantedOf = (choice, categories, { consentRequired = true, gpc = false } = {}) =>
	Object.fromEntries(
		categories.map((category) => [
			category.key,
			category.mode === 'required'
				? true
				: choice
					? choice.categories[category.key] === true
					: category.mode === 'opt_out'
						? !gpc
						: !consentRequired,
		]),
	);

/**
 * Google Consent Mode v2 signals of what is granted: a signal is granted when some category lists it and every
 * category that lists it is on.
 * @param {Granted} granted
 * @param {ReadonlyArray<Category>} categories
 * @returns {Record<string, 'granted' | 'denied'>}
 */
export const consentMode = (granted, categories) =>
	Object.fromEntries(
		CONSENT_SIGNALS.map((signal) => {
			const listing = categories.filter((category) => category.signals.includes(signal));
			return [
				signal,
				listing.length > 0 && listing.every((category) => granted[category.key] === true) ? 'granted' : 'denied',
			];
		}),
	);

/**
 * Whether every signal named is granted.
 * @param {Granted} granted
 * @param {ReadonlyArray<Category>} categories
 * @param {ReadonlyArray<string>} signals
 */
export const allows = (granted, categories, signals) => {
	const mode = consentMode(granted, categories);
	return signals.every((signal) => mode[signal] === 'granted');
};

/**
 * Whether the Tag Manager container may load: an opt-in category is on, or the visitor chose and left a category beyond
 * the required ones on (an opt-out category alone, before any choice, does not load it).
 * @param {Granted} granted
 * @param {ReadonlyArray<Category>} categories
 * @param {boolean} chosen the visitor made a choice
 */
export const anyChosen = (granted, categories, chosen) =>
	categories.some(
		(category) => granted[category.key] === true && (category.mode === 'opt_in' || (chosen && category.mode === 'opt_out')),
	);
