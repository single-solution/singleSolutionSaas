/**
 * `ss.dev.json` fixture: fake merchants, websites and subscriptions the emulator serves. Every field is optional; the
 * defaults give one merchant with one test website subscribed on the first plan of the product.
 * @module
 */
import { isId } from '@ss/contracts';
import { isObject } from '../fsutil.js';

/**
 * @typedef {object} FixtureMerchant
 * @property {string} id
 * @property {string} name
 * @property {number} balance credits
 */
/**
 * @typedef {object} FixtureWebsite
 * @property {string} id
 * @property {string} merchantId
 * @property {string} domain
 * @property {'live' | 'test'} env
 * @property {boolean} allowSubdomains
 * @property {Record<string, string>} resources resource kind → status (`connected` | `missing` | …)
 */
/**
 * @typedef {object} FixtureSubscription
 * @property {string} id
 * @property {string} websiteId
 * @property {string | null | undefined} plan plan code; `undefined` = the product's first plan, `null` = no plan
 * @property {'active' | 'trialing' | 'paused' | 'suspended' | 'cancelled'} status
 * @property {string | null} product product slug, or null for "whatever product is registered"
 * @property {string} [priceBookVersion]
 * @property {string} [startedAt]
 * @property {Record<string, any>} layers `{ platform?, merchant?, website?, admin? }` resolver layers
 * @property {Record<string, any>} runtime extra resolver runtime input (rollouts, experiments, usage…)
 */
/**
 * @typedef {object} Fixture
 * @property {{ url: string }} portal
 * @property {{ url: string | null }} product
 * @property {FixtureMerchant[]} merchants
 * @property {FixtureWebsite[]} websites
 * @property {FixtureSubscription[]} subscriptions
 * @property {{ staff: string, partner: string, developer: string }} ids users used by launches
 */

export const DEFAULT_PORTAL_URL = 'http://localhost:4400';
export const DEFAULT_PRODUCT_URL = 'http://localhost:3000';

const STATUSES = new Set(['active', 'trialing', 'paused', 'suspended', 'cancelled']);

/**
 * @param {string} message
 * @returns {Error & { code: string }}
 */
const fixtureError = (message) => Object.assign(new Error(`ss.dev.json: ${message}`), { code: 'invalid_fixture' });

/**
 * @param {unknown} value
 * @param {string} prefix
 * @param {string} where
 * @returns {string}
 */
const idOf = (value, prefix, where) => {
	if (typeof value !== 'string' || !isId(value, prefix))
		throw fixtureError(`${where} must be an id like ${prefix}_devexample01`);
	return value;
};

/**
 * Normalise a fixture (applying defaults) and check references.
 * @param {unknown} input parsed ss.dev.json (or undefined)
 * @returns {Fixture}
 */
export const normaliseFixture = (input = {}) => {
	if (!isObject(input)) throw fixtureError('must be a JSON object');
	const portalUrl = isObject(input.portal) && typeof input.portal.url === 'string' ? input.portal.url : DEFAULT_PORTAL_URL;
	const productUrl = isObject(input.product) && typeof input.product.url === 'string' ? input.product.url : null;
	const merchantsIn = Array.isArray(input.merchants)
		? input.merchants
		: [{ id: 'mer_devmerchant01', name: 'Dev Merchant', balance: 100000 }];
	const merchants = merchantsIn.map((raw, index) => {
		const merchant = isObject(raw) ? raw : {};
		return {
			id: idOf(merchant.id, 'mer', `merchants[${index}].id`),
			name: typeof merchant.name === 'string' ? merchant.name : `Merchant ${index + 1}`,
			balance: typeof merchant.balance === 'number' && Number.isFinite(merchant.balance) ? merchant.balance : 100000,
		};
	});
	const firstMerchant = merchants[0]?.id;
	const websitesIn = Array.isArray(input.websites)
		? input.websites
		: [{ id: 'web_devwebsite01', merchantId: firstMerchant, domain: 'shop.example.com', env: 'test', allowSubdomains: true }];
	const websites = websitesIn.map((raw, index) => {
		const website = isObject(raw) ? raw : {};
		const merchantId = idOf(website.merchantId ?? firstMerchant, 'mer', `websites[${index}].merchantId`);
		if (!merchants.some((merchant) => merchant.id === merchantId))
			throw fixtureError(`websites[${index}] references unknown merchant ${merchantId}`);
		if (typeof website.domain !== 'string' || website.domain.length === 0)
			throw fixtureError(`websites[${index}].domain is required`);
		/** @type {Record<string, string>} */
		const resources = { database: 'connected' };
		if (isObject(website.resources))
			for (const [kind, status] of Object.entries(website.resources)) resources[kind] = String(status);
		return {
			id: idOf(website.id, 'web', `websites[${index}].id`),
			merchantId,
			domain: website.domain.toLowerCase(),
			env: /** @type {'live' | 'test'} */ (website.env === 'live' ? 'live' : 'test'),
			allowSubdomains: website.allowSubdomains === true,
			resources,
		};
	});
	const subscriptionsIn = Array.isArray(input.subscriptions)
		? input.subscriptions
		: websites.map((website, index) => ({
				id: `sub_devsubscript${String(index + 1).padStart(2, '0')}`,
				websiteId: website.id,
			}));
	const subscriptions = subscriptionsIn.map((raw, index) => {
		const subscription = isObject(raw) ? raw : {};
		const websiteId = idOf(subscription.websiteId, 'web', `subscriptions[${index}].websiteId`);
		if (!websites.some((website) => website.id === websiteId))
			throw fixtureError(`subscriptions[${index}] references unknown website ${websiteId}`);
		const status = typeof subscription.status === 'string' ? subscription.status : 'active';
		if (!STATUSES.has(status)) throw fixtureError(`subscriptions[${index}].status must be one of ${[...STATUSES].join(', ')}`);
		return {
			id: idOf(subscription.id, 'sub', `subscriptions[${index}].id`),
			websiteId,
			plan: typeof subscription.plan === 'string' ? subscription.plan : subscription.plan === null ? null : undefined,
			status: /** @type {FixtureSubscription['status']} */ (status),
			product: typeof subscription.product === 'string' ? subscription.product : null,
			...(typeof subscription.priceBookVersion === 'string' ? { priceBookVersion: subscription.priceBookVersion } : {}),
			...(typeof subscription.startedAt === 'string' ? { startedAt: subscription.startedAt } : {}),
			layers: isObject(subscription.layers) ? subscription.layers : {},
			runtime: isObject(subscription.runtime) ? subscription.runtime : {},
		};
	});
	const ids = isObject(input.ids) ? input.ids : {};
	return {
		portal: { url: portalUrl },
		product: { url: productUrl },
		merchants,
		websites,
		subscriptions,
		ids: {
			staff: typeof ids.staff === 'string' ? ids.staff : 'usr_devstaff01',
			partner: typeof ids.partner === 'string' ? ids.partner : 'par_devpartner01',
			developer: typeof ids.developer === 'string' ? ids.developer : 'dev_devdeveloper01',
		},
	};
};
