import { describe, expect, it } from 'vitest';
import {
	RULES,
	SETTING_KEYWORDS,
	checkSettingsRules,
	checkSettingsSchema,
	createValidator,
	validateSettingValue,
	validateSettings,
} from '../src/index.js';
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
			'x-ui': { widget: 'number', group: 'Limits', order: 1, help: 'Hard maximum 1000.', placeholder: '100' },
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
			items: { type: 'string', maxLength: 100 },
		},
		sizes: { type: 'array', title: 'Sizes', default: [1], items: { type: 'integer', minimum: 1, maximum: 9, enum: [1, 2, 3] } },
	},
});

describe('checkSettingsSchema', () => {
	it('accepts the allowed subset', () => {
		expect(checkSettingsSchema(schema())).toEqual([]);
		expect(checkSettingsSchema({ type: 'object', properties: {} })).toEqual([]);
		expect(SETTING_KEYWORDS).toContain('x-ui');
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
		['a pattern', (s) => (s.properties.greeting.pattern = '^a'), '/properties/greeting/pattern', 'additionalProperties'],
		['a minLength', (s) => (s.properties.greeting.minLength = 1), '/properties/greeting/minLength', 'additionalProperties'],
		['x-plan', (s) => (s.properties.ratio['x-plan'] = {}), '/properties/ratio/x-plan', 'additionalProperties'],
		['x-kind', (s) => (s.properties.ratio['x-kind'] = 'quota'), '/properties/ratio/x-kind', 'additionalProperties'],
		['x-lock', (s) => (s.properties.ratio['x-lock'] = true), '/properties/ratio/x-lock', 'additionalProperties'],
		[
			'an unknown x-ui member',
			(s) => (s.properties.ratio['x-ui'] = { hidden: true }),
			'/properties/ratio/x-ui/hidden',
			'additionalProperties',
		],
		['an unknown format', (s) => (s.properties.greeting.format = 'ipv4'), '/properties/greeting/format', 'enum'],
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
		expectProblem(validateSettingValue(s, 'pages', ['x'.repeat(101)]), '/pages/0', 'maxLength');
		expectProblem(validateSettingValue(s, 'missing', 1), '/missing', 'unknownSetting');
		expectProblem(validateSettingValue(s, 'toString', 1), '/toString', 'unknownSetting');
		expectProblem(validateSettingValue(/** @type {any} */ ({}), 'dailyLimit', 1), '', RULES.settingsSchema);
	});

	it('validates several values; any subset, unknown keys refused', () => {
		const s = schema();
		expect(validateSettings(s, { dailyLimit: 1, tone: 'formal' })).toEqual({
			ok: true,
			value: { dailyLimit: 1, tone: 'formal' },
		});
		expect(validateSettings(s, {}).ok).toBe(true);
		expectProblem(validateSettings(s, { other: 1 }), '/other', 'additionalProperties');
		expectProblem(validateSettings(s, { ratio: 2 }), '/ratio', 'maximum');
		expectProblem(validateSettings(s, []), '', 'type');
		expectProblem(validateSettings(/** @type {any} */ (null), {}), '', RULES.settingsSchema);
	});

	it('compiles each schema once per validator', () => {
		const v = createValidator();
		const s = schema();
		expect(v.validateSettings(s, { ratio: 0.1 }).ok).toBe(true);
		expect(v.validateSettings(s, { ratio: 0.2 }).ok).toBe(true);
		expect(v.validateSettingValue(s, 'ratio', 0.3).ok).toBe(true);
		expect(v.checkSettingsSchema(s)).toEqual([]);
	});
});
