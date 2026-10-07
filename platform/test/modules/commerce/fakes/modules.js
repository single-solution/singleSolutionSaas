/**
 * Fake modules implementing the INTERFACES.md functions commerce depends on (identity, catalog, config, connectors,
 * integration). State lives in a mutable `world` the tests change directly.
 */
import { testSessionActor } from '../../../helpers.js';
import { createKeyResolver } from '@ss/protocol';
import { problem } from '../../../../src/infra/http.js';
import { defineModule } from '../../../../src/infra/modules.js';

/**
 * @typedef {object} World
 * @property {Map<string, { merchantId: string, name: string, status: 'active' | 'suspended', createdAt: string }>} merchants
 * @property {Map<string, { websiteId: string, merchantId: string, domain: string, env: 'live' | 'test', twinId: string | null, status: string, createdAt: string, timeZone?: string, allowSubdomains?: boolean }>} websites
 * @property {Map<string, { app: Record<string, any>, versions: Map<number, Record<string, any>> }>} apps
 * @property {Map<string, Record<string, any>>} layers by subscriptionId
 * @property {Map<string, { kind: string, ref?: string, status: string }[]>} resources by websiteId
 * @property {{ type: string, data: Record<string, any>, target: Record<string, any> }[]} events
 * @property {Map<string, unknown>} appJwks by appId
 * @property {{ layersFor: number, statusFor: number, lastHint?: unknown }} calls
 * @property {boolean} failEmit
 * @property {Map<string, Record<string, any>>} identities identity-issuer document sections by websiteId
 */

/** @returns {World} */
export const createWorld = () => ({
	merchants: new Map(),
	websites: new Map(),
	apps: new Map(),
	layers: new Map(),
	resources: new Map(),
	events: [],
	appJwks: new Map(),
	calls: { layersFor: 0, statusFor: 0 },
	failEmit: false,
	identities: new Map(),
});

/**
 * @param {World} world
 * @param {{ withConfig?: boolean, withConnectors?: boolean, withIntegration?: boolean }} [options]
 */
export const fakeModules = (world, { withConfig = true, withConnectors = true, withIntegration = true } = {}) => [
	defineModule({
		name: 'identity',
		ports: () => ({ sessionActor: testSessionActor }),
		service: () => ({
			getMerchant: async (/** @type {string} */ id) =>
				world.merchants.get(id) ?? Promise.reject(problem('not_found', 'No such merchant.')),
			getWebsite: async (/** @type {string} */ id) =>
				world.websites.get(id) ?? Promise.reject(problem('not_found', 'No such website.')),
			listWebsites: async (/** @type {string} */ merchantId) =>
				[...world.websites.values()].filter((w) => w.merchantId === merchantId),
			identityFor: async (/** @type {string} */ websiteId) => structuredClone(world.identities.get(websiteId) ?? null),
			merchantNames: async (/** @type {readonly string[]} */ ids) =>
				new Map(
					ids
						.filter((id) => world.merchants.has(id))
						.map((id) => [id, { name: /** @type {any} */ (world.merchants.get(id)).name, deleted: false }]),
				),
			billingContacts: async (/** @type {string} */ merchantId) => ({
				merchantName: world.merchants.get(merchantId)?.name ?? merchantId,
				merchantEmail: `owner@${merchantId}.example`,
				adminEmails: ['finance@portal.example'],
			}),
		}),
	}),
	defineModule({
		name: 'catalog',
		service: () => ({
			getApp: async (/** @type {string} */ appId) => {
				const entry = world.apps.get(appId);
				if (!entry) throw problem('not_found', 'No such app.');
				return { ...entry.app };
			},
			getManifest: async (/** @type {string} */ appId, /** @type {number | undefined} */ version) => {
				const entry = world.apps.get(appId);
				if (!entry) throw problem('not_found', 'No such app.');
				const manifest = entry.versions.get(version ?? entry.app.currentVersion);
				if (!manifest) throw problem('not_found', 'No such version.');
				return structuredClone(manifest);
			},
		}),
		ports: () => ({
			appKeys: (/** @type {string} */ appId) => {
				const jwks = world.appJwks.get(appId);
				return jwks ? createKeyResolver({ jwks: /** @type {any} */ (jwks) }) : null;
			},
		}),
	}),
	...(withConfig
		? [
				defineModule({
					name: 'config',
					service: () => ({
						layersFor: async (/** @type {string} */ subscriptionId, /** @type {unknown} */ hint) => {
							world.calls.layersFor += 1;
							world.calls.lastHint = hint;
							return structuredClone(world.layers.get(subscriptionId) ?? {});
						},
					}),
				}),
			]
		: []),
	...(withConnectors
		? [
				defineModule({
					name: 'connectors',
					service: () => ({
						statusFor: async (/** @type {string} */ websiteId) => {
							world.calls.statusFor += 1;
							return structuredClone(world.resources.get(websiteId) ?? []);
						},
					}),
				}),
			]
		: []),
	...(withIntegration
		? [
				defineModule({
					name: 'integration',
					service: () => ({
						emitControl: async (/** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ target) => {
							if (world.failEmit) throw new Error('delivery down');
							world.events.push({ type, data, target });
						},
					}),
				}),
			]
		: []),
];
