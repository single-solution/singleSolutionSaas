/**
 * Public service of the `identity` module (other modules use `ctx.service('identity')`; see INTERFACES.md).
 * Composes logins, admins, merchants, websites and the tokens of products on websites over one repository, and
 * implements the infra port `sessionActor` (the live role, status and two-step requirement; removed admins and
 * suspended or deleted merchants → null).
 *
 * Neighbours are reached lazily through `ctx.service`: `commerce` (products on a website, merchant status changes) and
 * `catalog` (notices to products).
 * @module
 */
import { problem } from '../../infra/http.js';
import { createAccounts } from './accounts.js';
import { createAdmins } from './admins.js';
import { createMerchants } from './merchants.js';
import { createProductTokens } from './product-tokens.js';
import { createAuditor, createRepo } from './repo.js';
import { createWebsites } from './websites.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/auth.js').Session} Session */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

/**
 * @typedef {object} IdentityOptions
 * @property {import('../../infra/mailer.js').Mailer} [mailer] e-mail port (default: the platform mailer `ctx.mailer`)
 * @property {(domain: string) => boolean} [isPublicSuffix] refuse public suffixes as website domains
 */

/**
 * @param {ModuleContext} ctx
 * @param {IdentityOptions} [options]
 */
export const createIdentityService = (ctx, options = {}) => {
	const repo = createRepo(ctx);
	const mailer = options.mailer ?? ctx.mailer;
	/** @param {string} name */
	const optional = (name) => (ctx.moduleNames().includes(name) ? ctx.service(name) : null);
	/**
	 * Send a notice to products; a failure is logged, never fails the change that caused it (it is kept and retried
	 * by catalog).
	 * @param {(catalog: any) => Promise<unknown>} send
	 */
	const notice = async (send) => {
		const catalog = optional('catalog');
		if (!catalog) return;
		try {
			await send(catalog);
		} catch (error) {
			ctx.logger.warn('notice not queued', { error });
		}
	};
	const deps = {
		ctx,
		repo,
		mailer,
		audit: createAuditor(ctx),
		/** @param {string} subject */
		sessionsEnded: (subject) => notice((catalog) => catalog.notifyAll({ type: 'sessions.revoked', subject })),
	};

	const accounts = createAccounts(deps);
	const admins = createAdmins(deps, { setupLink: accounts.setupLink });
	const merchants = createMerchants(deps, {
		setupLink: accounts.setupLink,
		websitesOf: (merchantId) => websites.activeWebsitesOf(merchantId),
		onStatus: async (merchantId, status) => {
			try {
				await optional('commerce')?.onMerchantStatus({ merchantId, status });
			} catch (error) {
				ctx.logger.error('commerce.onMerchantStatus failed', { error, merchantId, status });
			}
		},
	});
	const tokens = createProductTokens(deps, {
		loadWebsite: (websiteId, merchantId) => websites.loadWebsite(websiteId, merchantId),
		notify: (productId, body) => notice((catalog) => catalog.notify(productId, body)),
	});
	const websites = createWebsites(deps, {
		// websites are added to any merchant that is not deleted, suspended ones included
		activeMerchant: (merchantId) => merchants.load(merchantId),
		productsOn: async (websiteId) => {
			const commerce = optional('commerce');
			return commerce ? /** @type {number} */ (await commerce.productsOnWebsiteCount(websiteId)) : 0;
		},
		onRemoved: async ({ merchantId, websiteId }) => {
			const productIds = await tokens.revokeWebsite({ merchantId, websiteId });
			for (const productId of productIds)
				await notice((catalog) => catalog.notify(productId, { type: 'website.deleted', websiteId }));
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
		/**
		 * Who gets a merchant's billing e-mails (PLAN 0.5.10): the merchant's login e-mail and every active Owner and
		 * Finance admin.
		 * @param {string} merchantId
		 */
		billingContacts: async (merchantId) => {
			const merchant = await merchants.loadAny(merchantId);
			const admins = await repo.admins
				.find({ role: { $in: ['owner', 'finance'] }, status: 'active' })
				.project({ email: 1 })
				.toArray();
			return {
				merchantName: String(merchant.name),
				merchantEmail: merchant.status === 'deleted' ? null : (merchant.email ?? null),
				adminEmails: admins.map((a) => String(a.email)),
			};
		},
		/** Totals of admin Overview: merchants (not deleted) and websites (not removed). */
		counts: async () => ({
			merchants: await repo.merchants.countDocuments({ status: { $ne: 'deleted' } }),
			websites: await repo.websites.all().countDocuments({ status: 'active' }),
		}),
		getWebsite: (/** @type {string} */ websiteId) => websites.getWebsite(websiteId),
		listWebsites: (/** @type {string} */ merchantId) => websites.listWebsites(merchantId),
		websitesByIds: websites.websitesByIds,
		suspendMerchant: merchants.suspend,
		resumeMerchant: merchants.resume,
		createWebsite: websites.createWebsite,
		removeWebsite: websites.removeWebsite,
		/** @param {string} adminId */
		getAdmin: admins.get,
		/**
		 * A current Owner or Support admin (feature reports, PLAN 0.4.12 row 3): `{ adminId, name, role }`; 422 when the
		 * id is no current admin, 403 for Finance.
		 * @param {unknown} adminId
		 */
		dashboardAdmin: async (adminId) => {
			const admin = typeof adminId === 'string' ? await repo.admins.findOne({ _id: adminId }) : null;
			if (!admin || admin.status !== 'active')
				throw problem('validation_failed', 'adminId is not a current admin.', {
					errors: [{ path: '/adminId', message: 'is not a current admin' }],
				});
			if (admin.role !== 'owner' && admin.role !== 'support')
				throw problem('forbidden', 'Only Owner and Support admins switch features.');
			return {
				adminId: String(admin._id),
				name: String(admin.name ?? ''),
				role: /** @type {'owner' | 'support'} */ (admin.role),
			};
		},
		/**
		 * The two tokens of a product on a website: created when it is first added, restored on a re-add (commerce).
		 * @param {{ merchantId: string, websiteId: string, productId: string }} input
		 */
		ensureTokens: tokens.ensure,
		/** @param {{ productId: string, since: unknown }} input */
		revocationsSince: tokens.revocationsSince,
		/**
		 * 404 unless the product is on the website now (not removed).
		 * @param {string} websiteId @param {string} productId
		 */
		requireProductOn: async (websiteId, productId) => {
			const on = /** @type {Array<{ productId: string }>} */ (
				(await optional('commerce')?.productsOnWebsite(websiteId)) ?? []
			);
			if (!on.some((p) => p.productId === productId)) throw problem('not_found', 'This product is not on the website.');
		},
		/**
		 * Install and tokens (PLAN 0.8.2): one block per product on the website (not removed) with its widget script,
		 * docs link, browser token and whether the server token can be shown.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		installOf: async ({ merchantId, websiteId }) => {
			const on = /** @type {Array<{ productId: string }>} */ (
				(await optional('commerce')?.productsOnWebsite(websiteId)) ?? []
			);
			const listed = await tokens.list({ merchantId, websiteId, productIds: on.map((p) => p.productId) });
			const catalog = optional('catalog');
			const out = [];
			for (const entry of listed) {
				const product = catalog ? await catalog.getProduct(entry.productId).catch(() => null) : null;
				out.push({
					productId: entry.productId,
					name: product?.name ?? entry.productId,
					widgetScriptUrl: product?.widgetScriptUrl ?? null,
					docsUrl: product?.docsUrl ?? null,
					browserToken: entry.browserToken,
					serverToken: { canShow: entry.serverTokenCanShow },
				});
			}
			return out;
		},
		// ports
		sessionActor,
		// building blocks for this module's routes
		accounts,
		admins,
		merchants,
		websites,
		tokens,
		mailer,
	};
};
/** @typedef {ReturnType<typeof createIdentityService>} IdentityService */
