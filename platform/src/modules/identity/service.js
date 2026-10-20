/**
 * Public service of the `identity` module (other modules use `ctx.service('identity')`; see INTERFACES.md).
 * Composes logins, admins, merchants, websites and the tokens of products on websites over one repository, and
 * implements the infra port `sessionActor` (the live role, status and two-step requirement; removed admins and
 * suspended or deleted merchants → null).
 *
 * Neighbors are reached lazily through `ctx.service`: `commerce` (products on a website, merchant status changes) and
 * `catalog` (notices to products).
 * @module
 */
import { problem } from '../../infra/http.js';
import { inputs } from './core/inputs.js';
import { createAccounts } from './accounts.js';
import { createAdmins } from './admins.js';
import { createMerchants } from './merchants.js';
import { createProductTokens } from './product-tokens.js';
import { createAuditor, createRepo } from './repo.js';
import { createWebsites } from './websites.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/auth.js').Session} Session */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./repo.js').Meta} Meta */

/**
 * @typedef {object} IdentityOptions
 * @property {import('../../infra/mailer.js').Mailer} [mailer] email port (default: the platform mailer `ctx.mailer`)
 * @property {(domain: string) => boolean} [isPublicSuffix] refuse public suffixes as website domains
 */

/**
 * @param {ModuleContext} ctx
 * @param {IdentityOptions} [options]
 */
export const createIdentityService = (ctx, options = {}) => {
	const repo = createRepo(ctx);
	const mailer = options.mailer ?? ctx.mailer;
	/**
	 * Send a notice to products; a failure is logged, never fails the change that caused it (it is kept and retried
	 * by catalog).
	 * @param {(catalog: any) => Promise<unknown>} send
	 */
	const notice = async (send) => {
		try {
			await send(ctx.service('catalog'));
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
		// commerce's history alone decides whether the merchant's products are suspended: a failure fails the request,
		// and repeating the suspend or resume repairs it (the hook is idempotent)
		onStatus: async (merchantId, status) => {
			await ctx.service('commerce').onMerchantStatus({ merchantId, status });
		},
	});
	const tokens = createProductTokens(deps, {
		loadWebsite: (websiteId, merchantId) => websites.loadWebsite(websiteId, merchantId),
		notify: (productId, body) => notice((catalog) => catalog.notify(productId, body)),
	});
	const websites = createWebsites(deps, {
		// websites are added to any merchant that is not deleted, suspended ones included
		activeMerchant: (merchantId) => merchants.load(merchantId),
		productsOn: (websiteId) => ctx.service('commerce').productsOnWebsiteCount(websiteId),
		onRemoved: async ({ merchantId, websiteId }) => {
			// the website's links (their tokens are revoked) and connections go with it
			try {
				await ctx.service('website').forgetWebsite({ merchantId, websiteId });
			} catch (error) {
				// a Portal without the website module (a test of identity alone) has none; any other failure is real
				if (/** @type {{ code?: string }} */ (error)?.code !== 'unknown_module') throw error;
			}
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
		 * Who gets a merchant's billing emails (PLAN 0.5.10): the merchant's login email and every active Owner and
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
		/**
		 * Send the merchant an e-mail (the same mailer as the other Portal e-mails); false when it cannot be sent (no
		 * e-mail sending set up, a deleted merchant). A failure to send is thrown for the caller to log.
		 * @param {{ merchantId: string, template: import('../../infra/mailer.js').MailTemplate, data: Record<string, string> }} input
		 * @returns {Promise<boolean>}
		 */
		mailMerchant: async ({ merchantId, template, data }) => {
			const merchant = await merchants.loadAny(merchantId);
			if (merchant.status === 'deleted' || !merchant.email || !mailer.available) return false;
			await mailer.send({ to: String(merchant.email), template, data });
			return true;
		},
		/**
		 * Send every active Owner an e-mail (an alert about the Portal itself); false when nothing can be sent (no e-mail
		 * sending set up). A failure to send to one Owner is thrown after the others were tried.
		 * @param {{ template: import('../../infra/mailer.js').MailTemplate, data: Record<string, string> }} input
		 * @returns {Promise<boolean>}
		 */
		mailOwners: async ({ template, data }) => {
			if (!mailer.available) return false;
			const owners = await repo.admins.find({ role: 'owner', status: 'active' }).project({ email: 1 }).toArray();
			/** @type {unknown} */
			let failure = null;
			for (const owner of owners) {
				try {
					await mailer.send({ to: String(owner.email), template, data });
				} catch (error) {
					failure ??= error;
				}
			}
			if (failure) throw failure;
			return true;
		},
		/** Totals of admin Overview: merchants (not deleted) and websites (not removed). */
		counts: async () => ({
			merchants: await repo.merchants.countDocuments({ status: { $ne: 'deleted' } }),
			websites: await repo.websites.all().countDocuments({ status: 'active' }),
		}),
		getWebsite: websites.getWebsite,
		websitesByIds: websites.websitesByIds,
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
		/**
		 * Settings → Encryption key → Re-seal (PLAN 0.4.8; RT-14): the server tokens and two-step secrets sealed again
		 * with the current key, counted per part.
		 * @returns {Promise<{ serverTokens: import('../../infra/crypto.js').ResealCounts,
		 *   twoStep: import('../../infra/crypto.js').ResealCounts }>}
		 */
		resealSecrets: async () => ({ serverTokens: await tokens.reseal(), twoStep: await accounts.resealTwoStep() }),
		/**
		 * Put token ids of a product on the revocation list (the website module's link tokens).
		 * @param {{ merchantId: string, websiteId: string, productId: string, jtis: readonly string[] }} input
		 */
		revokeTokenIds: tokens.revokeIds,
		/**
		 * A fresh confirmation of the signed-in person before a change that must not happen from a stolen session: their
		 * current password, and a two-step or recovery code while two-step is on. 422 for a body that is not one; 401/403
		 * and throttling as signing in.
		 * @param {{ kind: 'admin' | 'merchant', id: string, body: unknown, meta: Meta }} input `body`: any object holding
		 *   `password` (and `code` / `recoveryCode`); other members are ignored
		 */
		confirmPerson: async ({ kind, id, body, meta }) => {
			const source =
				typeof body === 'object' && body !== null && !Array.isArray(body)
					? /** @type {Record<string, unknown>} */ (body)
					: {};
			const parsed = inputs.confirmation({ password: source.password, code: source.code, recoveryCode: source.recoveryCode });
			if (!parsed.ok) throw problem('validation_failed', 'Confirm with your password.', { errors: parsed.errors });
			await accounts.confirm(kind, { ...parsed.value, id }, meta);
		},
		/**
		 * 404 unless the product is on the website now (not removed).
		 * @param {string} websiteId @param {string} productId
		 */
		requireProductOn: async (websiteId, productId) => {
			const on = /** @type {Array<{ productId: string }>} */ (await ctx.service('commerce').productsOnWebsite(websiteId));
			if (!on.some((p) => p.productId === productId)) throw problem('not_found', 'This product is not on the website.');
		},
		/**
		 * Install and tokens (PLAN 0.8.2): one block per product on the website (not removed) with its widget script,
		 * docs link, browser token and whether the server token can be shown.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		installOf: async ({ merchantId, websiteId }) => {
			const on = /** @type {Array<{ productId: string }>} */ (await ctx.service('commerce').productsOnWebsite(websiteId));
			const listed = await tokens.list({ merchantId, websiteId, productIds: on.map((p) => p.productId) });
			const catalog = ctx.service('catalog');
			const out = [];
			for (const entry of listed) {
				const product = await catalog.getProduct(entry.productId).catch(() => null);
				out.push({
					productId: entry.productId,
					name: product?.name ?? entry.productId,
					widgetScriptUrl: product?.widgetScriptUrl ?? null,
					widgetScriptLoading: product?.widgetScriptLoading ?? 'async',
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
