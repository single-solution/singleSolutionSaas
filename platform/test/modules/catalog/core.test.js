import { describe, expect, it } from 'vitest';
import { createSigner, generateSigningKey } from '@ss/protocol';
import {
	BUNDLE_FORMAT,
	bundleSigningInput,
	checkBundleAssets,
	parseBundleUpload,
} from '../../../src/modules/catalog/core/bundle.js';
import { healthView, parseHeartbeat } from '../../../src/modules/catalog/core/health.js';
import * as input from '../../../src/modules/catalog/core/input.js';
import { launchRefusal, launchUrl } from '../../../src/modules/catalog/core/launch.js';
import {
	MIN_SUNSET_MS,
	applyLifecycle,
	dueForRetirement,
	launchKindsFor,
	reviewRefusal,
} from '../../../src/modules/catalog/core/lifecycle.js';
import { catalogEntry, planEntries, priceSummary } from '../../../src/modules/catalog/core/summary.js';
import { signBundle, verifyBundle } from '../../../src/modules/catalog/signatures.js';
import { packAssets, packManifest, serviceManifest } from './fixtures.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

describe('lifecycle', () => {
	it('walks pending → active → deprecated → retired', () => {
		expect(applyLifecycle({ status: 'pending', action: 'activate', now: NOW })).toEqual({
			ok: true,
			status: 'active',
			sunsetAt: null,
		});
		const sunset = NOW + 30 * 86_400_000;
		expect(applyLifecycle({ status: 'active', action: 'deprecate', now: NOW, sunsetAt: iso(sunset) })).toEqual({
			ok: true,
			status: 'deprecated',
			sunsetAt: new Date(sunset),
		});
		expect(applyLifecycle({ status: 'deprecated', action: 'activate', now: NOW })).toMatchObject({
			ok: true,
			status: 'active',
		});
		expect(
			applyLifecycle({ status: 'deprecated', action: 'retire', now: sunset, currentSunsetAt: new Date(sunset) }),
		).toMatchObject({ ok: true, status: 'retired' });
		expect(applyLifecycle({ status: 'pending', action: 'retire', now: NOW })).toMatchObject({ ok: true, status: 'retired' });
	});

	it('refuses invalid transitions and sunsets', () => {
		const refused = (/** @type {any} */ args) => /** @type {any} */ (applyLifecycle(args)).reason;
		expect(refused({ status: 'active', action: 'activate', now: NOW })).toMatch(/cannot be activated/);
		expect(refused({ status: 'pending', action: 'deprecate', now: NOW, sunsetAt: iso(NOW + 9e9) })).toMatch(
			/cannot be deprecated/,
		);
		expect(refused({ status: 'active', action: 'deprecate', now: NOW })).toMatch(/ISO-8601/);
		expect(refused({ status: 'active', action: 'deprecate', now: NOW, sunsetAt: 'tomorrow' })).toMatch(/ISO-8601/);
		expect(refused({ status: 'active', action: 'deprecate', now: NOW, sunsetAt: iso(NOW + MIN_SUNSET_MS - 1) })).toMatch(
			/one day/,
		);
		expect(refused({ status: 'active', action: 'deprecate', now: NOW, sunsetAt: iso(NOW + 800 * 86_400_000) })).toMatch(
			/two years/,
		);
		expect(refused({ status: 'active', action: 'retire', now: NOW })).toMatch(/deprecate it first/);
		expect(refused({ status: 'deprecated', action: 'retire', now: NOW, currentSunsetAt: new Date(NOW + 1000) })).toMatch(
			/sunset/,
		);
		expect(refused({ status: 'active', action: 'explode', now: NOW })).toMatch(/unknown action/);
		expect(
			applyLifecycle({ status: 'deprecated', action: 'retire', now: NOW, currentSunsetAt: new Date(NOW + 1000), force: true }),
		).toMatchObject({ ok: true, status: 'retired' });
	});

	it('knows when to retire and what may be reviewed or launched', () => {
		expect(dueForRetirement({ status: 'deprecated', sunsetAt: new Date(NOW) }, NOW)).toBe(true);
		expect(dueForRetirement({ status: 'deprecated', sunsetAt: new Date(NOW + 1) }, NOW)).toBe(false);
		expect(dueForRetirement({ status: 'active', sunsetAt: new Date(NOW) }, NOW)).toBe(false);
		expect(dueForRetirement({ status: 'deprecated', sunsetAt: null }, NOW)).toBe(false);
		expect(reviewRefusal({ versionStatus: 'pending', appStatus: 'active', action: 'approve' })).toBeNull();
		expect(reviewRefusal({ versionStatus: 'pending', appStatus: 'retired', action: 'approve' })).toMatch(/retired/);
		expect(reviewRefusal({ versionStatus: 'accepted', appStatus: 'active', action: 'reject' })).toMatch(/not pending/);
		expect(reviewRefusal({ versionStatus: 'pending', appStatus: 'active', action: /** @type {any} */ ('x') })).toMatch(
			/unknown/,
		);
		expect(launchKindsFor('active')).toContain('merchant');
		expect(launchKindsFor('pending')).toEqual(['admin', 'developer', 'demo']);
		expect(launchKindsFor('retired')).toEqual([]);
	});
});

describe('health', () => {
	it('parses heartbeats', () => {
		expect(parseHeartbeat({ version: '1.4.0', status: 'ok', queues: { usagePending: 3 } })).toEqual({
			ok: true,
			value: { version: '1.4.0', status: 'ok', queues: { usagePending: 3 } },
		});
		expect(parseHeartbeat({ version: '1.4.0', status: 'degraded', queues: null })).toMatchObject({
			ok: true,
			value: { queues: null },
		});
		/** @param {unknown} body */
		const paths = (body) => /** @type {any} */ (parseHeartbeat(body)).errors.map((/** @type {any} */ e) => e.path);
		expect(paths(null)).toEqual(['']);
		expect(paths({ version: '', status: 'OK', extra: 1 })).toEqual(['/extra', '/version', '/status']);
		expect(paths({ version: '1', status: 'ok', queues: [] })).toEqual(['/queues']);
		expect(paths({ version: '1', status: 'ok', queues: { a: -1, 'bad name': 1 } })).toEqual(['/queues/a', '/queues/bad name']);
	});

	it('flags stale apps', () => {
		expect(healthView(null, NOW)).toEqual({ lastHeartbeatAt: null, version: null, status: null, queues: null, stale: true });
		const fresh = { lastHeartbeatAt: new Date(NOW - 60_000), version: '1', status: 'ok', queues: null };
		expect(healthView(fresh, NOW)).toMatchObject({ stale: false, lastHeartbeatAt: iso(NOW - 60_000) });
		expect(healthView(fresh, NOW + 20 * 60_000).stale).toBe(true);
		expect(healthView(fresh, NOW, 30_000).stale).toBe(true);
	});
});

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
			trialHours: 48,
			priceBook: { version: '2026-10-01', effectiveFrom: '2026-10-01T00:00:00Z' },
		});
		const pack = packManifest();
		expect(priceSummary(pack)).toMatchObject({ fromHourlyMillicredits: 0, free: true, metered: false, trialHours: 0 });
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
			status: 'deprecated',
			sunsetAt: new Date(NOW),
			currentVersion: 2,
		};
		const entry = catalogEntry(app, m);
		expect(entry).toMatchObject({
			appId: 'app_1',
			sunsetAt: iso(NOW),
			name: 'Coupons',
			description: 'Codes',
			manifestVersion: 2,
			capabilities: { adminLaunch: true, sandbox: true },
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
		const detail = catalogEntry({ ...app, sunsetAt: null }, packManifest(), { detail: true });
		expect(detail).toMatchObject({ sunsetAt: null, capabilities: { adminLaunch: false, sandbox: false }, plans: [] });
		expect(detail.elements[0]).toMatchObject({ features: null, configurable: false });
		expect(/** @type {any} */ (catalogEntry(app, m, { detail: true }).elements[0])?.features).toEqual(m.elements[0].features);
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

	it('accepts every kind when the rules hold', () => {
		expect(refusal({ kind: 'merchant', scope: { merchantId: 'mer_1' } })).toBeNull();
		expect(refusal({ kind: 'admin', actor: 'stf_1', scope: { merchantId: 'mer_1' } })).toBeNull();
		expect(
			refusal({ kind: 'impersonate', actor: 'stf_1', scope: { merchantId: 'mer_1' }, impersonationSeconds: 600 }),
		).toBeNull();
		expect(refusal({ kind: 'demo' })).toBeNull();
		expect(refusal({ kind: 'partner', scope: { partnerId: 'par_1' } })).toBeNull();
		expect(refusal({ kind: 'developer', scope: { developerId: 'dev_1' } })).toBeNull();
		expect(refusal({ kind: 'admin', actor: 'stf_1', scope: { merchantId: 'mer_1' } }, { status: 'pending' })).toBeNull();
	});

	/** @type {Array<[any, any, ((m: any) => void) | undefined, RegExp]>} */
	const refusals = [
		[{ kind: 'nope' }, {}, undefined, /unknown launch kind/],
		[{ kind: 'demo' }, { kind: 'pack' }, undefined, /packs/],
		[{ kind: 'merchant', scope: { merchantId: 'm' } }, { status: 'pending' }, undefined, /pending/],
		[{ kind: 'merchant', scope: { merchantId: 'm' } }, { status: 'retired' }, undefined, /retired/],
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
		[{ kind: 'impersonate', scope: { merchantId: 'm' } }, {}, undefined, /staff actor/],
		[{ kind: 'impersonate', actor: 'usr_1', scope: { merchantId: 'm' } }, {}, undefined, /themselves/],
		[{ kind: 'impersonate', actor: 'stf_1' }, {}, undefined, /merchantId/],
		[
			{ kind: 'impersonate', actor: 'stf_1', scope: { merchantId: 'm' }, impersonationSeconds: 7200 },
			{},
			undefined,
			/impersonationSeconds/,
		],
		[
			{ kind: 'demo' },
			{},
			(/** @type {any} */ m) => void ((m.capabilities.sandbox = false), delete m.endpoints.demo),
			/sandbox/,
		],
		[{ kind: 'demo', scope: { merchantId: 'm' } }, {}, undefined, /must not carry/],
		[{ kind: 'partner' }, {}, undefined, /partnerId/],
		[{ kind: 'developer' }, {}, undefined, /developerId/],
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
	const signature = { kid: 'dev-1', alg: 'EdDSA', sig: 'A'.repeat(86) };

	it('parses a valid upload', () => {
		const parsed = parseBundleUpload({ descriptor: descriptor(), signature, publicJwk: { kty: 'OKP' } });
		expect(parsed.ok).toBe(true);
	});

	it('reports every shape problem', () => {
		/** @param {unknown} body */
		const paths = (body) => /** @type {any} */ (parseBundleUpload(body)).errors.map((/** @type {any} */ e) => e.path);
		expect(paths(null)).toEqual(['']);
		expect(paths({ x: 1 })).toEqual(['/x', '/descriptor', '/signature']);
		expect(
			paths({
				descriptor: { format: 'x', manifest: [], assets: [], createdAt: 'yesterday', extra: 1 },
				signature: { kid: 'bad kid', alg: 'RS256', sig: 'short' },
				publicJwk: 'jwk',
			}),
		).toEqual([
			'/descriptor/extra',
			'/descriptor/format',
			'/descriptor/manifest',
			'/descriptor/createdAt',
			'/descriptor/assets',
			'/signature/kid',
			'/signature/alg',
			'/signature/sig',
			'/publicJwk',
		]);
		const bad = descriptor();
		bad.assets = /** @type {any} */ ([
			'x',
			{ path: '../etc/passwd', sha256: 'A'.repeat(64), size: -1, contentType: 'js', more: 1 },
			{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 1 },
			{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 1 },
			{ path: '/abs.js', sha256: 'b'.repeat(64), size: 1 },
		]);
		expect(paths({ descriptor: bad, signature })).toEqual([
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

	it('signs and verifies descriptors (domain-separated, key-matched)', async () => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'dev-1' });
		const { publicJwk: other } = await generateSigningKey({ kid: 'dev-2' });
		const d = /** @type {any} */ (descriptor());
		const sig = await signBundle(createSigner(privateJwk), d);
		expect(bundleSigningInput(d)).toMatch(/^ss-pack-bundle\.v1\.[0-9a-f]{64}$/);
		expect(await verifyBundle({ descriptor: d, signature: sig, keys: [other, publicJwk] })).toBe(true);
		expect(await verifyBundle({ descriptor: { ...d, assets: [] }, signature: sig, keys: [publicJwk] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: sig, keys: [other] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: { ...sig, sig: 'AAAA' }, keys: [publicJwk] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: sig, keys: ['garbage'] })).toBe(false);
		expect(await verifyBundle({ descriptor: d, signature: { ...sig, kid: 'dev-2' }, keys: [{ ...other }] })).toBe(false);
	});
});

describe('route inputs', () => {
	/** @param {any} r */
	const errs = (r) => (r.ok ? [] : r.errors.map((/** @type {any} */ e) => e.path));
	const TOKEN = 't'.repeat(32);

	it('registration', () => {
		expect(input.parseRegistration({ baseUrl: ' https://x.example.com ', token: TOKEN })).toEqual({
			ok: true,
			value: { baseUrl: 'https://x.example.com', token: TOKEN, stagingBaseUrl: null },
		});
		expect(errs(input.parseRegistration({ token: 'short', stagingBaseUrl: 5, x: 1 }))).toEqual([
			'/x',
			'/baseUrl',
			'/token',
			'/stagingBaseUrl',
		]);
		expect(errs(input.parseRegistration('x'))).toContain('');
	});

	it('environments', () => {
		expect(input.parseEnvironments({ production: 'https://a.example.com', staging: null })).toEqual({
			ok: true,
			value: { production: 'https://a.example.com', staging: null },
		});
		expect(input.parseEnvironments({ staging: 'https://s.example.com' })).toEqual({
			ok: true,
			value: { staging: 'https://s.example.com' },
		});
		expect(errs(input.parseEnvironments({}))).toEqual(['']);
		expect(errs(input.parseEnvironments({ production: '', staging: 3 }))).toEqual(['/production', '/staging']);
	});

	it('lifecycle', () => {
		expect(input.parseLifecycle({ action: 'activate' })).toEqual({
			ok: true,
			value: { action: 'activate', sunsetAt: null, reason: null, force: false },
		});
		expect(errs(input.parseLifecycle({ action: 'deprecate' }))).toEqual(['/sunsetAt', '/reason']);
		expect(errs(input.parseLifecycle({ action: 'nuke', reason: 'x', force: 'yes' }))).toEqual(['/action', '/force']);
		expect(input.parseLifecycle({ action: 'retire', reason: 'eol', force: true })).toMatchObject({
			ok: true,
			value: { force: true },
		});
	});

	it('reason, rotate, consume', () => {
		expect(input.parseReason(undefined, { reasonRequired: false })).toEqual({ ok: true, value: { reason: null } });
		expect(errs(input.parseReason({}, { reasonRequired: true }))).toEqual(['/reason']);
		expect(errs(input.parseReason({ reason: 'x'.repeat(501) }, { reasonRequired: false }))).toEqual(['/reason']);
		expect(errs(input.parseRotate({ publicJwk: [] }))).toEqual(['/publicJwk']);
		expect(input.parseRotate({ publicJwk: { kty: 'OKP' } }).ok).toBe(true);
		expect(input.parseConsume({ jti: 'j'.repeat(22), exp: 1 })).toEqual({ ok: true, value: { jti: 'j'.repeat(22) } });
		expect(errs(input.parseConsume({ jti: 'short', exp: 'x' }))).toEqual(['/jti', '/exp']);
	});

	it('launch bodies', () => {
		expect(input.parseStaffLaunch({ kind: 'admin', merchantId: 'mer_1' })).toEqual({
			ok: true,
			value: {
				kind: 'admin',
				merchantId: 'mer_1',
				websiteId: null,
				partnerId: null,
				developerId: null,
				subject: null,
				impersonationSeconds: undefined,
				environment: 'production',
			},
		});
		expect(errs(input.parseStaffLaunch({ impersonationSeconds: 1.5, environment: 'qa' }))).toEqual([
			'/kind',
			'/impersonationSeconds',
			'/environment',
		]);
		expect(input.parseMerchantLaunch(undefined)).toEqual({ ok: true, value: { websiteId: null } });
		expect(errs(input.parseMerchantLaunch({ websiteId: 1 }))).toEqual(['/websiteId']);
	});
});
