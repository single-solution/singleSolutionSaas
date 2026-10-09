/**
 * Test harness of the Portal: the real modules (system, catalog, identity, commerce) on the shared
 * MongoMemoryReplSet, driven through the HTTP API with `@ss/platform/testing`'s `createPortalClient`, fake products on
 * local HTTP servers (`fakes/product.js`), and helpers that create people and websites the way PLAN 0.2 says. Work after
 * responses (notices, e-mails) runs before each call returns.
 * @module
 */
import { createKeyResolver, consumeWith, createMemoryReplayStore, verifyLaunch } from '@ss/protocol';
import { createPortalClient } from '../../../src/infra/client.js';
import { createSystemStore } from '../../../src/infra/system.js';
import { createCatalogModule } from '../../../src/modules/catalog/index.js';
import { commerceModule } from '../../../src/modules/commerce/index.js';
import { createIdentityModule } from '../../../src/modules/identity/index.js';
import { systemModule } from '../../../src/modules/system/index.js';
import { createPortal } from '../../../src/portal.js';
import { ENCRYPTION_KEY, PORTAL_URL, T0, createClock, createTestLogger, testConfig } from '../../helpers.js';
import { memoryMailer } from '../identity/fakes/modules.js';
import { startFakeProduct } from './fakes/product.js';

export { PORTAL_URL };
export const PASSWORD = 'correct horse battery';

/**
 * @param {{ db: import('mongodb').Db, clock?: ReturnType<typeof createClock>, settings?: Record<string, any>,
 *   allowHosts?: string[], env?: Record<string, string> }} options `env`: environment overrides (another
 *   `ENCRYPTION_KEY`); a second Portal on the same database signs its Owner in instead of creating one
 */
export const bootPortal = async ({ db, clock = createClock(T0), settings, allowHosts = ['127.0.0.1'], env = {} }) => {
	const mailer = memoryMailer();
	const config = await testConfig(env, settings ? { settings } : {});
	const { logger, entries } = createTestLogger();
	/** @type {Promise<unknown>[]} */
	const pending = [];
	const portal = createPortal({
		config,
		db,
		modules: [systemModule, createCatalogModule({ allowHosts }), createIdentityModule({ mailer }), commerceModule],
		logger,
		now: clock.now,
		system: createSystemStore(db, { encryptionKey: env.ENCRYPTION_KEY ?? ENCRYPTION_KEY, now: clock.now }),
		background: { mode: 'on', fallback: (task) => void pending.push(Promise.resolve().then(task)) },
	});
	await portal.ensureIndexes();
	const settle = async () => {
		while (pending.length > 0) await Promise.all(pending.splice(0));
	};
	const api = createPortalClient({ handle: portal.handle, portalUrl: PORTAL_URL, settle });
	/** @type {Array<Awaited<ReturnType<typeof startFakeProduct>>>} */
	const products = [];

	/** @type {ReturnType<typeof api.session> | null} */
	let first = null;
	/** The first admin (an Owner), created from the sign-in page on first use. */
	const owner = async () => {
		if (!first) {
			const open = await api.call('GET', '/v1/auth/first-admin');
			first = open.json?.available
				? await api.firstAdmin({ name: 'Olivia Owner', email: 'owner@portal.test', password: PASSWORD })
				: await api.signIn('owner@portal.test', PASSWORD);
		}
		return first;
	};

	let counter = 0;
	/**
	 * An admin of a role, invited by the first Owner, who accepted the invite.
	 * @param {'owner' | 'support' | 'finance'} role
	 */
	const admin = async (role) => {
		counter += 1;
		const email = `${role}-${counter}@portal.test`;
		const invited = await (await owner()).post('/v1/admin/admins', { email, role });
		if (invited.status !== 201) throw new Error(`invite ${invited.status} ${JSON.stringify(invited.json)}`);
		const accepted = await api.call('POST', '/v1/auth/set-password', {
			body: { token: mailer.token(email, 'admin_invite'), password: PASSWORD, name: `${role} admin` },
		});
		if (accepted.status !== 200) throw new Error(`accept ${accepted.status} ${JSON.stringify(accepted.json)}`);
		return { client: await api.signIn(email, PASSWORD), adminId: String(invited.json.admin.adminId), email };
	};

	/**
	 * A merchant with its password set and one website per domain (added by the Owner).
	 * @param {string} email
	 * @param {string[]} [domains]
	 */
	const merchant = async (email, domains = []) => {
		const by = await owner();
		const created = await by.post('/v1/admin/merchants', { name: `Shop ${email}`, ownerName: 'Sam Seller', email });
		if (created.status !== 201) throw new Error(`merchant ${created.status} ${JSON.stringify(created.json)}`);
		const merchantId = String(created.json.merchant.merchantId);
		await api.call('POST', '/v1/auth/set-password', {
			body: { token: mailer.token(email, 'merchant_setup'), password: PASSWORD },
		});
		/** @type {string[]} */
		const websiteIds = [];
		for (const domain of domains) {
			const site = await by.post(`/v1/merchants/${merchantId}/websites`, { domain });
			if (site.status !== 201) throw new Error(`website ${site.status} ${JSON.stringify(site.json)}`);
			websiteIds.push(String(site.json.website.websiteId));
		}
		return { client: await api.signIn(email, PASSWORD), merchantId, websiteIds, email, name: `Shop ${email}` };
	};

	/**
	 * Start a fake product and connect it (Add product) as the Owner; active unless told otherwise.
	 * @param {any} manifest
	 * @param {{ active?: boolean }} [options]
	 */
	const connect = async (manifest, { active = true } = {}) => {
		const product = await startFakeProduct({ manifest, portalUrl: PORTAL_URL, now: clock.now });
		products.push(product);
		const res = await (await owner()).post('/v1/admin/products', { url: product.url, secret: product.secret });
		if (res.status !== 201) throw new Error(`connect ${res.status} ${JSON.stringify(res.json)}`);
		if (active) await (await owner()).post(`/v1/admin/products/${product.productId}/status`, { status: 'active' });
		return product;
	};

	/**
	 * A product's own call to a `/v1/product/*` route (client assertion).
	 * @param {Awaited<ReturnType<typeof startFakeProduct>>} product
	 * @param {string} method @param {string} path @param {unknown} [body]
	 */
	const productCall = async (product, method, path, body) =>
		api.call(method, path, { bearer: await product.assertion(), ...(body === undefined ? {} : { body }) });

	/**
	 * Verify a launch as the product would (single use is the product's own replay store).
	 * @param {string} url the launch URL
	 * @param {string} productId
	 */
	const verify = (url, productId) =>
		verifyLaunch({
			token: decodeURIComponent(String(new URL(url).searchParams.get('launch'))),
			keyResolver: createKeyResolver({ jwks: portal.shared.keys.jwks() }),
			audience: productId,
			issuer: PORTAL_URL,
			consume: consumeWith(createMemoryReplayStore({ now: clock.now })),
			now: clock.now,
		});

	/** Activity entries (newest first) of an action. @param {string} action */
	const activity = (action) => db.collection('platform_audit').find({ action }).sort({ at: -1, _id: -1 }).toArray();

	return {
		portal,
		db,
		clock,
		mailer,
		entries,
		api,
		settle,
		owner,
		admin,
		merchant,
		connect,
		productCall,
		verify,
		activity,
		close: async () => {
			for (const product of products.splice(0)) await product.close();
		},
	};
};

/**
 * @param {{ status: number, json: any }} res
 * @returns {[number, string]}
 */
export const codeOf = (res) => [
	res.status,
	String(res.json?.type ?? '')
		.split('/')
		.pop() ?? '',
];
