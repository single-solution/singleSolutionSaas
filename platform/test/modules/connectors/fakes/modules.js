/**
 * Small fakes of the modules `connectors` depends on (INTERFACES.md): identity.getWebsite, commerce
 * subscriptionsForWebsite/invalidate, catalog getManifest + the appKeys port, integration emitControl.
 */
import { createKeyResolver } from '@ss/protocol';
import { defineModule } from '../../../../src/infra/modules.js';
import { problem } from '../../../../src/infra/http.js';

/**
 * @param {{
 *   websites: Map<string, { websiteId: string, merchantId: string }>,
 *   subscriptions: Map<string, Array<{ subscriptionId: string, appId: string, websiteId: string, status: string }>>,
 *   manifests: Map<string, unknown>,
 *   appJwks: Map<string, any>,
 *   emitted: Array<{ type: string, data: any, options: any }>,
 *   invalidated: string[],
 *   failEmit?: { value: boolean },
 * }} state
 */
export const fakeModules = (state) => [
	defineModule({
		name: 'identity',
		service: () => ({
			getWebsite: async (/** @type {string} */ websiteId) => {
				const w = state.websites.get(websiteId);
				if (!w) throw problem('not_found', 'No such website.');
				return {
					...w,
					domain: `${websiteId}.example.com`,
					env: 'live',
					twinId: null,
					status: 'active',
					createdAt: new Date(),
				};
			},
		}),
	}),
	defineModule({
		name: 'commerce',
		service: () => ({
			subscriptionsForWebsite: async (/** @type {string} */ websiteId) => state.subscriptions.get(websiteId) ?? [],
			invalidate: async (/** @type {string} */ subscriptionId) => {
				state.invalidated.push(subscriptionId);
			},
		}),
	}),
	defineModule({
		name: 'catalog',
		service: () => ({
			getManifest: async (/** @type {string} */ appId) => {
				const m = state.manifests.get(appId);
				if (!m) throw problem('not_found', 'No such app.');
				return m;
			},
		}),
		ports: () => ({
			appKeys: (/** @type {string} */ appId) => {
				const jwks = state.appJwks.get(appId);
				return jwks ? createKeyResolver({ jwks }) : null;
			},
		}),
	}),
	defineModule({
		name: 'integration',
		service: () => ({
			emitControl: async (/** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ options) => {
				if (state.failEmit?.value) throw new Error('hub down');
				state.emitted.push({ type, data, options });
			},
		}),
	}),
];
