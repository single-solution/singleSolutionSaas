import { describe, expect, it } from 'vitest';
import {
	ADMIN_ROLES,
	PRODUCT_UNAVAILABLE_REASONS,
	validateDirectory,
	validateDirectoryList,
	validateFeatureReport,
	validatePriceReport,
	validateConnectionHealth,
	validateRevocations,
	validateStatusResponse,
	validateWebsiteConnections,
	validateWebsitesPage,
} from '../src/index.js';
import { MERCHANT_STATUSES, PRODUCT_STATUSES } from '../src/constants.js';
import { RULES } from '../src/semantics.js';
import { MERCHANT, WEBSITE, priceReport, statusResponse } from './fixtures.js';
import { expectProblem } from './helpers.js';

describe('vocabularies', () => {
	it('lists the statuses and roles', () => {
		expect(PRODUCT_STATUSES).toEqual(['active', 'grace', 'stopped', 'suspended', 'removed']);
		expect(MERCHANT_STATUSES).toEqual(['active', 'low_balance', 'grace', 'stopped', 'suspended']);
		expect(ADMIN_ROLES).toEqual(['owner', 'support', 'finance']);
		expect(PRODUCT_UNAVAILABLE_REASONS).toEqual(['stopped', 'suspended', 'removed']);
	});
});

describe('connections of a website', () => {
	const connections = () => ({
		version: 3,
		database: { uri: 'mongodb+srv://user:secret@cluster.example.net/?retryWrites=true', dbName: 'ss_ecommerce' },
		storage: {
			bucket: 'media',
			region: 'auto',
			accessKeyId: 'AKIA',
			secretAccessKey: 'secret',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
			forcePathStyle: true,
			prefix: 'shop/',
		},
		links: {
			out: [{ to: 'payments', token: 'a.b.c', scopes: ['payments.create', 'payments.read'] }],
			in: [{ from: 'chat', scopes: ['orders.read.customer'] }],
		},
	});
	it('accepts a full answer and one with nothing set', () => {
		expect(validateWebsiteConnections(connections()).ok).toBe(true);
		expect(validateWebsiteConnections({ version: 0, database: null, storage: null, links: { out: [], in: [] } }).ok).toBe(true);
	});
	/** @type {Array<[string, (c: any) => unknown, string, string]>} */
	const refused = [
		['a database that is not MongoDB', (c) => (c.database.uri = 'postgres://x'), '/database/uri', 'pattern'],
		['a database name with a dot', (c) => (c.database.dbName = 'ss.chat'), '/database/dbName', 'pattern'],
		['a database without its name', (c) => delete c.database.dbName, '/database/dbName', 'required'],
		['a storage without a secret', (c) => delete c.storage.secretAccessKey, '/storage/secretAccessKey', 'required'],
		['an unknown storage member', (c) => (c.storage.publicUrl = 'x'), '/storage/publicUrl', 'additionalProperties'],
		['a link scope in capitals', (c) => (c.links.in[0].scopes = ['Orders']), '/links/in/0/scopes/0', 'pattern'],
		['a link token that is empty', (c) => (c.links.out[0].token = ''), '/links/out/0/token', 'minLength'],
		[
			'a link with an unknown member',
			(c) => (c.links.out[0].grantVersion = 1),
			'/links/out/0/grantVersion',
			'additionalProperties',
		],
		['a member the contract does not know', (c) => (c.shared = {}), '/shared', 'additionalProperties'],
	];
	it.each(refused)('refuses %s', (_name, mutate, path, keyword) => {
		const value = connections();
		mutate(value);
		expectProblem(validateWebsiteConnections(value), path, keyword);
	});
	it('validates the health a product reports', () => {
		expect(validateConnectionHealth({ version: 2, ok: true }).ok).toBe(true);
		expect(validateConnectionHealth({ version: 2, ok: false, message: 'The database cannot be reached.' }).ok).toBe(true);
		expectProblem(validateConnectionHealth({ version: 2 }), '/ok', 'required');
		expectProblem(validateConnectionHealth({ version: 2, ok: true, uri: 'mongodb://x' }), '/uri', 'additionalProperties');
	});
	it('the status answer carries the connections version', () => {
		expect(validateStatusResponse({ ...statusResponse(), connectionsVersion: 4 }).ok).toBe(true);
		expectProblem(validateStatusResponse({ ...statusResponse(), connectionsVersion: -1 }), '/connectionsVersion', 'minimum');
	});
});

describe('validatePriceReport', () => {
	it('accepts the fixture and an empty list', () => {
		expect(validatePriceReport(priceReport()).ok).toBe(true);
		expect(validatePriceReport({ version: 1, features: [] }).ok).toBe(true);
	});

	/** @type {Array<[string, (r: any) => unknown, string, string]>} */
	const cases = [
		['version 0', (r) => (r.version = 0), '/version', 'minimum'],
		['a fractional version', (r) => (r.version = 1.5), '/version', 'type'],
		['a negative price', (r) => (r.features[0].millicreditsPerHour = -1), '/features/0/millicreditsPerHour', 'minimum'],
		['a fractional price', (r) => (r.features[0].millicreditsPerHour = 1.5), '/features/0/millicreditsPerHour', 'type'],
		['a missing price', (r) => delete r.features[0].millicreditsPerHour, '/features/0/millicreditsPerHour', 'required'],
		['an extra member', (r) => (r.features[0].plan = 'x'), '/features/0/plan', 'additionalProperties'],
		['duplicate keys', (r) => (r.features[1].key = 'notes'), '/features/1/key', RULES.duplicateKey],
		['an unknown dependency', (r) => (r.features[1].dependsOn = ['x']), '/features/1/dependsOn/0', RULES.unknownDependency],
		['a self dependency', (r) => (r.features[0].dependsOn = ['notes']), '/features/0/dependsOn/0', RULES.selfDependency],
		['a cycle', (r) => (r.features[0].dependsOn = ['inbox']), '/features/0/dependsOn', RULES.dependencyCycle],
	];
	it.each(cases)('refuses %s', (_name, mutate, path, keyword) => {
		const value = priceReport();
		mutate(value);
		expectProblem(validatePriceReport(value), path, keyword);
	});
});

describe('validateFeatureReport', () => {
	const report = () => ({ version: 4, on: ['notes', 'inbox'], adminId: 'adm_1', adminName: 'Ann' });
	it('accepts a report', () => {
		expect(validateFeatureReport(report()).ok).toBe(true);
		expect(validateFeatureReport({ ...report(), on: [] }).ok).toBe(true);
	});
	it.each([
		['version 0', { version: 0 }, '/version', 'minimum'],
		['duplicate keys', { on: ['notes', 'notes'] }, '/on', 'uniqueItems'],
		['a bad key', { on: ['Notes'] }, '/on/0', 'pattern'],
		['a missing admin name', { adminName: '' }, '/adminName', 'minLength'],
		['an extra member', { websiteId: WEBSITE }, '/websiteId', 'additionalProperties'],
	])('refuses %s', (_name, patch, path, keyword) => {
		expectProblem(validateFeatureReport({ ...report(), ...patch }), path, keyword);
	});
});

describe('validateStatusResponse', () => {
	it('accepts every status', () => {
		expect(validateStatusResponse(statusResponse()).ok).toBe(true);
		for (const status of ['stopped', 'suspended', 'removed'])
			expect(validateStatusResponse({ ...statusResponse(), status }).ok).toBe(true);
		expect(validateStatusResponse({ ...statusResponse(), status: 'grace', graceEndsAt: '2026-10-04T00:00:00.000Z' }).ok).toBe(
			true,
		);
	});

	it.each([
		['an unknown status', { status: 'paused' }, '/status', 'enum'],
		['a merchant status', { status: 'low_balance' }, '/status', 'enum'],
		['a negative charge', { todayMillicredits: -1 }, '/todayMillicredits', 'minimum'],
		['a fractional charge', { todayMillicredits: 0.5 }, '/todayMillicredits', 'type'],
		['a negative features version', { featuresVersion: -1 }, '/featuresVersion', 'minimum'],
		['a local time', { validUntil: '2026-10-01T00:05:00+01:00' }, '/validUntil', 'pattern'],
		['an impossible date', { validUntil: '2026-02-30T00:00:00Z' }, '/validUntil', 'format'],
		['grace without an end', { status: 'grace' }, '/graceEndsAt', RULES.graceEndsAt],
		['an end outside grace', { graceEndsAt: '2026-10-04T00:00:00Z' }, '/graceEndsAt', RULES.graceEndsAt],
		['a bad domain', { domain: 'https://shop.example.com' }, '/domain', 'pattern'],
		['a missing member', { merchantName: undefined }, '/merchantName', 'required'],
	])('refuses %s', (_name, patch, path, keyword) => {
		const value = /** @type {Record<string, unknown>} */ ({ ...statusResponse(), ...patch });
		for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
		expectProblem(validateStatusResponse(value), path, keyword);
	});
});

describe('validateWebsitesPage', () => {
	const row = { websiteId: WEBSITE, domain: 'shop.example.com', merchantId: MERCHANT, merchantName: 'Shop', status: 'active' };
	it('accepts pages', () => {
		expect(validateWebsitesPage({ items: [row], cursor: 'c1' }).ok).toBe(true);
		expect(validateWebsitesPage({ items: [], cursor: null }).ok).toBe(true);
	});
	it('refuses bad rows and cursors', () => {
		expectProblem(validateWebsitesPage({ items: [{ ...row, status: 'x' }], cursor: null }), '/items/0/status', 'enum');
		expectProblem(validateWebsitesPage({ items: [row], cursor: 5 }), '/cursor', 'type');
		expectProblem(validateWebsitesPage({ items: [row] }), '/cursor', 'required');
	});
});

describe('validateRevocations', () => {
	it('accepts lists and refuses bad ids', () => {
		expect(validateRevocations({ tokenIds: ['a', 'b'], cursor: '2026-10-01T00:00:00Z' }).ok).toBe(true);
		expect(validateRevocations({ tokenIds: [], cursor: null }).ok).toBe(true);
		expectProblem(validateRevocations({ tokenIds: [''], cursor: null }), '/tokenIds/0', 'minLength');
		expectProblem(validateRevocations({ tokenIds: [], cursor: null, since: 1 }), '/since', 'additionalProperties');
	});
});

describe('validateDirectory', () => {
	it('accepts https and local addresses only', () => {
		expect(validateDirectory({ baseUrl: 'https://chat.example.dev' }).ok).toBe(true);
		expect(validateDirectory({ baseUrl: 'http://localhost:4000' }).ok).toBe(true);
		expectProblem(validateDirectory({ baseUrl: 'http://chat.example.dev' }), '/baseUrl', RULES.url);
		expectProblem(validateDirectory({ baseUrl: 'not a url' }), '/baseUrl', RULES.url);
		expectProblem(validateDirectory({ baseUrl: `https://${'a'.repeat(2050)}.dev` }), '/baseUrl', 'maxLength');
		expectProblem(validateDirectory({}), '/baseUrl', 'required');
	});
});

describe('validateDirectoryList', () => {
	it('lists every connected product once, each at a service address', () => {
		const items = [
			{ productId: 'bookings', name: 'Bookings', baseUrl: 'https://bookings.example.dev' },
			{ productId: 'chat', name: 'Chat', baseUrl: 'http://localhost:4000' },
		];
		expect(validateDirectoryList({ items }).ok).toBe(true);
		expect(validateDirectoryList({ items: [] }).ok).toBe(true);
		expectProblem(validateDirectoryList({}), '/items', 'required');
		expectProblem(
			validateDirectoryList({ items: [{ productId: 'Chat', name: 'Chat', baseUrl: 'https://chat.example.dev' }] }),
			'/items/0/productId',
			'pattern',
		);
		expectProblem(validateDirectoryList({ items: [{ productId: 'chat', name: 'Chat' }] }), '/items/0/baseUrl', 'required');
		expectProblem(
			validateDirectoryList({ items: [{ productId: 'chat', baseUrl: 'https://chat.example.dev' }] }),
			'/items/0/name',
			'required',
		);
		expectProblem(validateDirectoryList({ items: [{ ...items[0], secret: 'x' }] }), '/items/0/secret', 'additionalProperties');
		expectProblem(
			validateDirectoryList({
				items: [items[0], { productId: 'bookings', name: 'Other', baseUrl: 'https://other.example.dev' }],
			}),
			'/items/1/productId',
			RULES.duplicateKey,
		);
		expectProblem(
			validateDirectoryList({ items: [{ productId: 'chat', name: 'Chat', baseUrl: 'http://chat.example.dev' }] }),
			'/items/0/baseUrl',
			RULES.url,
		);
	});
});
