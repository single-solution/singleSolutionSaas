/**
 * Other modules commerce depends on, reached only through `ctx.service(name)` (INTERFACES.md). `identity` and
 * `catalog` are required; `config`, `connectors` and `integration` are optional at runtime: without `config` no
 * overrides apply, without `connectors` every resource reads as missing (fail closed), without `integration` control
 * events are not delivered (products still pull documents). Manifests are cached per app version (immutable).
 * @module
 */
import { productOf } from '../core/catalog.js';

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../core/catalog.js').Manifest} Manifest */
/** @typedef {import('../core/catalog.js').Product} Product */

const MANIFEST_CACHE = 200;

/**
 * Split `config.layersFor` output into resolver layers and runtime experiments.
 * @param {Record<string, any> | null | undefined} value
 * @returns {{ layers: Record<string, any>, experiments: any[] }}
 */
export const splitLayers = (value) => {
	const { experiments, ...layers } = value ?? {};
	/** @type {Record<string, any>} */
	const out = {};
	for (const name of ['platform', 'merchant', 'website', 'admin']) if (layers[name]) out[name] = layers[name];
	return { layers: out, experiments: Array.isArray(experiments) ? experiments : [] };
};

/**
 * @param {ModuleContext} ctx
 */
export const createDeps = (ctx) => {
	/** @param {string} name */
	const optional = (name) => (ctx.moduleNames().includes(name) ? ctx.service(name) : null);
	/** @type {Map<string, Promise<{ manifest: Manifest, product: Product }>>} */
	const manifests = new Map();

	/**
	 * Manifest (and normalised product) of an app version (current version when omitted; never cached then).
	 * @param {string} appId
	 * @param {string | number} [version] catalog version (the app's `currentVersion` numbering)
	 * @returns {Promise<{ manifest: Manifest, product: Product }>}
	 */
	const manifestOf = (appId, version) => {
		const load = async () => {
			const manifest = /** @type {Manifest} */ (await ctx.service('catalog').getManifest(appId, version));
			return { manifest, product: productOf(manifest) };
		};
		if (version === undefined) return load();
		const key = `${appId}@${version}`;
		const cached = manifests.get(key);
		if (cached) return cached;
		const pending = load();
		manifests.set(key, pending);
		pending.catch(() => manifests.delete(key));
		if (manifests.size > MANIFEST_CACHE) manifests.delete(/** @type {string} */ (manifests.keys().next().value));
		return pending;
	};

	return Object.freeze({
		/** @param {string} merchantId */
		getMerchant: (merchantId) => ctx.service('identity').getMerchant(merchantId),
		/** @param {string} websiteId */
		getWebsite: (websiteId) => ctx.service('identity').getWebsite(websiteId),
		/** @param {string} appId */
		getApp: (appId) => ctx.service('catalog').getApp(appId),
		manifestOf,
		/**
		 * Configuration layers and experiments of a subscription (`config.layersFor(subscriptionId, hint)` returns
		 * `{ platform, merchant, website, admin, experiments }`).
		 * @param {Record<string, any>} sub `{ _id, merchantId, appId }`
		 * @returns {Promise<{ layers: Record<string, any>, experiments: any[] }>}
		 */
		layersFor: async (sub) =>
			splitLayers(await optional('config')?.layersFor(sub._id, { merchantId: sub.merchantId, appId: sub.appId })),
		/**
		 * Bring-your-own identity: the website's identity issuer as the document's `identity` section, or null.
		 * @param {string} websiteId
		 * @returns {Promise<import('@ss/contracts').IdentitySection | null>}
		 */
		identityFor: async (websiteId) => {
			const identity = ctx.service('identity');
			return typeof identity.identityFor === 'function' ? ((await identity.identityFor(websiteId)) ?? null) : null;
		},
		/** @param {string} websiteId @returns {Promise<{ kind: string, ref?: string, status: string }[]>} */
		statusFor: async (websiteId) => (await optional('connectors')?.statusFor(websiteId)) ?? [],
		/**
		 * Ask `delivery` to recompile the website bundle (a document version changed or a subscription ended); a failure
		 * is logged, never fails commerce.
		 * @param {string} websiteId
		 */
		requestCompile: async (websiteId) => {
			try {
				await optional('delivery')?.requestCompile(websiteId);
			} catch (error) {
				ctx.logger.warn('delivery recompile not requested', { websiteId, error });
			}
		},
		/**
		 * Emit a control event; delivery problems are logged, never fail a money operation.
		 * @param {string} type @param {Record<string, unknown>} data @param {{ appIds?: string[], websiteId?: string }} target
		 */
		emit: async (type, data, target) => {
			const integration = optional('integration');
			if (!integration) return;
			try {
				await integration.emitControl(type, data, target);
			} catch (error) {
				ctx.logger.warn('control event not emitted', { type, error });
			}
		},
	});
};
/** @typedef {ReturnType<typeof createDeps>} Deps */
