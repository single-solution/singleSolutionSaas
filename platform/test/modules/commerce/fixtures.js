/**
 * Commerce test fixtures: ids, a Coupons-like manifest with plans, metered units and quotas, and a portal harness on
 * MongoMemoryReplSet with fake neighbour modules.
 */
import { createSigner, createJwks, generateSigningKey, signAssertion } from '@ss/protocol';
import { createPortal } from '../../../src/portal.js';
import { commerceModule } from '../../../src/modules/commerce/index.js';
import { PORTAL_URL, T0, createClock, createTestLogger, testConfig } from '../../helpers.js';
import { createWorld, fakeModules } from './fakes/modules.js';

export const M1 = 'mer_0123456789abcdefghjkmnpq';
export const M2 = 'mer_1123456789abcdefghjkmnpq';
export const W1 = 'web_0123456789abcdefghjkmnpq';
export const W2 = 'web_1123456789abcdefghjkmnpq';
export const W3 = 'web_2123456789abcdefghjkmnpq';
export const APP = 'app_0123456789abcdefghjkmnpq';
export const APP2 = 'app_1123456789abcdefghjkmnpq';
export const HOUR = 3_600_000;
export const STAFF = Object.freeze({ type: 'admin', id: 'adm_finance', role: 'finance' });
export const ORIGIN_HEADERS = Object.freeze({ origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' });

/**
 * A Coupons-like manifest. Prices (millicredits/hour): codes 1000, apply_box 500, reports 250, ai_copy 2000;
 * redemptions cost 10 each above the plan's included amount (starter 5, pro 100 per month).
 * @param {{ version?: string, priceBook?: string, effectiveFrom?: string, codesHourly?: number, redemptionPrice?: number }} [options]
 */
export const couponsManifest = ({
	version = '1.0.0',
	priceBook = '2026-01',
	effectiveFrom = '2026-01-01T00:00:00Z',
	codesHourly = 1000,
	redemptionPrice = 10,
} = {}) => ({
	ssps: 1,
	product: { slug: 'coupon-box', name: 'Coupons', kind: 'service', version, category: 'commerce' },
	elements: [
		{
			key: 'codes',
			name: 'Codes',
			modes: ['C'],
			price: {
				hourly: codesHourly,
				metered: [{ unit: 'redemption', perUnit: redemptionPrice, included: { starter: 5, pro: 100 } }],
			},
			features: {
				type: 'object',
				properties: {
					redemptions: {
						type: 'integer',
						title: 'Redemptions per month',
						default: 1000,
						'x-kind': 'quota',
						'x-period': 'month',
						'x-unit': 'redemption',
						'x-plan': { starter: { default: 20 } },
					},
				},
			},
		},
		{ key: 'apply_box', name: 'Apply box', modes: ['C'], price: { hourly: 500 }, dependsOn: ['codes'] },
		{
			key: 'reports',
			name: 'Reports',
			modes: ['C'],
			price: { hourly: 250 },
			dependsOn: ['apply_box'],
			requires: { resources: ['database'] },
		},
		{ key: 'ai_copy', name: 'AI copy', modes: ['C'], price: { hourly: 2000 }, requires: { resources: ['ai'] } },
	],
	plans: [
		{ code: 'starter', name: 'Starter', elements: ['codes', 'apply_box'], addons: ['reports'] },
		{ code: 'pro', name: 'Pro', elements: ['codes', 'apply_box', 'reports', 'ai_copy'] },
	],
	priceBook: { version: priceBook, effectiveFrom },
});

/** A second, free product (0 per hour) with a single element. */
export const freeManifest = () => ({
	ssps: 1,
	product: { slug: 'notice', name: 'Notice', kind: 'pack', version: '1.0.0', category: 'content' },
	elements: [{ key: 'bar', name: 'Bar', modes: ['A'], price: { hourly: 0 } }],
	priceBook: { version: 'v1', effectiveFrom: '2026-01-01T00:00:00Z' },
});

/**
 * @param {import('./fakes/modules.js').World} world
 */
export const seedWorld = (world) => {
	const created = new Date(T0 - 30 * 86_400_000).toISOString();
	world.merchants.set(M1, { merchantId: M1, name: 'One', status: 'active', createdAt: created });
	world.merchants.set(M2, { merchantId: M2, name: 'Two', status: 'active', createdAt: created });
	world.websites.set(W1, {
		websiteId: W1,
		merchantId: M1,
		domain: 'shop.example.com',
		env: 'live',
		twinId: null,
		status: 'active',
		createdAt: created,
	});
	world.websites.set(W2, {
		websiteId: W2,
		merchantId: M1,
		domain: 'blog.example.com',
		env: 'live',
		twinId: null,
		status: 'active',
		createdAt: created,
	});
	world.websites.set(W3, {
		websiteId: W3,
		merchantId: M2,
		domain: 'two.example.org',
		env: 'test',
		twinId: null,
		status: 'active',
		createdAt: created,
	});
	world.apps.set(APP, {
		app: { appId: APP, slug: 'coupon-box', kind: 'service', status: 'active', endpoints: null, currentVersion: 1 },
		versions: new Map([[1, couponsManifest()]]),
	});
	world.apps.set(APP2, {
		app: { appId: APP2, slug: 'notice', kind: 'pack', status: 'active', endpoints: null, currentVersion: 1 },
		versions: new Map([[1, freeManifest()]]),
	});
	world.resources.set(W1, [
		{ kind: 'database', ref: 'con_db1', status: 'connected' },
		{ kind: 'ai', status: 'missing' },
	]);
};

/**
 * Boot a Portal with commerce and the fakes.
 * @param {{ mongo: { db: (name: string) => import('mongodb').Db }, dbName: string, clock?: ReturnType<typeof createClock>,
 *   options?: Parameters<typeof fakeModules>[1] }} input
 */
export const bootCommerce = async ({ mongo, dbName, clock = createClock(T0), options }) => {
	const world = createWorld();
	seedWorld(world);
	const config = await testConfig();
	const { logger, entries } = createTestLogger();
	const db = mongo.db(dbName);
	/** @type {{ to: string, template: string, data: Record<string, string> }[]} */
	const mails = [];
	const mailer = { available: true, send: async (/** @type {any} */ message) => void mails.push(message) };
	const portal = createPortal({
		config,
		db,
		modules: [commerceModule, ...fakeModules(world, options)],
		logger,
		now: clock.now,
		mailer: /** @type {any} */ (mailer),
	});
	await portal.ensureIndexes();
	/** @type {import('../../../src/modules/commerce/service.js').CommerceService} */
	const service = /** @type {any} */ (portal.modules.service('commerce'));

	/**
	 * @param {string} method @param {string} path @param {{ headers?: Record<string, string>, body?: unknown }} [init]
	 */
	const call = async (method, path, { headers = {}, body } = {}) => {
		const response = await portal.handle(
			new Request(`${PORTAL_URL}${path}`, {
				method,
				headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
	};

	/** @param {import('../../../src/infra/auth.js').SessionInput} input */
	const login = async (input) => {
		const { token } = await portal.shared.sessions.create(input);
		return { cookie: `${portal.shared.cookies.name(input.kind)}=${token}`, ...ORIGIN_HEADERS };
	};

	/**
	 * Register product keys for an app; returns a function producing fresh assertion headers.
	 * @param {string} appId
	 */
	const productAuth = async (appId) => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: `${appId}-k1` });
		world.appJwks.set(appId, createJwks([publicJwk]));
		const signer = createSigner(privateJwk);
		return async () => ({
			authorization: `Bearer ${await signAssertion({ signer, appId, audience: PORTAL_URL, now: clock.now })}`,
		});
	};

	/** @param {string} merchantId @param {number} amount millicredits (whole credits) @param {string | null} [reference] */
	const credit = (merchantId, amount, reference = null) =>
		service.addReceipt({ merchantId, amount, amountPaid: 'PKR 1,000', method: 'Bank transfer', reference, actor: STAFF });

	return {
		portal,
		world,
		service,
		call,
		login,
		productAuth,
		credit,
		clock,
		db,
		mails,
		logs: entries,
		ctx: portal.modules.context('commerce'),
	};
};
