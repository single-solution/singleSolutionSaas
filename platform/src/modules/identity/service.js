/**
 * Public service of the `identity` module (other modules use `ctx.service('identity')`; see INTERFACES.md).
 * Composes the account, team, website, key and admin services over one repository, and implements the infra
 * ports `sessionActor` (live roles; deactivated users and removed members → null) and `websiteKeyRevoked`.
 *
 * Website keys are signed with the **dedicated website-key signer** `ctx.keys.websiteKeySigner`
 * (generated on first start), whose public keys the infra publishes and the `websiteKey` authenticator verifies
 * with. The module option `websiteKeySigningKeys` overrides it (tests and embedded setups).
 * @module
 */
import { createJwks, createKeyResolver, createSigner, toPublicJwk } from '@ss/protocol';
import { createAccounts } from './accounts.js';
import { createAdmin } from './admin.js';
import { createIssuers } from './issuers.js';
import { createIssuerRequests } from './issuer-requests.js';
import { C } from './schema.js';
import { createAuditor, createRepo } from './repo.js';
import { createTeams } from './teams.js';
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

	const accounts = createAccounts(deps);
	const teams = createTeams(deps);
	const keys = createWebsiteKeys(deps, {
		signer,
		loadWebsite: (websiteId, merchantId) => websites.loadWebsite(websiteId, merchantId),
		activeMerchant: teams.activeMerchant,
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
		loadMerchant: (merchantId) => teams.loadMerchant(merchantId),
		issuers,
		collection: ctx.collection(C.issuerRequests),
	});
	const websites = createWebsites(deps, {
		activeMerchant: teams.activeMerchant,
		loadMerchant: teams.loadMerchant,
		revokeWebsiteKeys: keys.revokeWebsiteKeys,
		forgetIssuers: async (input) => {
			await issuers.forget(input);
			await issuerRequests.forget(input);
		},
		resign: async (websiteId) => {
			if (!ctx.moduleNames().includes('commerce')) return;
			try {
				await ctx.service('commerce').invalidateWebsite(websiteId);
			} catch (error) {
				ctx.logger.warn('entitlement documents not re-signed after a settings change', { websiteId, error });
			}
		},
		...(options.isPublicSuffix ? { isPublicSuffix: options.isPublicSuffix } : {}),
	});
	const admin = createAdmin(deps, {
		loadMerchant: teams.loadMerchant,
		staffSetupLink: accounts.staffSetupLink,
		staffWelcomeTtlMs: accounts.STAFF_WELCOME_TTL_MS,
	});

	/**
	 * `sessionActor` port: the live actor of a session, or null when the account or membership is gone.
	 * @param {Session} session
	 * @returns {Promise<Actor | null>}
	 */
	const sessionActor = async (session) => {
		if (session.kind === 'staff') {
			const staff = await repo.staff.findOne({ _id: session.subject });
			if (!staff || staff.status !== 'active') return null;
			return { type: 'staff', id: session.subject, roles: [...staff.roles] };
		}
		const user = await repo.users.findOne({ _id: session.subject });
		if (!user || user.status !== 'active') return null;
		if (!session.merchantId) return { type: 'merchant_user', id: session.subject, roles: [], grants: [] };
		const membership = await repo.memberships
			.of(session.merchantId)
			.findOne({ merchantId: session.merchantId, userId: session.subject });
		if (!membership) return null;
		return {
			type: 'merchant_user',
			id: session.subject,
			merchantId: session.merchantId,
			roles: [...membership.roles],
			grants: membership.grants.map((/** @type {any} */ g) => ({ websiteId: g.websiteId, roles: [...g.roles] })),
		};
	};

	return {
		// INTERFACES.md
		getMerchant: teams.getMerchant,
		getWebsite: (/** @type {string} */ websiteId) => websites.getWebsite(websiteId),
		listWebsites: (/** @type {string} */ merchantId) => websites.listWebsites(merchantId),
		websiteByDomain: websites.websiteByDomain,
		suspendMerchant: admin.suspendMerchant,
		resumeMerchant: admin.resumeMerchant,
		issueKey: keys.issueKey,
		revokeKey: keys.revokeKey,
		revocationsSince: keys.revocationsSince,
		// more for other modules (catalog launches, consoles)
		rotateKey: keys.rotateKey,
		listKeys: keys.listKeys,
		createWebsite: websites.createWebsite,
		updateWebsiteSettings: websites.updateSettings,
		deleteWebsite: websites.deleteWebsite,
		transferWebsite: websites.transferWebsite,
		getStaff: admin.getStaff,
		hasStaff: admin.hasStaff,
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
		teams,
		websites,
		keys,
		issuers,
		issuerRequests,
		admin,
		mailer,
	};
};
/** @typedef {ReturnType<typeof createIdentityService>} IdentityService */
