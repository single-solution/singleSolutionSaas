/**
 * Commerce test fixtures: ids, price lists, and a Portal harness on MongoMemoryReplSet with fake neighbour modules.
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
export const PRODUCT = 'ecommerce';
export const PRODUCT2 = 'notice';
export const OWNER_ADMIN = 'adm_0wner0000000000000000000';
export const SUPPORT_ADMIN = 'adm_support000000000000000000';
export const FINANCE_ADMIN = 'adm_finance000000000000000000';
export const HOUR = 3_600_000;
export const STAFF = Object.freeze({ type: 'admin', id: 'adm_finance', role: 'finance' });
const ORIGIN_HEADERS = Object.freeze({ origin: PORTAL_URL, 'sec-fetch-site': 'same-origin' });

/**
 * A price list (PLAN 0.4.12 row 2) from `{ key: millicreditsPerHour }`; `box` depends on `codes`.
 * @param {number} version
 * @param {Record<string, number>} prices
 */
export const priceList = (version, prices) => ({
	version,
	features: Object.entries(prices).map(([key, millicreditsPerHour]) => ({
		key,
		name: key === 'codes' ? 'Codes' : key === 'box' ? 'Apply box' : key,
		description: `The ${key} feature.`,
		dependsOn: key === 'box' ? ['codes'] : [],
		millicreditsPerHour,
	})),
});

/**
 * @param {import('./fakes/modules.js').World} world
 */
const seedWorld = (world) => {
	world.merchants.set(M1, { merchantId: M1, name: 'One', status: 'active' });
	world.merchants.set(M2, { merchantId: M2, name: 'Two', status: 'active' });
	world.websites.set(W1, { websiteId: W1, merchantId: M1, domain: 'shop.example.com', status: 'active' });
	world.websites.set(W2, { websiteId: W2, merchantId: M1, domain: 'blog.example.com', status: 'active' });
	world.websites.set(W3, { websiteId: W3, merchantId: M2, domain: 'two.example.org', status: 'active' });
	world.products.set(PRODUCT, { productId: PRODUCT, name: 'Ecommerce', status: 'active' });
	world.products.set(PRODUCT2, { productId: PRODUCT2, name: 'Notice', status: 'active' });
	world.admins.set(OWNER_ADMIN, { adminId: OWNER_ADMIN, name: 'Olivia', role: 'owner', status: 'active' });
	world.admins.set(SUPPORT_ADMIN, { adminId: SUPPORT_ADMIN, name: 'Sam', role: 'support', status: 'active' });
	world.admins.set(FINANCE_ADMIN, { adminId: FINANCE_ADMIN, name: 'Fay', role: 'finance', status: 'active' });
};

/**
 * Boot a Portal with commerce and the fakes.
 * @param {{ mongo: { db: (name: string) => import('mongodb').Db }, dbName: string, clock?: ReturnType<typeof createClock> }} input
 */
export const bootCommerce = async ({ mongo, dbName, clock = createClock(T0) }) => {
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
		modules: [commerceModule, ...fakeModules(world)],
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
	 * Register a product's key; returns a function producing fresh assertion headers.
	 * @param {string} productId
	 */
	const productAuth = async (productId) => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: `${productId}-k1` });
		world.productJwks.set(productId, createJwks([publicJwk]));
		const signer = createSigner(privateJwk);
		return async () => ({
			authorization: `Bearer ${await signAssertion({ signer, productId, audience: PORTAL_URL, now: clock.now })}`,
		});
	};

	/**
	 * Accept a price list for a product.
	 * @param {string} productId @param {number} version @param {Record<string, number>} prices
	 */
	const prices = (productId, version, prices) => service.recordPriceList({ productId, prices: priceList(version, prices) });

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
		prices,
		credit,
		clock,
		db,
		mails,
		logs: entries,
		ctx: portal.modules.context('commerce'),
	};
};
