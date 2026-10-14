/**
 * The business profile of a website and the tags products recommend their features for: the setup advisor of the
 * website Setup sheet (owner request 2026-10-14; design `audit/design/website-blueprint.md` §5). Browser-safe: no
 * imports.
 *
 * - **Profile** (`BusinessProfile`, every answer optional, kept by the Portal per website): what the website sells, how
 *   shoppers pay, how orders reach them, how shoppers sign in, who answers the chat, how the merchant messages
 *   customers, marketing, what it offers shoppers (`PROFILE_CHOICES`, each answer a list of options; `none` stands
 *   alone), whether it is moving from another website or system (yes or no), and the countries (ISO 3166-1 alpha-2)
 *   and languages (ISO 639 codes) it serves.
 * - **Tags**: what a profile says, `<question>.<option>` (`pays.cod`, `moving.yes`, `countries.us`,
 *   `languages.fr`), `<question>.many` for two countries or languages or more, and `<question>.*` (a choice answered
 *   with anything but `none`).
 * - **Rules**: a manifest feature's `recommendFor` lists rules, each one to four tags joined by `+` (all must hold),
 *   for example `pays.online+countries.za`. A feature is **recommended** when one of its rules holds; it is **ruled
 *   out** when every rule fails on a question the profile answered (so a feature that is on is worth a second look);
 *   otherwise, or without rules, the profile says nothing about it. Tags are data: no product writes code per
 *   merchant.
 * @module
 */

/** Questions answered with a list of options, in the order people see them; `none` stands alone. */
export const PROFILE_CHOICES = Object.freeze({
	sells: Object.freeze(['physical', 'digital', 'services', 'subscriptions', 'none']),
	pays: Object.freeze(['online', 'link', 'cod', 'bank_transfer', 'pickup']),
	delivers: Object.freeze(['courier', 'zones', 'pickup', 'none']),
	signIn: Object.freeze(['email', 'phone', 'social', 'none']),
	chat: Object.freeze(['people', 'ai', 'none']),
	messages: Object.freeze(['email', 'sms', 'whatsapp', 'push', 'none']),
	marketing: Object.freeze(['google', 'meta', 'tiktok', 'analytics', 'seo', 'none']),
	offers: Object.freeze(['loyalty', 'discounts', 'reviews', 'member_prices', 'none']),
});

/** Questions answered yes or no (tags `<question>.yes` and `<question>.no`). */
export const PROFILE_YES_NO = Object.freeze(/** @type {const} */ (['moving']));

/** Questions answered with a list of codes, and the most codes each takes. */
export const PROFILE_LISTS = Object.freeze({ countries: 250, languages: 20 });

/** The option that stands alone in a choice. */
export const PROFILE_NONE = 'none';

/** Every question of the profile, in the order people see them. */
export const PROFILE_QUESTIONS = Object.freeze([
	...Object.keys(PROFILE_CHOICES),
	...PROFILE_YES_NO,
	...Object.keys(PROFILE_LISTS),
]);

/** Codes of the list questions as a profile keeps them; a tag writes them in small letters. */
export const PROFILE_CODES = Object.freeze({ countries: '^[A-Z]{2}$', languages: '^[a-z]{2,3}$' });
const TAG_CODES = Object.freeze({ countries: /^[a-z]{2}$/, languages: /^[a-z]{2,3}$/ });

/** Most tags in one rule. */
export const RULE_MAX_TAGS = 4;

/**
 * A website's business profile; a question left out is not answered.
 * @typedef {{ sells?: string[], pays?: string[], delivers?: string[], signIn?: string[], chat?: string[],
 *   messages?: string[], marketing?: string[], offers?: string[], moving?: boolean, countries?: string[],
 *   languages?: string[] }} BusinessProfile
 */
/**
 * What a profile says about one feature.
 * @typedef {{ fit: 'recommended', because: string[] } | { fit: 'ruled_out', missing: string[] } | { fit: 'neutral' }} FeatureFit
 */

/** @param {string} question @returns {question is keyof typeof PROFILE_CHOICES} */
const isChoice = (question) => Object.hasOwn(PROFILE_CHOICES, question);
/** @param {string} question @returns {question is keyof typeof PROFILE_LISTS} */
const isList = (question) => Object.hasOwn(PROFILE_LISTS, question);
/** @param {string} question */
const isYesNo = (question) => /** @type {readonly string[]} */ (PROFILE_YES_NO).includes(question);

/**
 * The question a tag is about.
 * @param {string} tag
 * @returns {string}
 */
const questionOf = (tag) => tag.slice(0, Math.max(0, tag.indexOf('.')));

/**
 * Whether a tag names an answer the profile can give: `<choice>.<option>`, `<choice>.*`, `moving.yes|no`,
 * `countries.<code>` (two lower-case letters), `languages.<code>` (two or three) and `<list>.many`.
 * @param {unknown} tag
 * @returns {tag is string}
 */
export const isRecommendTag = (tag) => {
	if (typeof tag !== 'string') return false;
	const [question = '', option = '', ...rest] = tag.split('.');
	if (rest.length > 0) return false;
	if (isChoice(question)) return option === '*' || PROFILE_CHOICES[question].includes(option);
	if (isYesNo(question)) return option === 'yes' || option === 'no';
	if (isList(question)) return option === 'many' || TAG_CODES[question].test(option);
	return false;
};

/**
 * Why a rule cannot be used (null when it can): unknown tags, more than {@link RULE_MAX_TAGS}, a tag twice.
 * @param {unknown} rule
 * @returns {string | null}
 */
export const ruleProblem = (rule) => {
	if (typeof rule !== 'string' || rule.length === 0) return 'must be one or more tags joined by +';
	const tags = rule.split('+');
	const unknown = tags.find((tag) => !isRecommendTag(tag));
	if (unknown !== undefined) return `'${unknown}' is not a business profile tag`;
	if (tags.length > RULE_MAX_TAGS) return `joins at most ${RULE_MAX_TAGS} tags`;
	if (new Set(tags).size !== tags.length) return 'names a tag twice';
	return null;
};

/**
 * The tags a profile answers.
 * @param {BusinessProfile} profile
 * @returns {Set<string>}
 */
export const profileTags = (profile) => {
	/** @type {Set<string>} */
	const tags = new Set();
	for (const question of Object.keys(PROFILE_CHOICES))
		for (const option of profile[/** @type {keyof typeof PROFILE_CHOICES} */ (question)] ?? [])
			tags.add(`${question}.${option}`);
	for (const question of PROFILE_YES_NO) {
		const answer = profile[question];
		if (typeof answer === 'boolean') tags.add(`${question}.${answer ? 'yes' : 'no'}`);
	}
	for (const question of /** @type {Array<keyof typeof PROFILE_LISTS>} */ (Object.keys(PROFILE_LISTS))) {
		const codes = profile[question] ?? [];
		for (const code of codes) tags.add(`${question}.${code.toLowerCase()}`);
		if (codes.length > 1) tags.add(`${question}.many`);
	}
	return tags;
};

/**
 * The questions a profile answers: a choice or list with at least one entry, a yes or no.
 * @param {BusinessProfile} profile
 * @returns {Set<string>}
 */
export const answeredQuestions = (profile) =>
	new Set(
		PROFILE_QUESTIONS.filter((question) => {
			const answer = profile[/** @type {keyof BusinessProfile} */ (question)];
			return Array.isArray(answer) ? answer.length > 0 : typeof answer === 'boolean';
		}),
	);

/**
 * Whether the profile's tags hold one tag; `<choice>.*` holds for any option but `none`.
 * @param {string} tag
 * @param {ReadonlySet<string>} tags
 */
const holds = (tag, tags) => {
	if (!tag.endsWith('.*')) return tags.has(tag);
	const question = questionOf(tag);
	return [...tags].some((given) => questionOf(given) === question && given !== `${question}.${PROFILE_NONE}`);
};

/**
 * Whether a rule holds for a profile's tags (every one of its tags).
 * @param {string} rule
 * @param {ReadonlySet<string>} tags from {@link profileTags}
 * @returns {boolean}
 */
export const ruleHolds = (rule, tags) => rule.split('+').every((tag) => holds(tag, tags));

/**
 * What a profile says about a feature with these rules: recommended (with the tags of the first rule that holds),
 * ruled out (every rule fails on a question the profile answered; `missing` names one such tag per rule, each once), or
 * neutral (no rules, or a rule could still hold once an open question is answered).
 * @param {ReadonlyArray<string>} rules the feature's `recommendFor`
 * @param {BusinessProfile} profile
 * @returns {FeatureFit}
 */
export const featureFit = (rules, profile) => {
	if (rules.length === 0) return { fit: 'neutral' };
	const tags = profileTags(profile);
	const held = rules.find((rule) => ruleHolds(rule, tags));
	if (held !== undefined) return { fit: 'recommended', because: held.split('+') };
	const answered = answeredQuestions(profile);
	/** @type {string[]} */
	const missing = [];
	for (const rule of rules) {
		const failed = rule.split('+').find((tag) => answered.has(questionOf(tag)) && !holds(tag, tags));
		if (failed === undefined) return { fit: 'neutral' };
		if (!missing.includes(failed)) missing.push(failed);
	}
	return { fit: 'ruled_out', missing };
};

/**
 * The advice for a product's features: `recommended` (each with whether it is on and the tags it is recommended for)
 * and `notRecommended` (features that are on although the profile rules them out, with a tag it lacks per rule).
 * @param {ReadonlyArray<{ key: string, on: boolean, recommendFor: ReadonlyArray<string> }>} features
 * @param {BusinessProfile} profile
 * @returns {{ recommended: Array<{ feature: string, on: boolean, because: string[] }>,
 *   notRecommended: Array<{ feature: string, missing: string[] }> }}
 */
export const adviseFeatures = (features, profile) => {
	/** @type {Array<{ feature: string, on: boolean, because: string[] }>} */
	const recommended = [];
	/** @type {Array<{ feature: string, missing: string[] }>} */
	const notRecommended = [];
	for (const feature of features) {
		const fit = featureFit(feature.recommendFor, profile);
		if (fit.fit === 'recommended') recommended.push({ feature: feature.key, on: feature.on, because: fit.because });
		else if (fit.fit === 'ruled_out' && feature.on) notRecommended.push({ feature: feature.key, missing: fit.missing });
	}
	return { recommended, notRecommended };
};

/**
 * Why a profile that has the schema's shape (`validateBusinessProfile`) cannot be kept, as `{ path, message }`
 * problems (empty when it can): `none` given with other options.
 * @param {BusinessProfile} profile
 * @returns {Array<{ path: string, message: string }>}
 */
export const profileProblems = (profile) =>
	Object.keys(PROFILE_CHOICES)
		.filter((question) => {
			const answer = profile[/** @type {keyof typeof PROFILE_CHOICES} */ (question)] ?? [];
			return answer.includes(PROFILE_NONE) && answer.length > 1;
		})
		.map((question) => ({ path: `/${question}`, message: `${PROFILE_NONE} stands alone` }));
