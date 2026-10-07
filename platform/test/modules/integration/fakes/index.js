/**
 * Fake identity, catalog and commerce modules implementing the INTERFACES.md functions the integration module uses.
 */
import { testSessionActor } from '../../../helpers.js';
import { createKeyResolver } from '@ss/protocol';
import { problem } from '../../../../src/infra/http.js';
import { defineModule } from '../../../../src/infra/modules.js';

/**
 * @typedef {{ websiteId: string, merchantId: string, domain: string, env: 'live' | 'test', status: string }} FakeWebsite
 * @typedef {{ appId: string, slug: string, kind: 'service' | 'pack', status: string, endpoints: Record<string, string> | null,
 *   baseUrl: string | null }} FakeApp
 */

export const createWorld = () => {
	const state = {
		/** @type {Map<string, FakeWebsite>} */
		websites: new Map(),
		/** @type {Map<string, FakeApp>} */
		apps: new Map(),
		/** @type {Map<string, any>} */
		manifests: new Map(),
		/** @type {Array<{ subscriptionId: string, websiteId: string, appId: string, status: string }>} */
		subscriptions: [],
		/** @type {Set<string>} */
		revoked: new Set(),
		/** @type {Map<string, any>} app public JWKS for product assertions */
		appJwks: new Map(),
		failures: { commerce: false, catalog: false, revocation: false },
		calls: { subscriptionsForWebsite: 0 },
	};

	const identity = defineModule({
		name: 'identity',
		service: () => ({
			/** @param {string} websiteId */
			getWebsite: async (websiteId) => {
				const website = state.websites.get(websiteId);
				if (!website) throw problem('not_found', 'Unknown website.');
				return { ...website, twinId: null, createdAt: new Date(0) };
			},
			/** @param {{ keyId: string }} claims */
			websiteKeyRevoked: async (claims) => {
				if (state.failures.revocation) throw new Error('identity down');
				return state.revoked.has(claims.keyId);
			},
		}),
		ports: () => ({
			sessionActor: testSessionActor,
			websiteKeyRevoked: (/** @type {any} */ claims) => {
				if (state.failures.revocation) throw new Error('identity down');
				return state.revoked.has(claims.keyId);
			},
		}),
	});

	const catalog = defineModule({
		name: 'catalog',
		service: () => ({
			/** @param {string} appId */
			getApp: async (appId) => {
				if (state.failures.catalog) throw new Error('catalog down');
				const app = state.apps.get(appId);
				if (!app) throw problem('not_found', 'Unknown app.');
				return { ...app, currentVersion: '1.0.0' };
			},
			/** @param {string} appId */
			getManifest: async (appId) => {
				if (state.failures.catalog) throw new Error('catalog down');
				const manifest = state.manifests.get(appId);
				if (!manifest) throw problem('not_found', 'No manifest.');
				return manifest;
			},
		}),
		ports: () => ({
			appKeys: (/** @type {string} */ appId) => {
				const jwks = state.appJwks.get(appId);
				return jwks ? createKeyResolver({ jwks }) : null;
			},
		}),
	});

	const commerce = defineModule({
		name: 'commerce',
		service: () => ({
			/** @param {string} websiteId */
			subscriptionsForWebsite: async (websiteId) => {
				state.calls.subscriptionsForWebsite += 1;
				if (state.failures.commerce) throw new Error('commerce down');
				return state.subscriptions.filter((sub) => sub.websiteId === websiteId).map((sub) => ({ ...sub }));
			},
		}),
	});

	/**
	 * @param {{ appId: string, slug: string, consumes?: string[], publishes?: string[], scopes?: string[],
	 *   endpoints?: Record<string, string> | null, status?: string, kind?: 'service' | 'pack', baseUrl?: string | null }} input
	 *   `baseUrl` (the connected production base) defaults to `endpoints.base`
	 */
	const addApp = ({
		appId,
		slug,
		consumes = [],
		publishes = [],
		scopes = [],
		endpoints = null,
		status = 'active',
		kind = 'service',
		baseUrl = endpoints?.base ?? null,
	}) => {
		state.apps.set(appId, { appId, slug, kind, status, endpoints, baseUrl });
		state.manifests.set(appId, {
			product: { slug, name: slug, kind, version: '1.0.0' },
			scopes,
			events: { consumes, publishes },
		});
	};

	/**
	 * @param {string} websiteId
	 * @param {string} appId
	 * @param {string} [status]
	 */
	const subscribe = (websiteId, appId, status = 'active') => {
		state.subscriptions.push({ subscriptionId: `sub_${state.subscriptions.length}`, websiteId, appId, status });
	};

	return { state, modules: [identity, catalog, commerce], addApp, subscribe };
};
