/**
 * The business profile of a website (the setup advisor of the Setup sheet; vocabulary in `../profile.js`) and the
 * shape of a feature's recommendation rules (`recommendFor` in the manifest and in a product's Setup part).
 * @module
 */
import {
	OTHER_MAX,
	PROFILE_CHOICES,
	PROFILE_CODES,
	PROFILE_LISTS,
	PROFILE_OTHER,
	PROFILE_YES_NO,
	RULE_MAX_TAGS,
} from '../profile.js';
import { deepFreeze } from '../util.js';
import { SCHEMA_IDS } from './schema-ids.js';

/** One tag as written in a rule (`validateManifest` then checks it names a profile answer). */
export const RECOMMEND_TAG_PATTERN = '[a-z][A-Za-z]{0,30}\\.(?:[a-z0-9_]{1,30}|\\*)';

/** A feature's rules: each one to four tags joined by `+`. */
export const recommendForSchema = deepFreeze({
	type: 'array',
	maxItems: 20,
	uniqueItems: true,
	items: {
		type: 'string',
		maxLength: 200,
		pattern: `^${RECOMMEND_TAG_PATTERN}(?:\\+${RECOMMEND_TAG_PATTERN}){0,${RULE_MAX_TAGS - 1}}$`,
	},
});

/**
 * A website's business profile: every answer optional; `other` holds the merchant's own answers to the choices of
 * `PROFILE_OTHER`; `profileProblems` adds that `none` stands alone and each own answer is given once.
 */
export const businessProfileSchema = deepFreeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: SCHEMA_IDS.businessProfile,
	title: 'Business profile',
	type: 'object',
	additionalProperties: false,
	properties: {
		...Object.fromEntries(
			Object.entries(PROFILE_CHOICES).map(([question, options]) => [
				question,
				{ type: 'array', maxItems: options.length, uniqueItems: true, items: { type: 'string', enum: [...options] } },
			]),
		),
		other: {
			type: 'object',
			additionalProperties: false,
			properties: Object.fromEntries(
				PROFILE_OTHER.map((question) => [
					question,
					{
						type: 'array',
						maxItems: OTHER_MAX.answers,
						items: { type: 'string', minLength: 1, maxLength: OTHER_MAX.length },
					},
				]),
			),
		},
		...Object.fromEntries(PROFILE_YES_NO.map((question) => [question, { type: 'boolean' }])),
		...Object.fromEntries(
			Object.entries(PROFILE_LISTS).map(([question, most]) => [
				question,
				{
					type: 'array',
					maxItems: most,
					uniqueItems: true,
					items: { type: 'string', pattern: PROFILE_CODES[/** @type {keyof typeof PROFILE_CODES} */ (question)] },
				},
			]),
		),
	},
});
