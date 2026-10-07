/**
 * Public service of the `identity` module (other modules use `ctx.service('identity')`; see INTERFACES.md).
 * Composes logins, admins, merchants, websites and (until the switch, PLAN 0.12 step 5) website keys and identity
 * issuers over one repository, and implements the infra ports `sessionActor` (the live role, status and two-step
 * requirement; removed admins and suspended or deleted merchants → null) and `websiteKeyRevoked`.
 *
 * Website keys are signed with the **dedicated website-key signer** `ctx.keys.websiteKeySigner`
 * (generated on first start), whose public keys the infra publishes and the `websiteKey` authenticator verifies
 * with. The module option `websiteKeySigningKeys` overrides it (tests and embedded setups).
 * @module
 */
import { createJwks, createKeyResolver, createSigner, toPublicJwk } from '@ss/protocol';
import { problem } from '../../infra/http.js';
import { createAccounts } from './accounts.js';
import { createAdmins } from './admins.js';
import { createIssuers } from './issuers.js';
import { createIssuerRequests } from './issuer-requests.js';
import { createMerchants } from './merchants.js';
import { C } from './schema.js';
import { createAuditor, createRepo } from './repo.js';
import { createWebsiteKeys } from './website-keys.js';
import { createWebsites } from './websites.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/auth.js').Session} Session */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {import('@ss/protocol').Signer} Signer */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('@ss/protocol').Jwks} Jwks */

/**
 * @typedef {object} IdentityOptions
 * @property {import('../../infra/mailer.js').Mailer} [mailer] e-mail port (default: the platform mailer `ctx.mailer`)
 * @property {ReadonlyArray<PrivateJwk>} [websiteKeySigningKeys] dedicated website-key signing keys (first signs)
 * @property {(domain: string) => boolean} [isPublicSuffix] refuse public suffixes as website domains
 * @property {import('./issuers.js').IssuerOptions} [issuers] outbound options of identity-issuer JWKS fetches (tests)
 */

/**
 * Select the website-key signer: module option › the infra's dedicated website-key signer.
 * @param {ModuleContext} ctx
 * @param {IdentityOptions} options
 * @returns {{ signer: Signer, keyResolver: KeyResolver, jwks: () => Jwks, source: 'option' | 'infra' }}
 */
export const websiteKeySigning = (ctx, options) => {
	const configured = options.websiteKeySigningKeys ?? [];
	if (configured.length > 0) {
		const jwks = createJwks(configured.map((jwk) => toPublicJwk(jwk)));
		return {
			signer: createSigner(/** @type {PrivateJwk} */ (configured[0])),
			keyResolver: createKeyResolver({ jwks }),
			jwks: () => jwks,
			source: 'option',
		};
	}
	return {
		signer: ctx.keys.websiteKeySigner,
		keyResolver: ctx.keys.websiteKeyResolver,
		jwks: () => ctx.keys.websiteKeyJwks(),
		source: 'infra',
	};
};

/**
 * @param {ModuleContext} ctx
 * @param {IdentityOptions} [options]
 */
export const createIdentityService = (ctx, options = {}) => {
	const repo = createRepo(ctx);
	const mailer = options.mailer ?? ctx.mailer;
	const deps = { ctx, repo, mailer, audit: createAuditor(ctx) };
	const signing = websiteKeySigning(ctx, options);
	const signer = () => signing.signer;
	const commerce = () => (ctx.moduleNames().includes('commerce') ? ctx.service('commerce') : null);

	const accounts = createAccounts(deps);
	const admins = createAdmins(deps, { setupLink: accounts.setupLink });
	const merchants = createMerchants(deps, {
		setupLink: accounts.setupLink,
		websitesOf: (merchantId) => websites.activeWebsitesOf(merchantId),
		onStatus: async (merchantId, status) => {
			try {
				const service = commerce();
				if (service && typeof service.onMerchantStatus === 'function') await service.onMerchantStatus({ merchantId, status });
			} catch (error) {
				ctx.logger.error('commerce.onMerchantStatus failed', { error, merchantId, status });
			}
		},
	});
	/**
	 * A merchant that may still act (not suspended, not deleted).
	 * @param {string} merchantId
	 */
	const activeMerchant = async (merchantId) => {
		const merchant = await merchants.load(merchantId);
		if (merchant.status !== 'active') throw problem('merchant_suspended', 'The merchant is suspended.');
		return merchant;
	};
	const keys = createWebsiteKeys(deps, {
		signer,
		loadWebsite: (websiteId, merchantId) => websites.loadWebsite(websiteId, merchantId),
		activeMerchant,
		products: async () =>
			ctx.moduleNames().includes('catalog')
				? /** @type {Array<{ slug: string, name?: string }>} */ (
						await ctx.service('catalog').activeProducts({ kind: 'service' })
					)
				: [],
	});
	const issuers = createIssuers(deps, {
		loadWebsite: (websiteId, merchantId) => websites.loadWebsite(websiteId, merchantId),
		collection: ctx.collection(C.issuers),
		...(options.issuers ? { options: options.issuers } : {}),
	});
	const issuerRequests = createIssuerRequests(deps, {
		loadWebsite: (websiteId, merchantId) => websites.loadWebsite(websiteId, merchantId),
		loadMerchant: (merchantId) => merchants.load(merchantId),
		issuers,
		collection: ctx.collection(C.issuerRequests),
	});
	const websites = createWebsites(deps, {
		// websites are added to any merchant that is not deleted, suspended ones included
		activeMerchant: (merchantId) => merchants.load(merchantId),
		productsOn: async (websiteId) => {
			const service = commerce();
			if (!service) return 0;
			const subs = /** @type {Array<{ status?: string }>} */ (await service.subscriptionsForWebsite(websiteId));
			return subs.filter((sub) => sub.status !== 'cancelled').length;
		},
		revokeWebsiteKeys: keys.revokeWebsiteKeys,
		forgetIssuers: async (input) => {
			await issuers.forget(input);
			await issuerRequests.forget(input);
		},
		resign: async (websiteId) => {
			const service = commerce();
			if (!service) return;
			try {
				await service.invalidateWebsite(websiteId);
			} catch (error) {
				ctx.logger.warn('entitlement documents not re-signed after a settings change', { websiteId, error });
			}
		},
		...(options.isPublicSuffix ? { isPublicSuffix: options.isPublicSuffix } : {}),
	});

	/**
	 * `sessionActor` port: the live actor of a session, or null when the login is gone (removed admin, deleted or
	 * suspended merchant). Admins carry their live role and name, and `twoStepRequired` while Require two-step for
	 * admins is on and they have not set it up.
	 * @param {Session} session
	 * @returns {Promise<Actor | null>}
	 */
	const sessionActor = async (session) => {
		if (session.kind === 'admin') {
			const admin = await repo.admins.findOne({ _id: session.subject });
			if (!admin || admin.status !== 'active') return null;
			return {
				type: 'admin',
				id: session.subject,
				role: admin.role,
				name: admin.name ?? null,
				twoStepRequired: ctx.config.settings.security.requireTwoStepForAdmins && !admin.totp,
			};
		}
		const merchant = await repo.merchants.findOne({ _id: session.subject });
		if (!merchant || merchant.status !== 'active') return null;
		return { type: 'merchant', id: session.subject, merchantId: session.subject };
	};

	return {
		// INTERFACES.md
		getMerchant: merchants.get,
		/** @param {string} merchantId the merchant as stored, deleted ones included (records under the business name) */
		getMerchantRecord: async (merchantId) => {
			const doc = await merchants.loadAny(merchantId);
			return { merchantId: String(doc._id), name: doc.name, status: doc.status };
		},
		merchantNames: merchants.namesOf,
		/** Totals of admin Overview: merchants (not deleted) and websites (not removed). */
		counts: async () => ({
			merchants: await repo.merchants.countDocuments({ status: { $ne: 'deleted' } }),
			websites: await repo.websites.all().countDocuments({ status: 'active', env: 'live' }),
		}),
		getWebsite: (/** @type {string} */ websiteId) => websites.getWebsite(websiteId),
		listWebsites: (/** @type {string} */ merchantId) => websites.listWebsites(merchantId),
		websiteByDomain: websites.websiteByDomain,
		suspendMerchant: merchants.suspend,
		resumeMerchant: merchants.resume,
		issueKey: keys.issueKey,
		revokeKey: keys.revokeKey,
		revocationsSince: keys.revocationsSince,
		rotateKey: keys.rotateKey,
		listKeys: keys.listKeys,
		createWebsite: websites.createWebsite,
		updateWebsiteSettings: websites.updateSettings,
		removeWebsite: websites.removeWebsite,
		/** @param {string} adminId */
		getAdmin: admins.get,
		/** Public keys that verify website keys (published by the infra in the Portal JWKS). */
		websiteKeyJwks: () => signing.jwks(),
		websiteKeyResolver: () => signing.keyResolver,
		websiteKeySigningSource: () => signing.source,
		/** Bring-your-own identity: the `identity` section of the website's entitlement documents (commerce), or null. */
		identityFor: issuers.identityFor,
		getIdentityIssuer: issuers.getIssuer,
		setIdentityIssuer: issuers.setIssuer,
		removeIdentityIssuer: issuers.removeIssuer,
		refreshIdentityIssuer: issuers.refreshKeys,
		// ports
		sessionActor,
		isKeyRevoked: keys.isRevoked,
		/** Same check for modules that verify website keys themselves (e.g. body-authenticated event ingest). */
		websiteKeyRevoked: keys.isRevoked,
		// building blocks for this module's routes
		accounts,
		admins,
		merchants,
		websites,
		keys,
		issuers,
		issuerRequests,
		mailer,
	};
};
/** @typedef {ReturnType<typeof createIdentityService>} IdentityService */
