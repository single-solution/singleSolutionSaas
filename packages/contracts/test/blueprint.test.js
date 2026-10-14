import { describe, expect, it } from 'vitest';
import {
	BLUEPRINT_SCHEMA,
	BLUEPRINT_UNREACHABLE_REASONS,
	SCHEMA_IDS,
	createValidator,
	validateBlueprint,
	validateProductBlueprint,
} from '../src/index.js';
import { WEBSITE, productBlueprint } from '../src/testing.js';
import { expectProblem } from './helpers.js';

/** A sheet with the sample product reachable and one product that did not answer. */
const sheet = () => ({
	schema: BLUEPRINT_SCHEMA,
	generatedAt: '2026-10-01T00:00:00Z',
	website: {
		id: WEBSITE,
		domain: 'shop.example.com',
		business: { found: true, name: 'Example Shop', country: 'US', timeZone: 'America/New_York' },
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
			serverToken: { issued: true },
			install: {
				scriptUrl: 'https://notes.example.dev/widget.js',
				installed: false,
				lastSeenAt: null,
				browserToken: 'eyJ.browser.token',
				snippet: '<script src="https://notes.example.dev/widget.js" data-token="eyJ.browser.token" async></script>',
			},
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
		['a missing checklist', (b) => delete b.checklist, '/checklist', 'required'],
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
	];
	it.each(cases)('refuses %s', (_name, mutate, path, keyword) => {
		const value = sheet();
		mutate(value);
		expectProblem(validateBlueprint(value), path, keyword);
	});
});
