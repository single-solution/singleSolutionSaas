import { describe, expect, it } from 'vitest';
import {
	ADMIN_ROLES,
	DASHBOARD_ROLES,
	MERCHANT_STATUSES,
	NOTICE_TYPES,
	PRODUCT_IDS,
	PRODUCT_STATUSES,
	PRODUCT_UNAVAILABLE_REASONS,
	RULES,
	validateDirectory,
	validateFeatureReport,
	validateNotice,
	validatePriceReport,
	validateRevocations,
	validateStatusResponse,
	validateWebsitesPage,
} from '../src/index.js';
import { MERCHANT, WEBSITE, priceReport, statusResponse } from '../src/testing.js';
import { expectProblem } from './helpers.js';

describe('vocabularies', () => {
	it('lists the statuses, roles, notices and products', () => {
		expect(PRODUCT_STATUSES).toEqual(['active', 'grace', 'stopped', 'suspended', 'removed']);
		expect(MERCHANT_STATUSES).toEqual(['active', 'low_balance', 'grace', 'stopped', 'suspended']);
		expect(ADMIN_ROLES).toEqual(['owner', 'support', 'finance']);
		expect(DASHBOARD_ROLES).toEqual(['owner', 'support']);
		expect(NOTICE_TYPES).toEqual(['status.changed', 'token.revoked', 'sessions.revoked', 'website.deleted']);
		expect(PRODUCT_IDS).toEqual(['accounts', 'ecommerce', 'chat', 'notifications', 'payments', 'growth']);
		expect(PRODUCT_UNAVAILABLE_REASONS).toEqual(['stopped', 'suspended', 'removed']);
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

describe('validateNotice', () => {
	it.each([
		[{ type: 'status.changed', websiteId: WEBSITE }],
		[{ type: 'token.revoked', websiteId: WEBSITE }],
		[{ type: 'website.deleted', websiteId: WEBSITE }],
		[{ type: 'sessions.revoked', subject: 'adm_1' }],
	])('accepts %j', (notice) => {
		expect(validateNotice(notice).ok).toBe(true);
	});

	it.each([
		['an unknown type', { type: 'order.placed', websiteId: WEBSITE }, '/type', 'enum'],
		['status.changed without websiteId', { type: 'status.changed' }, '/websiteId', 'required'],
		['sessions.revoked without subject', { type: 'sessions.revoked' }, '/subject', 'required'],
		[
			'sessions.revoked with websiteId',
			{ type: 'sessions.revoked', subject: 's', websiteId: WEBSITE },
			'/websiteId',
			'false schema',
		],
		['website.deleted with subject', { type: 'website.deleted', websiteId: WEBSITE, subject: 's' }, '/subject', 'false schema'],
		['an extra member', { type: 'token.revoked', websiteId: WEBSITE, jti: 'x' }, '/jti', 'additionalProperties'],
	])('refuses %s', (_name, notice, path, keyword) => {
		expectProblem(validateNotice(notice), path, keyword);
	});
});
