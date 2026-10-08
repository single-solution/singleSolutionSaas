import { describe, expect, it } from 'vitest';
import { RULES, checkManifest, findCycles, manifestPriceList, validateManifest, validatePriceReport } from '../src/index.js';
import { manifest } from '../src/testing.js';
import { expectProblem } from './helpers.js';

describe('validateManifest', () => {
	it('accepts the fixture', () => {
		const value = manifest();
		expect(validateManifest(value)).toEqual({ ok: true, value });
	});

	it('accepts a product without widgets and local or path addresses', () => {
		const value = manifest();
		value.widgets = [];
		value.widgetScriptUrl = null;
		value.endpoints = { base: 'http://localhost:3000', dashboard: 'http://notes.localhost:3000/dashboard' };
		value.docsUrl = 'https://notes.example.dev/docs';
		expect(validateManifest(value).ok).toBe(true);
		value.widgets = [{ key: 'w', feature: 'notes', kind: 'visitor' }];
		value.widgetScriptUrl = '/widget.js';
		expect(validateManifest(value).ok).toBe(true);
		// a widget that works while any of several features is on
		value.widgets = [{ key: 'w', feature: ['notes', 'inbox'], kind: 'visitor' }];
		expect(validateManifest(value).ok).toBe(true);
	});

	/** @type {Array<[string, (m: any) => unknown, string, string]>} */
	const shape = [
		['a non-object', (m) => Object.assign(m, { id: 5 }), '/id', 'type'],
		['a missing id', (m) => delete m.id, '/id', 'required'],
		['a bad id', (m) => (m.id = 'Notes'), '/id', 'pattern'],
		['a bad version', (m) => (m.version = '1.0'), '/version', 'pattern'],
		['an unknown member (prices)', (m) => (m.prices = {}), '/prices', 'additionalProperties'],
		['an unknown member (plans)', (m) => (m.plans = []), '/plans', 'additionalProperties'],
		['an endpoint member', (m) => (m.endpoints.events = '/x'), '/endpoints/events', 'additionalProperties'],
		['a missing widgetScriptUrl', (m) => delete m.widgetScriptUrl, '/widgetScriptUrl', 'required'],
		['no features', (m) => (m.features = []), '/features', 'minItems'],
		['a bad feature key', (m) => (m.features[0].key = 'Notes'), '/features/0/key', 'pattern'],
		['a feature without description', (m) => delete m.features[0].description, '/features/0/description', 'required'],
		['a feature price', (m) => (m.features[0].price = 1), '/features/0/price', 'additionalProperties'],
		['a duplicated dependency', (m) => (m.features[1].dependsOn = ['notes', 'notes']), '/features/1/dependsOn', 'uniqueItems'],
		['a bad permission key', (m) => (m.permissions[0].key = 'Read'), '/permissions/0/key', 'pattern'],
		['a bad widget kind', (m) => (m.widgets[0].kind = 'inline'), '/widgets/0/kind', 'enum'],
		['an empty widget feature list', (m) => (m.widgets[0].feature = []), '/widgets/0/feature', 'anyOf'],
		['a placement member', (m) => (m.widgets[0].placement = {}), '/widgets/0/placement', 'additionalProperties'],
		[
			'settings with plans',
			(m) => (m.features[0].settings['x-plan'] = {}),
			'/features/0/settings/x-plan',
			'additionalProperties',
		],
	];
	it.each(shape)('refuses %s', (_name, mutate, path, keyword) => {
		const value = manifest();
		mutate(value);
		expectProblem(validateManifest(value), path, keyword);
	});

	/** @type {Array<[string, (m: any) => unknown, string, string]>} */
	const semantic = [
		['duplicate feature keys', (m) => (m.features[1].key = 'notes'), '/features/1/key', RULES.duplicateKey],
		['an unknown dependency', (m) => (m.features[1].dependsOn = ['chat']), '/features/1/dependsOn/0', RULES.unknownDependency],
		['a self dependency', (m) => (m.features[0].dependsOn = ['notes']), '/features/0/dependsOn/0', RULES.selfDependency],
		['a dependency cycle', (m) => (m.features[0].dependsOn = ['inbox']), '/features/0/dependsOn', RULES.dependencyCycle],
		[
			'duplicate permissions',
			(m) => m.permissions.push({ key: 'notes.read', name: 'Again', feature: 'notes' }),
			'/permissions/1/key',
			RULES.duplicateKey,
		],
		[
			'a permission of an unknown feature',
			(m) => (m.permissions[0].feature = 'chat'),
			'/permissions/0/feature',
			RULES.unknownFeature,
		],
		['duplicate widgets', (m) => (m.widgets[1].key = 'note_form'), '/widgets/1/key', RULES.duplicateKey],
		['a widget of an unknown feature', (m) => (m.widgets[0].feature = 'chat'), '/widgets/0/feature', RULES.unknownFeature],
		[
			'a widget listing an unknown feature',
			(m) => (m.widgets[0].feature = ['notes', 'chat']),
			'/widgets/0/feature',
			RULES.unknownFeature,
		],
		['a script URL without widgets', (m) => (m.widgets = []), '/widgetScriptUrl', RULES.widgetScriptUrl],
		['widgets without a script URL', (m) => (m.widgetScriptUrl = null), '/widgetScriptUrl', RULES.widgetScriptUrl],
		['an http script URL', (m) => (m.widgetScriptUrl = 'http://notes.example.dev/widget.js'), '/widgetScriptUrl', RULES.url],
		['an http base', (m) => (m.endpoints.base = 'http://notes.example.dev'), '/endpoints/base', RULES.url],
		['a relative base', (m) => (m.endpoints.base = '/'), '/endpoints/base', RULES.url],
		['a base with a query', (m) => (m.endpoints.base = 'https://notes.example.dev?x=1'), '/endpoints/base', RULES.url],
		['a base with userinfo', (m) => (m.endpoints.base = 'https://u:p@notes.example.dev'), '/endpoints/base', RULES.url],
		['a dashboard that is not a path', (m) => (m.endpoints.dashboard = 'dashboard'), '/endpoints/dashboard', RULES.url],
		['a protocol-relative docs URL', (m) => (m.docsUrl = '//evil.test/docs'), '/docsUrl', RULES.url],
		[
			'a setting whose default breaks its limits',
			(m) => (m.features[0].settings.properties.maxNotes.default = 99),
			'/features/0/settings/properties/maxNotes/default',
			RULES.settingDefault,
		],
		[
			'a setting keyword that does not fit',
			(m) => (m.features[1].settings.properties.sort.minimum = 1),
			'/features/1/settings/properties/sort/minimum',
			RULES.settingKeyword,
		],
	];
	it.each(semantic)('refuses %s', (_name, mutate, path, keyword) => {
		const value = manifest();
		mutate(value);
		expectProblem(validateManifest(value), path, keyword);
	});

	it('checkManifest is empty for the fixture', () => {
		expect(checkManifest(manifest())).toEqual([]);
	});
});

describe('manifestPriceList', () => {
	it('builds price-list version 1 with every feature at 0', () => {
		const value = manifest();
		const list = manifestPriceList(value);
		expect(list).toEqual({
			version: 1,
			features: [
				{ key: 'notes', name: 'Notes', description: 'Visitors leave short notes.', dependsOn: [], millicreditsPerHour: 0 },
				{
					key: 'inbox',
					name: 'Notes inbox',
					description: 'Staff read the notes in their own admin.',
					dependsOn: ['notes'],
					millicreditsPerHour: 0,
				},
			],
		});
		expect(list.features[1]?.dependsOn).not.toBe(value.features[1]?.dependsOn);
		expect(validatePriceReport(list).ok).toBe(true);
	});
});

describe('findCycles', () => {
	it('finds each cycle once and ignores unknown nodes', () => {
		const graph = new Map([
			['a', ['b']],
			['b', ['c', 'x']],
			['c', ['a']],
			['d', ['d']],
			['e', []],
		]);
		expect(findCycles(graph)).toEqual([
			['a', 'b', 'c', 'a'],
			['d', 'd'],
		]);
	});
});
