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
 * The resolver layers of `config.layersFor` output (`{ platform, website, admin }`, absent ones dropped).
 * @param {Record<string, any> | null | undefined} value
 * @returns {Record<string, any>}
 */
export const configLayers = (value) => {
	/** @type {Record<string, any>} */
	const out = {};
	for (const name of ['platform', 'website', 'admin']) if (value?.[name]) out[name] = value[name];
	return out;
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
		 * Configuration layers of a subscription (`config.layersFor(subscriptionId, hint)` returns
		 * `{ platform, website, admin }`).
		 * @param {Record<string, any>} sub `{ _id, merchantId, appId }`
		 * @returns {Promise<Record<string, any>>}
		 */
		layersFor: async (sub) =>
			configLayers(await optional('config')?.layersFor(sub._id, { merchantId: sub.merchantId, appId: sub.appId })),
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
