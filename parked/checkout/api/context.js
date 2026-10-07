/**
 * The application shared by the routes, the event consumers and the dashboard: website resolution
 * (entitlement → settings → repositories in the merchant's database), connections to the merchant's other products,
 * event publishing, usage and audit.
 */
import { createIntegrations } from '../adapters/integrations.js';
import { repositoriesFor } from '../adapters/db.js';
import { maskKey, seal, unseal } from '../adapters/secrets.js';
import { createTranslator } from '../core/strings.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').CheckoutApp} CheckoutApp */
/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {string} env
 * @property {string} domain
 * @property {string | null} subscriptionId
 * @property {import('./settings.js').Settings} settings
 * @property {import('../adapters/db.js').Repositories} repos
 */

/** Name of the sealed integration key in the website's `settings` collection. */
export const INTEGRATION_KEY = 'integration_key';

/**
 * @param {CheckoutApp} app
 */
export const createCheckout = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const integrations = createIntegrations({ send: (url, init) => product.outbound.fetch(url, init) });

	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => {
		return {
			websiteId,
			merchantId: String(doc.merchantId ?? ''),
			env: String(doc.env ?? 'live'),
			domain: String(doc.domain ?? '').toLowerCase(),
			subscriptionId: typeof doc.subscriptionId === 'string' ? doc.subscriptionId : null,
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
		};
	};

	/**
	 * Site of a website from its entitlement (null without an active subscription or with `element` off).
	 * @param {string} websiteId
	 * @param {string} [element]
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId, element = 'cart') => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, element)) return null;
		return siteOf(websiteId, result.doc);
	};

	/**
	 * The merchant's server key for their other products (null when not set or unreadable).
	 * @param {Site} site
	 * @returns {Promise<string | null>}
	 */
	const integrationKey = async (site) => {
		const stored = await site.repos.settings.get(INTEGRATION_KEY);
		return stored ? unseal(app.sealKey, site.websiteId, stored.value) : null;
	};

	/**
	 * Store (or clear) the integration key.
	 * @param {Site} site
	 * @param {string | null} key
	 */
	const setIntegrationKey = async (site, key) => {
		if (key === null) return site.repos.settings.remove(INTEGRATION_KEY);
		await site.repos.settings.put(INTEGRATION_KEY, seal(app.sealKey, site.websiteId, key, app.randomBytes));
		return true;
	};

	/** @param {Site} site */
	const integrationStatus = async (site) => {
		const key = await integrationKey(site);
		const { offers, loyalty, cart } = site.settings;
		return {
			key: key ? maskKey(key) : null,
			coupons: Boolean(offers.coupons_url),
			deals: Boolean(offers.deals_url),
			loyalty: Boolean(loyalty.loyalty_url),
			catalog: Boolean(cart.catalog_url),
		};
	};

	/**
	 * Connections to the merchant's products for one request (the key is read once).
	 * @param {Site} site
	 */
	const connectionsFor = async (site) => {
		const key = await integrationKey(site);
		/** @param {string} base */
		const of = (base) => (key && base ? { base, key } : null);
		return {
			coupons: site.settings.enabled('offer_apply') ? of(site.settings.offers.coupons_url) : null,
			deals: site.settings.enabled('offer_apply') ? of(site.settings.offers.deals_url) : null,
			loyalty: site.settings.enabled('loyalty_redeem') ? of(site.settings.loyalty.loyalty_url) : null,
			catalog: of(site.settings.cart.catalog_url),
		};
	};

	/**
	 * Publish an event (durable outbox; delivery failures never throw).
	 * @param {Site} site
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 * @param {string} idempotencyKey
	 */
	const publish = async (site, type, data, idempotencyKey) => {
		try {
			await product.portal.publishEvent({ websiteId: site.websiteId, type, data, idempotencyKey });
		} catch {
			// an invalid envelope is a bug the tests catch; the shopper's request still succeeds
		}
	};

	/** @param {string} lang */
	const translator = (lang) => createTranslator(app.strings[lang] ?? app.strings.en ?? {});

	return Object.freeze({
		app,
		product,
		integrations,
		siteOf,
		siteFor,
		integrationKey,
		setIntegrationKey,
		integrationStatus,
		connectionsFor,
		publish,
		translator,
	});
};

/** @typedef {ReturnType<typeof createCheckout>} Checkout */
