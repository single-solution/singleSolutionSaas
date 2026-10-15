import { describe, expect, it } from 'vitest';
import { PROFILE_CHOICES, adviseFeatures, validateBusinessProfile, validateManifest } from '../src/index.js';
import {
	PROFILE_QUESTIONS,
	answeredQuestions,
	featureFit,
	isRecommendTag,
	profileTags,
	ruleHolds,
	ruleProblem,
} from '../src/profile.js';
import { RULES } from '../src/semantics.js';
import * as browser from '../src/profile.js';
import { manifest } from '../src/testing.js';
import { expectProblem } from './helpers.js';

describe('business profile vocabulary', () => {
	it('asks every question once, choices first, and is the same in the browser entry', () => {
		expect(PROFILE_QUESTIONS).toEqual([
			'sells',
			'pays',
			'delivers',
			'signIn',
			'chat',
			'messages',
			'marketing',
			'offers',
			'moving',
			'taxes',
			'countries',
			'languages',
		]);
		expect(browser.PROFILE_CHOICES).toBe(PROFILE_CHOICES);
		for (const options of Object.values(PROFILE_CHOICES)) expect(new Set(options).size).toBe(options.length);
	});

	it.each([
		['pays.cod', true],
		['sells.*', true],
		['moving.yes', true],
		['moving.no', true],
		['countries.us', true],
		['countries.many', true],
		['languages.fr', true],
		['languages.many', true],
		['offers.none', true],
		['offers.coupons', true],
		['delivers.courier_api', true],
		['taxes.yes', true],
		['pays.other', true],
		['offers.other', true],
		['chat.other', false],
		['countries.eea', true],
		['languages.eea', true],
		['countries.europe', false],
		['pays.barter', false],
		['moving.maybe', false],
		['moving.*', false],
		['countries.US', false],
		['countries.usa', false],
		['countries.*', false],
		['shop.cod', false],
		['pays', false],
		['pays.cod.extra', false],
		[7, false],
	])('tag %s is %s', (tag, known) => {
		expect(isRecommendTag(tag)).toBe(known);
	});

	it('explains a rule it cannot use', () => {
		expect(ruleProblem('pays.online+countries.za')).toBeNull();
		expect(ruleProblem('pays.online+pays.online')).toBe('names a tag twice');
		expect(ruleProblem('pays.online+sells.physical+chat.ai+messages.sms+marketing.seo')).toBe('joins at most 4 tags');
		expect(ruleProblem('pays.gold')).toBe("'pays.gold' is not a business profile tag");
		expect(ruleProblem('')).toBe('must be one or more tags joined by +');
	});
});

describe('profile tags and rules', () => {
	const profile = {
		sells: ['physical', 'digital'],
		pays: ['online', 'cod'],
		chat: ['none'],
		moving: false,
		countries: ['US', 'CA'],
		languages: ['en'],
	};

	it('turns answers into tags, with many for two codes or more', () => {
		expect([...profileTags(profile)].sort()).toEqual([
			'chat.none',
			'countries.ca',
			'countries.many',
			'countries.us',
			'languages.en',
			'moving.no',
			'pays.cod',
			'pays.online',
			'sells.digital',
			'sells.physical',
		]);
		expect(profileTags({ moving: true, languages: ['en', 'fr'] })).toEqual(
			new Set(['moving.yes', 'languages.en', 'languages.fr', 'languages.many']),
		);
	});

	it('tags own answers as <question>.other and a country of a region as the region', () => {
		const tags = profileTags({ pays: ['cod'], other: { pays: ['Mobile wallet'], offers: [] }, countries: ['DE'], taxes: true });
		expect([...tags].sort()).toEqual(['countries.de', 'countries.eea', 'pays.cod', 'pays.other', 'taxes.yes']);
		expect(ruleHolds('offers.*', profileTags({ other: { offers: ['Gift wrapping'] } }))).toBe(true);
		expect(profileTags({ countries: ['PK', 'US'] }).has('countries.eea')).toBe(false);
		// an own answer alone answers its question
		expect([...answeredQuestions({ other: { delivers: ['Drone'] } })]).toEqual(['delivers']);
		expect(featureFit(['delivers.courier_api'], { other: { delivers: ['Drone'] } })).toEqual({
			fit: 'ruled_out',
			missing: ['delivers.courier_api'],
		});
	});

	it('knows which questions are answered (an empty list is not an answer)', () => {
		expect([...answeredQuestions({ ...profile, delivers: [] })].sort()).toEqual([
			'chat',
			'countries',
			'languages',
			'moving',
			'pays',
			'sells',
		]);
		expect(answeredQuestions({}).size).toBe(0);
	});

	it('holds a rule only when every tag holds; * takes any option but none', () => {
		const tags = profileTags(profile);
		expect(ruleHolds('pays.cod', tags)).toBe(true);
		expect(ruleHolds('pays.online+countries.ca', tags)).toBe(true);
		expect(ruleHolds('pays.online+countries.za', tags)).toBe(false);
		expect(ruleHolds('sells.*', tags)).toBe(true);
		expect(ruleHolds('chat.*', tags)).toBe(false);
		expect(ruleHolds('signIn.*', tags)).toBe(false);
		expect(ruleHolds('languages.many', tags)).toBe(false);
	});

	it('recommends a feature with the first rule that holds', () => {
		expect(featureFit(['pays.link', 'pays.cod', 'pays.online'], profile)).toEqual({
			fit: 'recommended',
			because: ['pays.cod'],
		});
	});

	it('rules a feature out only when every rule fails on an answered question', () => {
		expect(featureFit(['pays.bank_transfer', 'chat.ai'], profile)).toEqual({
			fit: 'ruled_out',
			missing: ['pays.bank_transfer', 'chat.ai'],
		});
		expect(featureFit(['moving.yes'], profile)).toEqual({ fit: 'ruled_out', missing: ['moving.yes'] });
		// one language: a feature for several is ruled out
		expect(featureFit(['languages.many'], profile)).toEqual({ fit: 'ruled_out', missing: ['languages.many'] });
		// the same tag twice is named once
		expect(featureFit(['chat.ai', 'chat.ai+pays.link'], profile)).toEqual({ fit: 'ruled_out', missing: ['chat.ai'] });
	});

	it('says nothing without rules or while an open question could still make a rule hold', () => {
		expect(featureFit([], profile)).toEqual({ fit: 'neutral' });
		expect(featureFit(['delivers.courier'], profile)).toEqual({ fit: 'neutral' });
		expect(featureFit(['pays.link', 'signIn.email'], profile)).toEqual({ fit: 'neutral' });
		expect(featureFit(['pays.cod'], {})).toEqual({ fit: 'neutral' });
	});

	it('advises a product: recommended with on and why, and on features the profile rules out', () => {
		const features = [
			{ key: 'cod', on: false, recommendFor: ['pays.cod'] },
			{ key: 'stripe', on: true, recommendFor: ['pays.online'] },
			{ key: 'bank', on: true, recommendFor: ['pays.bank_transfer'] },
			{ key: 'courier', on: true, recommendFor: ['delivers.courier'] },
			{ key: 'import', on: false, recommendFor: ['moving.yes'] },
			{ key: 'roles', on: true, recommendFor: [] },
		];
		expect(adviseFeatures(features, profile)).toEqual({
			recommended: [
				{ feature: 'cod', on: false, because: ['pays.cod'] },
				{ feature: 'stripe', on: true, because: ['pays.online'] },
			],
			notRecommended: [{ feature: 'bank', missing: ['pays.bank_transfer'] }],
		});
		expect(adviseFeatures(features, {})).toEqual({ recommended: [], notRecommended: [] });
	});
});

describe('validateBusinessProfile', () => {
	it('accepts an empty profile and a full one', () => {
		expect(validateBusinessProfile({}).ok).toBe(true);
		const full = {
			...Object.fromEntries(Object.entries(PROFILE_CHOICES).map(([question, options]) => [question, options.slice(0, 2)])),
			other: { pays: ['Mobile wallet', 'Store credit'], marketing: ['Pinterest'] },
			moving: true,
			taxes: false,
			countries: ['US', 'GB'],
			languages: ['en', 'fil'],
		};
		expect(validateBusinessProfile(full)).toEqual({ ok: true, value: full });
	});

	/** @type {Array<[string, unknown, string, string]>} */
	const cases = [
		['a list', [], '', 'type'],
		['an unknown question', { budget: 'high' }, '/budget', 'additionalProperties'],
		['an unknown option', { pays: ['gold'] }, '/pays/0', 'enum'],
		['an option twice', { pays: ['cod', 'cod'] }, '/pays', 'uniqueItems'],
		['none with other options', { sells: ['physical', 'none'] }, '/sells', RULES.profileAnswer],
		['none with an own answer', { sells: ['none'], other: { sells: ['Tickets'] } }, '/sells', RULES.profileAnswer],
		['an own answer twice', { other: { pays: ['Wallet', 'wallet '] } }, '/other/pays', RULES.profileAnswer],
		['an own answer to a closed question', { other: { chat: ['Bots'] } }, '/other/chat', 'additionalProperties'],
		['an empty own answer', { other: { pays: [''] } }, '/other/pays/0', 'minLength'],
		['six own answers', { other: { pays: ['a', 'b', 'c', 'd', 'e', 'f'] } }, '/other/pays', 'maxItems'],
		['a yes or no as text', { moving: 'yes' }, '/moving', 'type'],
		['a country in small letters', { countries: ['us'] }, '/countries/0', 'pattern'],
		['a language with a region', { languages: ['en-US'] }, '/languages/0', 'pattern'],
		[
			'too many languages',
			{ languages: Array.from({ length: 21 }, (_, i) => `l${String.fromCharCode(97 + i)}`) },
			'/languages',
			'maxItems',
		],
	];
	it.each(cases)('refuses %s', (_name, value, path, keyword) => {
		expectProblem(validateBusinessProfile(value), path, keyword);
	});
});

describe('recommendFor in the manifest', () => {
	it('accepts the fixture and features without tags', () => {
		const value = manifest();
		expect(value.features[0]?.recommendFor).toEqual(['chat.people', 'messages.email+signIn.*']);
		expect(validateManifest(value).ok).toBe(true);
		delete value.features[0]?.recommendFor;
		expect(validateManifest(value).ok).toBe(true);
	});

	/** @type {Array<[string, unknown, string, string]>} */
	const cases = [
		['a rule with spaces', ['pays cod'], '/features/0/recommendFor/0', 'pattern'],
		['five tags', ['pays.cod+sells.physical+chat.ai+messages.sms+marketing.seo'], '/features/0/recommendFor/0', 'pattern'],
		['a rule twice', ['pays.cod', 'pays.cod'], '/features/0/recommendFor', 'uniqueItems'],
		['not a list', 'pays.cod', '/features/0/recommendFor', 'type'],
		['an unknown question', ['shop.cod'], '/features/0/recommendFor/0', RULES.recommendRule],
		['an unknown option', ['pays.barter'], '/features/0/recommendFor/0', RULES.recommendRule],
		['a tag twice in a rule', ['pays.cod+pays.cod'], '/features/0/recommendFor/0', RULES.recommendRule],
	];
	it.each(cases)('refuses %s', (_name, recommendFor, path, keyword) => {
		const value = /** @type {any} */ (manifest());
		value.features[0].recommendFor = recommendFor;
		expectProblem(validateManifest(value), path, keyword);
	});
});
