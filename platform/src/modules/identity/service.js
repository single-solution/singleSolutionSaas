/**
 * Public service of the `identity` module (other modules use `ctx.service('identity')`; see INTERFACES.md).
 * Composes the account, team, website, key and admin services over one repository, and implements the infra
 * ports `sessionActor` (live roles; deactivated users and removed members → null) and `websiteKeyRevoked`.
 *
 * Website keys are signed with a **dedicated website-key signer**. Until the infra exposes one
 * (`ctx.keys.websiteKeySigner` from `WEBSITE_KEY_SIGNING_KEYS`), the signer comes from the module option
 * `websiteKeySigningKeys`, and falls back to the Portal signer (logged once) so keys stay verifiable by the infra
 * `websiteKey` authenticator and the published JWKS.
 * @module
 */
import { createJwks, createKeyResolver, createSigner, toPublicJwk } from '@ss/protocol';
import { createAccounts } from './accounts.js';
import { createAdmin } from './admin.js';
import { createLogMailer, createUnavailableMailer } from './mailer.js';
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
 * @property {import('./mailer.js').Mailer} [mailer] e-mail port (default: logging mailer outside production, none in production)
 * @property {ReadonlyArray<PrivateJwk>} [websiteKeySigningKeys] dedicated website-key signing keys (first signs)
 * @property {(domain: string) => boolean} [isPublicSuffix] refuse public suffixes as website domains
 */

/**
 * Select the website-key signer: module option › infra dedicated signer › Portal signer (fallback).
 * @param {ModuleContext} ctx
 * @param {IdentityOptions} options
 * @returns {{ signer: Signer, keyResolver: KeyResolver, jwks: () => Jwks, source: 'option' | 'infra' | 'portal' }}
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
	const keys = /** @type {Record<string, any>} */ (ctx.keys);
	if (keys.websiteKeySigner)
		return {
			signer: keys.websiteKeySigner,
			keyResolver: keys.websiteKeyResolver ?? ctx.keys.keyResolver,
			jwks: () => (typeof keys.websiteKeyJwks === 'function' ? keys.websiteKeyJwks() : ctx.keys.jwks()),
			source: 'infra',
		};
	return { signer: ctx.keys.signer, keyResolver: ctx.keys.keyResolver, jwks: () => ctx.keys.jwks(), source: 'portal' };
};

/**
 * @param {ModuleContext} ctx
 * @param {IdentityOptions} [options]
 */
export const createIdentityService = (ctx, options = {}) => {
	const repo = createRepo(ctx);
	const mailer = options.mailer ?? (ctx.config.isProduction ? createUnavailableMailer() : createLogMailer(ctx.logger));
	const deps = { ctx, repo, mailer, audit: createAuditor(ctx) };
	const signing = websiteKeySigning(ctx, options);
	let warned = false;
	const signer = () => {
		if (signing.source === 'portal' && !warned) {
			warned = true;
			ctx.logger.warn('website keys are signed with the Portal signer (no dedicated website-key signer configured)');
		}
		return signing.signer;
	};

	const accounts = createAccounts(deps);
	const teams = createTeams(deps);
	const keys = createWebsiteKeys(deps, {
		signer,
		loadWebsite: (websiteId, merchantId) => websites.loadWebsite(websiteId, merchantId),
		activeMerchant: teams.activeMerchant,
	});
	const websites = createWebsites(deps, {
		activeMerchant: teams.activeMerchant,
		loadMerchant: teams.loadMerchant,
		revokeWebsiteKeys: keys.revokeWebsiteKeys,
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
		const via = session.via ? { via: session.via } : {};
		if (!session.merchantId) return { type: 'merchant_user', id: session.subject, roles: [], grants: [], ...via };
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
			...via,
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
		deleteWebsite: websites.deleteWebsite,
		transferWebsite: websites.transferWebsite,
		getPartner: admin.partners.get,
		getDeveloper: admin.developers.get,
		getStaff: admin.getStaff,
		bootstrapSuperadmin: admin.bootstrapSuperadmin,
		/** Public keys that verify website keys (to publish in the JWKS once the signer is dedicated). */
		websiteKeyJwks: () => signing.jwks(),
		websiteKeyResolver: () => signing.keyResolver,
		websiteKeySigningSource: () => signing.source,
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
		admin,
		mailer,
	};
};
/** @typedef {ReturnType<typeof createIdentityService>} IdentityService */
