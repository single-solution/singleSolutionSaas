/**
 * The setup advisor of the website Setup sheet (PLAN.md, website setup sheet and setup advisor), pure: the business profile a request saves, and the advice for a reachable product from its features'
 * `recommendFor` rules (`@ss/contracts` `adviseFeatures`), worded with `texts/console.js` `PROFILE`.
 * @module
 */
import { PROFILE_CHOICES, adviseFeatures, validateBusinessProfile } from '@ss/contracts';
import { PROFILE_OTHER, PROFILE_YES_NO } from '@ss/contracts/profile';
import { PROFILE } from '../../../texts/console.js';

/** @typedef {import('@ss/contracts').BusinessProfile} BusinessProfile */
/** @typedef {import('@ss/contracts').BlueprintAdvice} BlueprintAdvice */

/**
 * A profile as kept: only answered questions, the options of a choice in the order people see them, own answers
 * trimmed in the order given.
 * @param {BusinessProfile} profile
 * @returns {BusinessProfile}
 */
const tidy = (profile) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [question, options] of Object.entries(PROFILE_CHOICES)) {
		const given = profile[/** @type {keyof typeof PROFILE_CHOICES} */ (question)] ?? [];
		if (given.length > 0) out[question] = options.filter((option) => given.includes(option));
	}
	/** @type {Record<string, string[]>} */
	const other = {};
	for (const question of PROFILE_OTHER) {
		const own = (profile.other?.[question] ?? []).map((text) => text.trim().replace(/\s+/g, ' '));
		if (own.length > 0) other[question] = own;
	}
	if (Object.keys(other).length > 0) out.other = other;
	for (const question of PROFILE_YES_NO)
		if (typeof profile[question] === 'boolean') out[question] = profile[question];
	for (const question of /** @type {const} */ (['countries', 'languages']))
		if ((profile[question] ?? []).length > 0) out[question] = [...(profile[question] ?? [])];
	return /** @type {BusinessProfile} */ (out);
};

/**
 * The body of Save profile: a business profile (`@ss/contracts` `validateBusinessProfile`), kept tidy; null when it
 * answers nothing (the profile is then removed).
 * @param {unknown} body
 * @returns {{ ok: true, value: BusinessProfile | null } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const parseProfile = (body) => {
	const checked = validateBusinessProfile(body);
	if (!checked.ok) return { ok: false, errors: checked.problems.map(({ path, message }) => ({ path, message })) };
	const value = tidy(checked.value);
	return { ok: true, value: Object.keys(value).length === 0 ? null : value };
};

/**
 * What the advisor says about one product's features for a profile: the features it recommends (on or not) and the
 * features that are on although the profile rules them out, each with why in words. Nothing without a profile.
 * @param {ReadonlyArray<{ key: string, on: boolean, recommendFor: ReadonlyArray<string> }>} features
 * @param {BusinessProfile | null} profile
 * @returns {BlueprintAdvice}
 */
export const adviceOf = (features, profile) => {
	if (profile === null) return { recommended: [], notRecommended: [] };
	const { recommended, notRecommended } = adviseFeatures(features, profile);
	return {
		recommended: recommended.map((entry) => ({ ...entry, why: PROFILE.why(entry.because) })),
		notRecommended: notRecommended.map((entry) => ({ ...entry, why: PROFILE.whyNot(entry.missing) })),
	};
};
