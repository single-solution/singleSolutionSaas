import { describe, expect, it } from 'vitest';
import { BLUEPRINT_SCHEMA, validateBlueprint, validateProductBlueprint } from '../src/index.js';
import { BLUEPRINT_UNREACHABLE_REASONS } from '../src/schemas/blueprint.js';
import { SCHEMA_IDS } from '../src/schemas/schema-ids.js';
import { productBlueprint } from '../src/testing.js';
import { createValidator } from '../src/validate.js';
import { WEBSITE } from './fixtures.js';
import { expectProblem } from './helpers.js';

/** A sheet with the sample product reachable and one product that did not answer. */
const sheet = () => ({
	schema: BLUEPRINT_SCHEMA,
	generatedAt: '2026-10-01T00:00:00Z',
	website: {
		id: WEBSITE,
		domain: 'shop.example.com',
		status: 'active',
		business: { found: true, name: 'Example Shop', country: 'US', timeZone: 'America/New_York' },
		profile: { sells: ['physical'], chat: ['people'], countries: ['US', 'CA'] },
	},
	access: {
		allowedOrigins: ['https://shop.example.com'],
		testingOrigins: ['http://localhost'],
		serverTokens: 'Issued for each product; never shown here.',
	},
	products: [
		{
			...productBlueprint(),
			reachable: /** @type {const} */ (true),
			apiBase: 'https://notes.example.dev',
			serverToken: { issued: true },
			install: {
				scriptUrl: 'https://notes.example.dev/widget.js',
				installed: false,
				lastSeenAt: null,
				browserToken: 'eyJ.browser.token',
				snippet: '<script src="https://notes.example.dev/widget.js" data-token="eyJ.browser.token" async></script>',
			},
			recommended: [{ feature: 'notes', on: true, because: ['chat.people'], why: 'Your staff answer visitors.' }],
			notRecommended: [],
		},
		{ productId: 'chat', name: 'Chat', reachable: /** @type {const} */ (false), reason: 'timeout' },
	],
});

describe('product blueprint', () => {
	it('accepts the fixture and is registered under its id', () => {
		expect(validateProductBlueprint(productBlueprint()).ok).toBe(true);
		expect(createValidator().has(SCHEMA_IDS.productBlueprint)).toBe(true);
	});

	/** @type {Array<[string, (b: any) => unknown, string, string]>} */
	const cases = [
		[
			'a connection value',
			(b) => (b.connections[0].value = 'mongodb://user:pw@host/db'),
			'/connections/0/value',
			'additionalProperties',
		],
		[
			'the last characters of a connection',
			(b) => (b.connections[0].last4 = 'b/db'),
			'/connections/0/last4',
			'additionalProperties',
		],
		[
			'a connection test message',
			(b) => (b.connections[0].message = 'auth failed'),
			'/connections/0/message',
			'additionalProperties',
		],
		['an unknown connection state', (b) => (b.connections[0].state = 'broken'), '/connections/0/state', 'enum'],
		[
			'a setting without the default flag',
			(b) => delete b.features[0].settings[0].default,
			'/features/0/settings/0/default',
			'required',
		],
		[
			'a setting with its schema',
			(b) => (b.features[0].settings[0].schema = {}),
			'/features/0/settings/0/schema',
			'additionalProperties',
		],
		['an event of another shape', (b) => (b.events = ['Order Placed']), '/events/0', 'pattern'],
		[
			'a list without a summary',
			(b) => b.features[0].lists.push({ name: 'flow', title: 'Flow', count: 1 }),
			'/features/0/lists/0/summary',
			'required',
		],
		['an unknown status', (b) => (b.status = 'paused'), '/status', 'enum'],
		['a widget of another kind', (b) => (b.widgets[0].kind = 'popup'), '/widgets/0/kind', 'enum'],
		['an empty summary', (b) => b.summaries.push({ title: 'Flow', text: '' }), '/summaries/0/text', 'minLength'],
		[
			'a secret setting with its value',
			(b) => (b.features[0].settings[0].set = true),
			'/features/0/settings/0/value',
			'false schema',
		],
		['a setting set of another kind', (b) => (b.features[0].settings[0].set = 'yes'), '/features/0/settings/0/set', 'type'],
		['the address in a product part', (b) => (b.apiBase = 'https://notes.example.dev'), '/apiBase', 'additionalProperties'],
		['a missing checklist', (b) => delete b.checklist, '/checklist', 'required'],
		['a feature without its tags', (b) => delete b.features[1].recommendFor, '/features/1/recommendFor', 'required'],
		[
			'a tag rule of another shape',
			(b) => (b.features[0].recommendFor = ['pays cod']),
			'/features/0/recommendFor/0',
			'pattern',
		],
		['no build list', (b) => delete b.build, '/build', 'required'],
		['a build entry without its text', (b) => (b.build[0].what = ''), '/build/0/what', 'minLength'],
		['a build entry of another shape', (b) => (b.build[0].for = 'notes'), '/build/0/for', 'additionalProperties'],
		['advice in a product part', (b) => (b.recommended = []), '/recommended', 'additionalProperties'],
		['the server token', (b) => (b.serverToken = { issued: true }), '/serverToken', 'additionalProperties'],
	];
	it.each(cases)('refuses %s', (_name, mutate, path, keyword) => {
		const value = productBlueprint();
		mutate(value);
		expectProblem(validateProductBlueprint(value), path, keyword);
	});
});

describe('blueprint (the sheet)', () => {
	it('names its schema and the reasons a product is missing', () => {
		expect(BLUEPRINT_SCHEMA).toBe('ss.blueprint/1');
		expect(BLUEPRINT_UNREACHABLE_REASONS).toEqual(['timeout', 'unreachable', 'refused', 'invalid']);
	});

	it('accepts a sheet with a reachable and a missing product, and a shared copy without values or install', () => {
		expect(validateBlueprint(sheet()).ok).toBe(true);
		expect(validateBlueprint({ ...sheet(), website: { ...sheet().website, profile: null } }).ok).toBe(true);
		// a setting whose value holds a secret shows only that it is set
		const secret = sheet();
		const hidden = /** @type {any} */ (secret.products[0]).features[0].settings[0];
		delete hidden.value;
		hidden.set = true;
		expect(validateBlueprint(secret).ok).toBe(true);
		const shared = sheet();
		const product = /** @type {any} */ (shared.products[0]);
		for (const feature of product.features) for (const one of feature.settings) delete one.value;
		delete product.install.browserToken;
		delete product.install.snippet;
		expect(
			validateBlueprint({ ...shared, share: { expiresAt: '2026-10-08T00:00:00Z', values: false, install: false } }).ok,
		).toBe(true);
	});

	/** @type {Array<[string, (b: any) => unknown, string, string]>} */
	const cases = [
		['another schema', (b) => (b.schema = 'ss.blueprint/2'), '/schema', 'const'],
		['a server token value', (b) => (b.products[0].serverToken.value = 'eyJ.server'), '/products/0', 'oneOf'],
		['a missing product with details', (b) => (b.products[1].features = []), '/products/1', 'oneOf'],
		['an unknown reason', (b) => (b.products[1].reason = 'gone'), '/products/1', 'oneOf'],
		['no allowed origin', (b) => (b.access.allowedOrigins = []), '/access/allowedOrigins', 'minItems'],
		['a domain with a scheme', (b) => (b.website.domain = 'https://shop.example.com'), '/website/domain', 'pattern'],
		['a share without its expiry', (b) => (b.share = { values: true, install: true }), '/share/expiresAt', 'required'],
		['a website without its profile', (b) => delete b.website.profile, '/website/profile', 'required'],
		['a website without its status', (b) => delete b.website.status, '/website/status', 'required'],
		['a removed website status', (b) => (b.website.status = 'removed'), '/website/status', 'enum'],
		['a reachable product without its address', (b) => delete b.products[0].apiBase, '/products/0', 'oneOf'],
		['a profile answer of another kind', (b) => (b.website.profile.sells = ['cars']), '/website/profile', 'anyOf'],
		['a reachable product without advice', (b) => delete b.products[0].recommended, '/products/0', 'oneOf'],
		['advice without a reason', (b) => (b.products[0].recommended[0].because = []), '/products/0', 'oneOf'],
		[
			'advice that is not on the feature',
			(b) => (b.products[0].notRecommended = [{ feature: 'notes' }]),
			'/products/0',
			'oneOf',
		],
	];
	it.each(cases)('refuses %s', (_name, mutate, path, keyword) => {
		const value = sheet();
		mutate(value);
		expectProblem(validateBlueprint(value), path, keyword);
	});
});
