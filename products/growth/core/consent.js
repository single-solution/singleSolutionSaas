/**
 * The visitor's consent (PLAN 0.8.9): categories necessary (always), analytics and marketing, kept in the visitor's
 * own browser, and the Google Consent Mode v2 signals that follow from it. Tags load only after consent to their
 * category: Google Analytics and analytics scripts need analytics; the Meta and TikTok pixels, Google Ads and
 * marketing scripts need marketing; the Tag Manager container loads after either, with Consent Mode telling its tags
 * what was granted.
 * @module
 */
import { CONSENT_DAYS } from './widgets.js';

/** @typedef {{ analytics: boolean, marketing: boolean, at: string }} Choice */

const DAY_MS = 86_400_000;

/**
 * A choice kept in the browser, or null when there is none, it cannot be read or it is older than {@link CONSENT_DAYS}.
 * @param {string | null} stored
 * @param {number} now
 * @returns {Choice | null}
 */
export const readChoice = (stored, now) => {
	if (!stored) return null;
	try {
		const value = JSON.parse(stored);
		const at = Date.parse(value?.at);
		if (typeof value?.analytics !== 'boolean' || typeof value?.marketing !== 'boolean' || Number.isNaN(at)) return null;
		if (now - at > CONSENT_DAYS * DAY_MS || at - now > DAY_MS) return null;
		return { analytics: value.analytics, marketing: value.marketing, at: value.at };
	} catch {
		return null;
	}
};

/**
 * A new choice, as kept in the browser.
 * @param {{ analytics: boolean, marketing: boolean }} picked
 * @param {number} now
 * @returns {Choice}
 */
export const makeChoice = (picked, now) => ({
	analytics: picked.analytics === true,
	marketing: picked.marketing === true,
	at: new Date(now).toISOString(),
});

/**
 * Google Consent Mode v2 signals for a choice (null: nothing chosen yet, everything denied).
 * @param {{ analytics: boolean, marketing: boolean } | null} choice
 */
export const consentMode = (choice) => {
	/** @param {boolean | undefined} yes */
	const state = (yes) => (yes ? 'granted' : 'denied');
	return {
		ad_storage: state(choice?.marketing),
		ad_user_data: state(choice?.marketing),
		ad_personalization: state(choice?.marketing),
		analytics_storage: state(choice?.analytics),
	};
};

/**
 * Whether a category is granted (`necessary` always is).
 * @param {{ analytics: boolean, marketing: boolean } | null} choice
 * @param {'necessary' | 'analytics' | 'marketing'} category
 */
export const granted = (choice, category) => category === 'necessary' || choice?.[category] === true;
