/**
 * Fake modules implementing the INTERFACES.md functions commerce depends on (identity and catalog). State lives in a
 * mutable `world` the tests change directly.
 */
import { createKeyResolver } from '@ss/protocol';
import { testSessionActor } from '../../../helpers.js';
import { problem } from '../../../../src/infra/http.js';
import { defineModule } from '../../../../src/infra/modules.js';

/**
 * @typedef {object} World
 * @property {Map<string, { merchantId: string, name: string, status: 'active' | 'suspended' | 'deleted' }>} merchants
 * @property {Map<string, { websiteId: string, merchantId: string, domain: string, status: string }>} websites
 * @property {Map<string, { productId: string, name: string, status: 'active' | 'inactive' }>} products
 * @property {Map<string, { adminId: string, name: string, role: string, status: string }>} admins
 * @property {Map<string, unknown>} productJwks by productId
 * @property {Array<{ productId: string, body: Record<string, unknown> }>} notices
 * @property {Array<{ merchantId: string, websiteId: string, productId: string }>} tokens tokens ensured
 * @property {boolean} failNotices
 */

/** @returns {World} */
export const createWorld = () => ({
	merchants: new Map(),
	websites: new Map(),
	products: new Map(),
	admins: new Map(),
	productJwks: new Map(),
	notices: [],
	tokens: [],
	failNotices: false,
});

/**
 * @param {World} world
 */
export const fakeModules = (world) => [
	defineModule({
		name: 'identity',
		ports: () => ({ sessionActor: testSessionActor }),
		service: () => ({
			getMerchant: async (/** @type {string} */ id) =>
				world.merchants.get(id) ?? Promise.reject(problem('not_found', 'No such merchant.')),
			getMerchantRecord: async (/** @type {string} */ id) =>
				world.merchants.get(id) ?? Promise.reject(problem('not_found', 'No such merchant.')),
			getWebsite: async (/** @type {string} */ id) =>
				world.websites.get(id) ?? Promise.reject(problem('not_found', 'No such website.')),
			websitesByIds: async (/** @type {readonly string[]} */ ids) =>
				new Map(ids.filter((id) => world.websites.has(id)).map((id) => [id, world.websites.get(id)])),
			merchantNames: async (/** @type {readonly string[]} */ ids) =>
				new Map(
					ids
						.filter((id) => world.merchants.has(id))
						.map((id) => {
							const m = /** @type {any} */ (world.merchants.get(id));
							return [id, { name: m.name, deleted: m.status === 'deleted' }];
						}),
				),
			billingContacts: async (/** @type {string} */ merchantId) => ({
				merchantName: world.merchants.get(merchantId)?.name ?? merchantId,
				merchantEmail: `owner@${merchantId}.example`,
				adminEmails: ['finance@portal.example'],
			}),
			dashboardAdmin: async (/** @type {unknown} */ adminId) => {
				const admin = world.admins.get(String(adminId));
				if (!admin || admin.status !== 'active') throw problem('validation_failed', 'adminId is not a current admin.');
				if (admin.role !== 'owner' && admin.role !== 'support') throw problem('forbidden', 'Only Owner and Support.');
				return { adminId: admin.adminId, name: admin.name, role: admin.role };
			},
			ensureTokens: async (/** @type {{ merchantId: string, websiteId: string, productId: string }} */ input) => {
				world.tokens.push(input);
				return { created: true };
			},
		}),
	}),
	defineModule({
		name: 'catalog',
		service: () => ({
			getProduct: async (/** @type {string} */ productId) => {
				const product = world.products.get(productId);
				if (!product) throw problem('not_found', 'No such product.');
				return { ...product };
			},
			isActive: async (/** @type {string} */ productId) => world.products.get(productId)?.status === 'active',
			notify: async (/** @type {string} */ productId, /** @type {Record<string, unknown>} */ body) => {
				if (world.failNotices) throw new Error('catalog is down');
				world.notices.push({ productId, body });
			},
		}),
		ports: () => ({
			productKeys: (/** @type {string} */ productId) => {
				const jwks = world.productJwks.get(productId);
				return jwks ? createKeyResolver({ jwks: /** @type {any} */ (jwks) }) : null;
			},
		}),
	}),
];
