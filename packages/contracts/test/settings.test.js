import { describe, expect, it } from 'vitest';
import { checkSettingsSchema, validateSettingValue } from '../src/index.js';
import { RULES, checkSettingsRules } from '../src/semantics.js';
import { createValidator } from '../src/validate.js';
import { expectProblem, expectRule } from './helpers.js';

/** @returns {any} */
const schema = () => ({
	type: 'object',
	additionalProperties: false,
	properties: {
		dailyLimit: {
			type: 'integer',
			title: 'Daily limit',
			description: 'Messages per day.',
			default: 100,
			minimum: 0,
			maximum: 1000,
			'x-ui': { widget: 'number', group: 'Limits', placeholder: '100' },
		},
		ratio: { type: 'number', title: 'Ratio', default: 0.5, minimum: 0, maximum: 1 },
		greeting: { type: 'string', title: 'Greeting', default: 'Hi', maxLength: 20 },
		replyTo: { type: 'string', title: 'Reply-to', default: 'help@example.com', format: 'email' },
		tone: { type: 'string', title: 'Tone', default: 'friendly', enum: ['friendly', 'formal'] },
		enabledNudges: { type: 'boolean', title: 'Nudges', default: false },
		pages: {
			type: 'array',
			title: 'Pages',
			default: ['/'],
			items: { type: 'string', maxLength: 100, pattern: '^/' },
		},
		sizes: { type: 'array', title: 'Sizes', default: [1], items: { type: 'integer', minimum: 1, maximum: 9, enum: [1, 2, 3] } },
	},
});

describe('checkSettingsSchema', () => {
	it('accepts the allowed subset', () => {
		expect(checkSettingsSchema(schema())).toEqual([]);
		expect(checkSettingsSchema({ type: 'object', properties: {} })).toEqual([]);
	});

	it('accepts the form hints labels and wide, and the formats email, uri and hostname', () => {
		const labels = schema();
		labels.properties.markets = {
			type: 'array',
			title: 'Markets',
			default: ['GB'],
			items: { type: 'string', enum: ['GB', 'US', 'FR'] },
			'x-ui': { labels: 'country' },
		};
		expect(checkSettingsSchema(labels)).toEqual([]);
		// labels as data: each choice's own words, and suggestions a text or a list may take or leave (K3)
		const data = schema();
		data.properties.tone['x-ui'] = { labels: { friendly: 'Friendly and warm', formal: 'Formal' } };
		data.properties.sizes['x-ui'] = { labels: { 1: 'Small', 3: 'Large' } };
		data.properties.greeting['x-ui'] = { suggestions: ['Hi', 'Hello', 'Welcome'] };
		data.properties.pages['x-ui'] = { suggestions: ['/', '/cart'] };
		expect(checkSettingsSchema(data)).toEqual([]);
		// a text may get a Generate button that makes a random key of 8 to 128 characters
		const key = schema();
		key.properties.greeting['x-ui'] = { generate: 32 };
		expect(checkSettingsSchema(key)).toEqual([]);
		expect(checkSettingsRules(key)).toEqual([]);
		key.properties.greeting['x-ui'] = { generate: 4 };
		expect(checkSettingsSchema(key)).not.toEqual([]);
		// a setting may start from a value of the website's settings in the Portal (of its own kind)
		const from = schema();
		from.properties.greeting['x-ui'] = { defaultFrom: 'region.language' };
		from.properties.pages['x-ui'] = { defaultFrom: 'region.languages' };
		from.properties.enabledNudges['x-ui'] = { defaultFrom: 'team.staffPush' };
		expect(checkSettingsSchema(from)).toEqual([]);
		expect(checkSettingsRules(from)).toEqual([]);
		from.properties.greeting['x-ui'] = { defaultFrom: 'Region' };
		expect(checkSettingsSchema(from)).not.toEqual([]);
		for (const wide of [true, false]) {
			const value = schema();
			value.properties.pages['x-ui'] = { wide };
			expect(checkSettingsSchema(value)).toEqual([]);
		}
		// `advanced` puts a setting in the collapsed Advanced block
		for (const advanced of [true, false]) {
			const value = schema();
			value.properties.pages['x-ui'] = { advanced, group: 'Limits' };
			expect(checkSettingsSchema(value)).toEqual([]);
		}
		const notABoolean = schema();
		notABoolean.properties.pages['x-ui'] = { advanced: 'yes' };
		expect(checkSettingsSchema(notABoolean).map((problem) => problem.path)).toContain('/properties/pages/x-ui/advanced');
		// the dashboard's cards: `group` names the card, `order` sorts the settings
		for (const order of [0, 1, 10000]) {
			const value = schema();
			value.properties.ratio['x-ui'] = { group: 'Limits', order };
			expect(checkSettingsSchema(value)).toEqual([]);
		}
		for (const [format, example] of [
			['email', 'help@example.com'],
			['uri', 'https://shop.example.com/help'],
			['hostname', 'admin.shop.example.com'],
		]) {
			const value = schema();
			value.properties.address = { type: 'string', title: 'Address', default: example, format };
			value.properties.addresses = {
				type: 'array',
				title: 'Addresses',
				default: [example],
				items: { type: 'string', format },
			};
			expect(checkSettingsSchema(value)).toEqual([]);
		}
	});

	/** @type {Array<[string, (s: any) => unknown, string, string]>} */
	const meta = [
		['a non-object root type', (s) => (s.type = 'array'), '/type', 'const'],
		['a missing properties', (s) => delete s.properties, '/properties', 'required'],
		['a root title', (s) => (s.title = 'x'), '/title', 'additionalProperties'],
		['a bad setting name', (s) => (s.properties['bad-name'] = s.properties.ratio), '/properties/bad-name', 'propertyNames'],
		['a setting without default', (s) => delete s.properties.ratio.default, '/properties/ratio/default', 'required'],
		['a setting without title', (s) => delete s.properties.ratio.title, '/properties/ratio/title', 'required'],
		['an object setting', (s) => (s.properties.ratio.type = 'object'), '/properties/ratio/type', 'enum'],
		['an empty pattern', (s) => (s.properties.greeting.pattern = ''), '/properties/greeting/pattern', 'minLength'],
		['a minLength', (s) => (s.properties.greeting.minLength = 1), '/properties/greeting/minLength', 'additionalProperties'],
		['x-plan', (s) => (s.properties.ratio['x-plan'] = {}), '/properties/ratio/x-plan', 'additionalProperties'],
		['x-kind', (s) => (s.properties.ratio['x-kind'] = 'quota'), '/properties/ratio/x-kind', 'additionalProperties'],
		['x-lock', (s) => (s.properties.ratio['x-lock'] = true), '/properties/ratio/x-lock', 'additionalProperties'],
		[
			'an unknown x-ui member',
			(s) => (s.properties.ratio['x-ui'] = { tooltip: 'x' }),
			'/properties/ratio/x-ui/tooltip',
			'additionalProperties',
		],
		...['help', 'hidden'].map(
			(hint) =>
				/** @type {[string, (s: any) => unknown, string, string]} */ ([
					`the x-ui member ${hint}`,
					(s) => (s.properties.ratio['x-ui'] = { [hint]: true }),
					`/properties/ratio/x-ui/${hint}`,
					'additionalProperties',
				]),
		),
		[
			'an empty label',
			(s) => (s.properties.tone['x-ui'] = { labels: { friendly: '' } }),
			'/properties/tone/x-ui/labels',
			'anyOf',
		],
		[
			'a suggestion twice',
			(s) => (s.properties.greeting['x-ui'] = { suggestions: ['Hi', 'Hi'] }),
			'/properties/greeting/x-ui/suggestions',
			'uniqueItems',
		],
		[
			'an order that is not a whole number',
			(s) => (s.properties.ratio['x-ui'] = { order: 1.5 }),
			'/properties/ratio/x-ui/order',
			'type',
		],
		['a negative order', (s) => (s.properties.ratio['x-ui'] = { order: -1 }), '/properties/ratio/x-ui/order', 'minimum'],
		['an order in words', (s) => (s.properties.ratio['x-ui'] = { order: 'first' }), '/properties/ratio/x-ui/order', 'type'],
		['an empty group', (s) => (s.properties.ratio['x-ui'] = { group: '' }), '/properties/ratio/x-ui/group', 'minLength'],
		[
			'wide that is not true or false',
			(s) => (s.properties.pages['x-ui'] = { wide: 'row' }),
			'/properties/pages/x-ui/wide',
			'type',
		],
		['an unknown format', (s) => (s.properties.greeting.format = 'ipv4'), '/properties/greeting/format', 'enum'],
		['a date-time format', (s) => (s.properties.greeting.format = 'date-time'), '/properties/greeting/format', 'enum'],
		['an item format', (s) => (s.properties.pages.items.format = 'uuid'), '/properties/pages/items/format', 'enum'],
		['nested lists', (s) => (s.properties.pages.items.type = 'array'), '/properties/pages/items/type', 'enum'],
		['an item title', (s) => (s.properties.pages.items.title = 'x'), '/properties/pages/items/title', 'additionalProperties'],
	];
	it.each(meta)('refuses %s', (_name, mutate, path, keyword) => {
		const value = schema();
		mutate(value);
		expectProblem({ ok: false, problems: checkSettingsSchema(value) }, path, keyword);
	});

	/** @type {Array<[string, (s: any) => unknown, string, string]>} */
	const rules = [
		['maxLength on a number', (s) => (s.properties.ratio.maxLength = 3), '/properties/ratio/maxLength', RULES.settingKeyword],
		['pattern on a number', (s) => (s.properties.ratio.pattern = '^1'), '/properties/ratio/pattern', RULES.settingKeyword],
		[
			'a pattern that is no regular expression',
			(s) => (s.properties.greeting.pattern = '(['),
			'/properties/greeting/pattern',
			RULES.settingPattern,
		],
		['format on a number', (s) => (s.properties.ratio.format = 'email'), '/properties/ratio/format', RULES.settingKeyword],
		['minimum on a string', (s) => (s.properties.greeting.minimum = 1), '/properties/greeting/minimum', RULES.settingKeyword],
		[
			'enum on a boolean',
			(s) => (s.properties.enabledNudges.enum = [true]),
			'/properties/enabledNudges/enum',
			RULES.settingKeyword,
		],
		[
			'items on a string',
			(s) => (s.properties.greeting.items = { type: 'string' }),
			'/properties/greeting/items',
			RULES.settingKeyword,
		],
		['a list without items', (s) => delete s.properties.pages.items, '/properties/pages/items', RULES.settingItems],
		[
			'maxLength on integer items',
			(s) => (s.properties.sizes.items.maxLength = 2),
			'/properties/sizes/items/maxLength',
			RULES.settingKeyword,
		],
		['minimum above maximum', (s) => (s.properties.ratio.minimum = 2), '/properties/ratio/minimum', RULES.settingRange],
		[
			'a label for a value that is no choice',
			(s) => (s.properties.tone['x-ui'] = { labels: { friendly: 'Friendly', casual: 'Casual' } }),
			'/properties/tone/x-ui/labels/casual',
			RULES.settingLabels,
		],
		[
			'labels on a setting without choices',
			(s) => (s.properties.greeting['x-ui'] = { labels: { Hi: 'Hi' } }),
			'/properties/greeting/x-ui/labels',
			RULES.settingLabels,
		],
		[
			'suggestions on a setting with choices',
			(s) => (s.properties.tone['x-ui'] = { suggestions: ['friendly'] }),
			'/properties/tone/x-ui/suggestions',
			RULES.settingLabels,
		],
		[
			'generate on a setting with choices',
			(s) => (s.properties.tone['x-ui'] = { generate: 32 }),
			'/properties/tone/x-ui/generate',
			RULES.settingLabels,
		],
		[
			'defaultFrom that is no website setting',
			(s) => (s.properties.greeting['x-ui'] = { defaultFrom: 'region.nothing' }),
			'/properties/greeting/x-ui/defaultFrom',
			RULES.websiteSettingsPath,
		],
		[
			'defaultFrom of another kind (a list into a text)',
			(s) => (s.properties.greeting['x-ui'] = { defaultFrom: 'region.languages' }),
			'/properties/greeting/x-ui/defaultFrom',
			RULES.websiteSettingsPath,
		],
		[
			'defaultFrom of a text into a number',
			(s) => (s.properties.ratio['x-ui'] = { defaultFrom: 'region.language' }),
			'/properties/ratio/x-ui/defaultFrom',
			RULES.websiteSettingsPath,
		],
		[
			'generate on a number',
			(s) => (s.properties.ratio['x-ui'] = { generate: 32 }),
			'/properties/ratio/x-ui/generate',
			RULES.settingLabels,
		],
		[
			'suggestions on a number',
			(s) => (s.properties.ratio['x-ui'] = { suggestions: ['0.5'] }),
			'/properties/ratio/x-ui/suggestions',
			RULES.settingLabels,
		],
	];
	it.each(rules)('refuses %s', (_name, mutate, path, keyword) => {
		const value = schema();
		mutate(value);
		expectRule(checkSettingsSchema(value), keyword, path);
		expectRule(checkSettingsRules(value), keyword, path);
	});

	/** @type {Array<[string, (s: any) => unknown, string, string]>} */
	const values = [
		[
			'a default above the maximum',
			(s) => (s.properties.dailyLimit.default = 1001),
			'/properties/dailyLimit/default',
			RULES.settingDefault,
		],
		[
			'a default of the wrong type',
			(s) => (s.properties.greeting.default = 1),
			'/properties/greeting/default',
			RULES.settingDefault,
		],
		[
			'a default too long',
			(s) => (s.properties.greeting.default = 'x'.repeat(21)),
			'/properties/greeting/default',
			RULES.settingDefault,
		],
		[
			'a default not in the enum',
			(s) => (s.properties.tone.default = 'rude'),
			'/properties/tone/default',
			RULES.settingDefault,
		],
		[
			'a default the pattern refuses',
			(s) => (s.properties.greeting.pattern = '^Hello'),
			'/properties/greeting/default',
			RULES.settingDefault,
		],
		[
			'a default not an email',
			(s) => (s.properties.replyTo.default = 'nope'),
			'/properties/replyTo/default',
			RULES.settingDefault,
		],
		[
			'a list default with a bad item',
			(s) => (s.properties.pages.default = [1]),
			'/properties/pages/default/0',
			RULES.settingDefault,
		],
		[
			'an enum value of the wrong type',
			(s) => (s.properties.tone.enum = ['friendly', 2]),
			'/properties/tone/enum/1',
			RULES.settingEnum,
		],
	];
	it.each(values)('refuses %s', (_name, mutate, path, keyword) => {
		const value = schema();
		mutate(value);
		expectRule(checkSettingsSchema(value), keyword, path);
	});
});

describe('setting values', () => {
	it('validates one value against its setting', () => {
		const s = schema();
		expect(validateSettingValue(s, 'dailyLimit', 500)).toEqual({ ok: true, value: 500 });
		expect(validateSettingValue(s, 'pages', ['/a', '/b']).ok).toBe(true);
		expectProblem(validateSettingValue(s, 'dailyLimit', 1001), '/dailyLimit', 'maximum');
		expectProblem(validateSettingValue(s, 'dailyLimit', 1.5), '/dailyLimit', 'type');
		expectProblem(validateSettingValue(s, 'tone', 'rude'), '/tone', 'enum');
		expectProblem(validateSettingValue(s, 'replyTo', 'x'), '/replyTo', 'format');
		expectProblem(validateSettingValue(s, 'pages', ['/'.repeat(101)]), '/pages/0', 'maxLength');
		// a page path starts with /
		expectProblem(validateSettingValue(s, 'pages', ['/a', 'about']), '/pages/1', 'pattern');
		expectProblem(validateSettingValue(s, 'missing', 1), '/missing', 'unknownSetting');
		expectProblem(validateSettingValue(s, 'toString', 1), '/toString', 'unknownSetting');
		expectProblem(validateSettingValue(/** @type {any} */ ({}), 'dailyLimit', 1), '', RULES.settingsSchema);
	});

	it('compiles each schema once per validator', () => {
		const v = createValidator();
		const s = schema();
		expect(v.validateSettingValue(s, 'ratio', 0.1).ok).toBe(true);
		expect(v.validateSettingValue(s, 'ratio', 0.2).ok).toBe(true);
		expect(v.checkSettingsSchema(s)).toEqual([]);
	});
});
