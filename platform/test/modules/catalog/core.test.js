import { describe, expect, it } from 'vitest';
import {
	BUNDLE_FORMAT,
	checkBundleAssets,
	checkWidgetManifest,
	parseBundleUpload,
} from '../../../src/modules/catalog/core/bundle.js';
import * as input from '../../../src/modules/catalog/core/input.js';
import { launchRefusal, launchUrl } from '../../../src/modules/catalog/core/launch.js';
import { catalogEntry, planEntries, priceChanges, priceSummary } from '../../../src/modules/catalog/core/summary.js';
import { packAssets, packManifest, serviceManifest } from './fixtures.js';

describe('summary', () => {
	it('derives plans and prices in millicredits', () => {
		const m = serviceManifest();
		expect(planEntries(m)).toEqual([
			{
				code: 'starter',
				name: 'Starter',
				elements: ['codes', 'apply_box'],
				addons: [],
				includedHourlyMillicredits: 1000,
				maxHourlyMillicredits: 1000,
			},
		]);
		expect(priceSummary(m)).toEqual({
			fromHourlyMillicredits: 1000,
			allElementsHourlyMillicredits: 1000,
			metered: true,
			free: false,
			priceBook: { version: '2026-10-01', effectiveFrom: '2026-10-01T00:00:00Z' },
		});
		const pack = packManifest();
		expect(priceSummary(pack)).toMatchObject({ fromHourlyMillicredits: 0, free: true, metered: false });
	});

	it('builds catalog entries', () => {
		const m = serviceManifest();
		m.product.description = 'Codes';
		m.plans[0].description = 'Small shops';
		m.elements[0].description = 'Engine';
		const app = {
			appId: 'app_1',
			slug: 'coupons',
			kind: 'service',
			status: 'active',
			currentVersion: 2,
		};
		const entry = catalogEntry(app, m);
		expect(entry).toMatchObject({
			appId: 'app_1',
			name: 'Coupons',
			description: 'Codes',
			manifestVersion: 2,
			capabilities: { adminLaunch: true, identityIssuer: false },
			requires: ['database'],
		});
		expect(entry.plans[0]?.description).toBe('Small shops');
		expect(entry.elements[0]).toMatchObject({
			key: 'codes',
			description: 'Engine',
			configurable: true,
			price: {
				hourlyMillicredits: 1000,
				metered: [{ unit: 'redemption', perUnitMillicredits: 10, per: 1, included: { starter: 500 } }],
			},
		});
		expect(entry.elements[0]).not.toHaveProperty('features');
		const detail = catalogEntry(app, packManifest(), { detail: true });
		expect(detail).toMatchObject({ capabilities: { adminLaunch: false }, plans: [] });
		expect(detail.elements[0]).toMatchObject({ features: null, configurable: false });
		expect(/** @type {any} */ (catalogEntry(app, m, { detail: true }).elements[0])?.features).toEqual(m.elements[0].features);
	});

	it('lists element price changes (added, removed, changed)', () => {
		const before = serviceManifest();
		expect(priceChanges(before, serviceManifest())).toEqual([]);
		const after = serviceManifest();
		after.elements[0].price = { metered: after.elements[0].price.metered, hourly: 2000 };
		after.elements[1].key = 'apply_box_v2';
		expect(priceChanges(before, after)).toEqual([
			{ element: 'codes', before: before.elements[0].price, after: after.elements[0].price },
			{ element: 'apply_box', before: { hourly: 0 }, after: null },
			{ element: 'apply_box_v2', before: null, after: { hourly: 0 } },
		]);
	});
});

describe('launch rules', () => {
	const app = { kind: 'service', status: 'active' };
	const base = { appId: 'app_1', subject: 'usr_1', user: { id: 'usr_1' } };
	/** @param {any} over @param {any} [appOver] @param {(m: any) => void} [edit] */
	const refusal = (over, appOver = {}, edit = () => {}) => {
		const manifest = serviceManifest();
		edit(manifest);
		return launchRefusal({ input: { ...base, ...over }, app: { ...app, ...appOver }, manifest });
	};

	it('accepts merchant and admin launches when the rules hold', () => {
		expect(refusal({ kind: 'merchant', scope: { merchantId: 'mer_1' } })).toBeNull();
		expect(refusal({ kind: 'admin', actor: 'stf_1', scope: { merchantId: 'mer_1' } })).toBeNull();
		expect(refusal({ kind: 'admin', actor: 'stf_1', scope: { merchantId: 'mer_1' } }, { status: 'inactive' })).toBeNull();
		expect(refusal({ kind: 'admin', actor: 'stf_1', scope: { all: true } })).toBeNull();
		expect(refusal({ kind: 'admin', actor: 'stf_1', scope: { all: true, permissions: ['x'] } })).toBeNull();
	});

	/** @type {Array<[any, any, ((m: any) => void) | undefined, RegExp]>} */
	const refusals = [
		[{ kind: 'demo' }, {}, undefined, /unknown launch kind/],
		[{ kind: 'merchant' }, { kind: 'pack' }, undefined, /packs/],
		[{ kind: 'merchant', scope: { merchantId: 'm' } }, { status: 'inactive' }, undefined, /inactive/],
		[{ kind: 'merchant', subject: '' }, {}, undefined, /subject/],
		[{ kind: 'merchant', user: {} }, {}, undefined, /user\.id/],
		[{ kind: 'merchant', scope: { merchantId: 'm' }, subscriptions: 'x' }, {}, undefined, /subscriptions/],
		[{ kind: 'merchant' }, {}, undefined, /merchantId/],
		[
			{ kind: 'admin', actor: 'stf_1', scope: { merchantId: 'm' } },
			{},
			(/** @type {any} */ m) => void (m.capabilities.adminLaunch = false),
			/admin launches/,
		],
		[{ kind: 'admin', scope: { merchantId: 'm' } }, {}, undefined, /staff actor/],
		[{ kind: 'admin', actor: 'stf_1' }, {}, undefined, /merchantId/],
		[{ kind: 'admin', actor: 'stf_1', scope: { all: false } }, {}, undefined, /all must be true/],
		[{ kind: 'admin', actor: 'stf_1', scope: { all: true, merchantId: 'm' } }, {}, undefined, /excludes/],
		[{ kind: 'admin', actor: 'stf_1', scope: { all: true }, subscriptions: [] }, {}, undefined, /excludes/],
	];
	it.each(refusals)('refuses %j on %j', (over, appOver, edit, reason) => {
		expect(refusal(over, appOver, /** @type {any} */ (edit))).toMatch(reason);
	});

	it('builds the product sso URL', () => {
		expect(launchUrl('https://p.example.com/', 'a.b+c')).toBe('https://p.example.com/sso?launch=a.b%2Bc');
	});
});

describe('bundle descriptors', () => {
	const descriptor = () => ({
		format: BUNDLE_FORMAT,
		manifest: packManifest(),
		assets: packAssets(),
		createdAt: '2026-10-01T00:00:00Z',
	});
	it('parses a valid upload', () => {
		expect(parseBundleUpload({ descriptor: descriptor() }).ok).toBe(true);
	});

	it('reports every shape problem', () => {
		/** @param {unknown} body */
		const paths = (body) => /** @type {any} */ (parseBundleUpload(body)).errors.map((/** @type {any} */ e) => e.path);
		expect(paths(null)).toEqual(['']);
		expect(paths({ x: 1 })).toEqual(['/x', '/descriptor']);
		expect(paths({ descriptor: { format: 'x', manifest: [], assets: [], createdAt: 'yesterday', extra: 1 } })).toEqual([
			'/descriptor/extra',
			'/descriptor/format',
			'/descriptor/manifest',
			'/descriptor/createdAt',
			'/descriptor/assets',
		]);
		const bad = descriptor();
		bad.assets = /** @type {any} */ ([
			'x',
			{ path: '../etc/passwd', sha256: 'A'.repeat(64), size: -1, contentType: 'js', more: 1 },
			{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 1 },
			{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 1 },
			{ path: '/abs.js', sha256: 'b'.repeat(64), size: 1 },
		]);
		expect(paths({ descriptor: bad })).toEqual([
			'/descriptor/assets/0',
			'/descriptor/assets/1/more',
			'/descriptor/assets/1/path',
			'/descriptor/assets/1/sha256',
			'/descriptor/assets/1/size',
			'/descriptor/assets/1/contentType',
			'/descriptor/assets/3/path',
			'/descriptor/assets/4/path',
		]);
	});

	it('cross-checks module references against assets', () => {
		const m = packManifest();
		expect(checkBundleAssets(m, packAssets())).toEqual([]);
		m.elements[0].strings = 'strings/bar.json';
		expect(checkBundleAssets(m, packAssets().slice(1)).map((e) => e.path)).toEqual([
			'/descriptor/manifest/elements/0/headless',
			'/descriptor/manifest/elements/0/strings',
		]);
	});

	it('checks widget manifests against the product manifest', () => {
		const current = serviceManifest();
		expect(checkWidgetManifest(serviceManifest(), current)).toEqual([]);
		expect(checkWidgetManifest('x', current)).toEqual([
			{ path: '/descriptor/manifest/elements', message: 'must list elements' },
		]);
		const other = serviceManifest();
		other.product.slug = 'other';
		other.elements[0].headless = 'headless/codes.js#create';
		other.elements[0].modes = ['A', 'C'];
		other.elements[1].renderer = 7;
		expect(checkWidgetManifest(other, current).map((e) => e.path)).toEqual([
			'/descriptor/manifest/product/slug',
			'/descriptor/manifest/elements/0/key',
			'/descriptor/manifest/elements/0/renderer',
			'/descriptor/manifest/elements/1/renderer',
		]);
		// a headless-only core of a non-mode-A element ships in the bundle but is not a widget
		const coreOnly = serviceManifest();
		coreOnly.elements[0].headless = 'headless/codes.js#create';
		coreOnly.elements[0].modes = ['B', 'C'];
		expect(checkWidgetManifest(coreOnly, current)).toEqual([]);
		const none = serviceManifest();
		none.elements = [none.elements[0], 5];
		expect(checkWidgetManifest(none, current).map((e) => e.message)).toEqual(['no element ships browser modules']);
	});
});

describe('route inputs', () => {
	/** @param {any} r */
	const errs = (r) => (r.ok ? [] : r.errors.map((/** @type {any} */ e) => e.path));

	it('status, consume', () => {
		expect(input.parseStatus({ status: 'active' })).toEqual({ ok: true, value: { status: 'active' } });
		expect(errs(input.parseStatus({ status: 'retired', x: 1 }))).toEqual(['/x', '/status']);
		expect(errs(input.parseStatus(null))).toEqual(['', '/status']);
		expect(input.parseConsume({ jti: 'j'.repeat(22), exp: 1 })).toEqual({ ok: true, value: { jti: 'j'.repeat(22) } });
		expect(errs(input.parseConsume({ jti: 'short', exp: 'x' }))).toEqual(['/jti', '/exp']);
	});

	it('launch bodies', () => {
		expect(input.parseStaffLaunch({ kind: 'admin', merchantId: 'mer_1' })).toEqual({
			ok: true,
			value: { all: false, merchantId: 'mer_1', websiteId: null },
		});
		expect(input.parseStaffLaunch(undefined)).toEqual({ ok: true, value: { all: false, merchantId: null, websiteId: null } });
		expect(errs(input.parseStaffLaunch({ kind: 'impersonate', environment: 'staging' }))).toEqual(['/environment', '/kind']);
		expect(input.parseStaffLaunch({ all: true })).toMatchObject({ ok: true, value: { all: true } });
		expect(errs(input.parseStaffLaunch({ all: 'yes' }))).toEqual(['/all']);
		expect(errs(input.parseStaffLaunch({ all: true, merchantId: 'mer_1' }))).toEqual(['/all']);
		expect(input.parseMerchantLaunch(undefined)).toEqual({ ok: true, value: { websiteId: null } });
		expect(errs(input.parseMerchantLaunch({ websiteId: 1 }))).toEqual(['/websiteId']);
	});
});
