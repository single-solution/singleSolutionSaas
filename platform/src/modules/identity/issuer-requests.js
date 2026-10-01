/**
 * Product requests to become a website's identity issuer (F.16), e.g. Signups registering the login it runs for
 * the website. A product never sets the issuer itself: `PUT /v1/product/websites/:websiteId/identity` (product auth)
 * stores a **pending** request — only for a product with an active subscription on the website whose accepted
 * manifest declares `capabilities.identityIssuer: true` — and notifies the merchant (e-mail to the owner, Website →
 * Identity in the console). The merchant approves (the request becomes the active issuer, `managedBy` the product)
 * or rejects it. One pending request per website (`_id` = websiteId); a newer request replaces an older pending one.
 * A request identical to the active issuer is answered `active` without a new approval. Everything is audited.
 * @module
 */
import { canonicalJson } from '@ss/protocol';
import { problem } from '../../infra/http.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./core/issuer.js').IssuerInput} IssuerInput */

/**
 * The comparable configuration of an issuer input or a stored issuer.
 * @param {{ issuer: string, jwksUrl?: string | null, audience?: string | null, claimMap: Record<string, string>,
 *   keys?: unknown[] | null, publicJwks?: unknown[] | null }} value
 */
const configOf = (value) =>
	canonicalJson({
		issuer: value.issuer,
		jwksUrl: value.jwksUrl ?? null,
		audience: value.audience ?? null,
		claimMap: value.claimMap,
		keys: value.jwksUrl ? null : (value.publicJwks ?? value.keys ?? null),
	});

/** @param {Record<string, any>} doc */
export const presentRequest = (doc) => ({
	websiteId: String(doc._id),
	status: doc.status,
	product: { appId: doc.appId, slug: doc.productSlug, name: doc.productName },
	issuer: doc.input.issuer,
	source: doc.input.jwksUrl ? 'jwks_url' : 'inline',
	jwksUrl: doc.input.jwksUrl ?? null,
	audience: doc.input.audience ?? null,
	claimMap: { ...doc.input.claimMap },
	kids: [...(doc.kids ?? [])],
	requestedAt: doc.requestedAt instanceof Date ? doc.requestedAt.toISOString() : null,
	decidedAt: doc.decidedAt instanceof Date ? doc.decidedAt.toISOString() : null,
	reason: doc.reason ?? null,
});

/**
 * @param {Deps} deps
 * @param {{
 *   loadWebsite: (websiteId: string, merchantId?: string) => Promise<Record<string, any>>,
 *   loadMerchant: (merchantId: string) => Promise<Record<string, any>>,
 *   issuers: import('./issuers.js').Issuers,
 *   collection: import('../../infra/db.js').TenantRepository,
 * }} hooks
 */
export const createIssuerRequests = (deps, { loadWebsite, loadMerchant, issuers, collection }) => {
	const { ctx, repo, audit, mailer } = deps;
	/** @param {string} merchantId */
	const of = (merchantId) => /** @type {import('../../infra/db.js').MutableOps} */ (collection.forMerchant(merchantId));

	/**
	 * The product, when it may ask: active subscription on the website and the `identityIssuer` capability.
	 * @param {string} appId
	 * @param {string} websiteId
	 */
	const eligibleProduct = async (appId, websiteId) => {
		const refused = problem('forbidden', 'This product may not request to become the identity issuer of this website.');
		if (!ctx.moduleNames().includes('catalog') || !ctx.moduleNames().includes('commerce')) throw refused;
		const subscriptions = /** @type {Array<{ appId: string, status: string }>} */ (
			await ctx.service('commerce').subscriptionsForWebsite(websiteId)
		);
		if (!subscriptions.some((s) => s.appId === appId && s.status === 'active')) throw refused;
		const app = await ctx.service('catalog').getApp(appId);
		const manifest = /** @type {Record<string, any>} */ (await ctx.service('catalog').getManifest(appId));
		if (manifest?.capabilities?.identityIssuer !== true)
			throw problem('forbidden', 'The product manifest does not declare capabilities.identityIssuer.');
		return { appId, slug: String(app.slug), name: String(manifest.product?.name ?? app.slug) };
	};

	/**
	 * Tell the merchant owner (best effort; the console shows the request either way).
	 * @param {Record<string, any>} website
	 * @param {{ name: string }} product
	 */
	const notify = async (website, product) => {
		try {
			if (!mailer?.available) return;
			const merchant = await loadMerchant(String(website.merchantId));
			const owner = merchant.ownerUserId ? await repo.users.findOne({ _id: merchant.ownerUserId }) : null;
			if (!owner?.email) return;
			await mailer.send({
				to: owner.email,
				template: 'issuer_request',
				data: {
					productName: product.name,
					domain: website.domain,
					link: `${ctx.config.portalUrl}/websites/${encodeURIComponent(String(website._id))}/identity`,
				},
			});
		} catch (error) {
			ctx.logger.warn('identity issuer request notification not sent', { websiteId: String(website._id), error });
		}
	};

	/** @param {Record<string, any>} website */
	const pendingOf = async (website) => {
		const doc = await of(String(website.merchantId)).findOne({
			_id: String(website._id),
			merchantId: String(website.merchantId),
		});
		return doc && doc.status === 'pending' ? doc : null;
	};

	return Object.freeze({
		/**
		 * `PUT /v1/product/websites/:websiteId/identity`: store a pending request (or answer `active` when the
		 * request equals the active issuer). A JWKS URL must yield a usable key now.
		 * @param {{ appId: string, websiteId: string, input: IssuerInput, meta?: Meta }} input
		 */
		request: async ({ appId, websiteId, input, meta = {} }) => {
			const website = await loadWebsite(websiteId).catch(() => {
				throw problem('not_found', 'No such website.');
			});
			if (website.status !== 'active') throw problem('not_found', 'No such website.');
			const product = await eligibleProduct(appId, websiteId);
			const merchantId = String(website.merchantId);
			const active = await issuers.getIssuer({ merchantId, websiteId });
			const current = active
				? await issuers.stored({ merchantId, websiteId })
				: /** @type {Record<string, any> | null} */ (null);
			if (current && configOf(/** @type {any} */ (current)) === configOf(/** @type {any} */ (input)))
				return { status: 'active', issuer: active };
			const pending = await pendingOf(website);
			if (pending && pending.appId === appId && configOf(pending.input) === configOf(/** @type {any} */ (input)))
				return { status: 'pending', request: presentRequest(pending) };
			const { kids } = await issuers.checkInput(input);
			const actor = /** @type {Actor} */ ({ type: 'product', id: appId });
			const doc = {
				appId,
				productSlug: product.slug,
				productName: product.name,
				input: { ...input },
				kids,
				status: 'pending',
				requestedAt: new Date(ctx.now()),
				decidedAt: null,
				decidedBy: null,
				reason: null,
			};
			await of(merchantId).updateOne({ _id: websiteId, merchantId }, { $set: doc }, { upsert: true });
			await audit(
				actor,
				'website.identity_issuer_requested',
				{ type: 'website', id: websiteId, merchantId, websiteId },
				{
					after: { appId, issuer: input.issuer, source: input.jwksUrl ? 'jwks_url' : 'inline', kids },
					...(pending ? { before: { appId: pending.appId, issuer: pending.input.issuer } } : {}),
					meta,
				},
			);
			await notify(website, product);
			return { status: 'pending', request: presentRequest({ ...doc, _id: websiteId }) };
		},

		/**
		 * The pending request of a website, or null.
		 * @param {{ merchantId: string, websiteId: string }} input
		 */
		pending: async ({ merchantId, websiteId }) => {
			const doc = await pendingOf(await loadWebsite(websiteId, merchantId));
			return doc ? presentRequest(doc) : null;
		},

		/**
		 * Pending requests across a merchant's websites (console notifications).
		 * @param {{ merchantId: string }} input
		 */
		pendingForMerchant: async ({ merchantId }) =>
			(await of(merchantId).find({ merchantId, status: 'pending' }).sort({ requestedAt: -1 }).limit(100).toArray()).map(
				presentRequest,
			),

		/**
		 * Approve (→ active issuer, `managedBy` the product) or reject the pending request.
		 * @param {{ merchantId: string, websiteId: string, decision: 'approve' | 'reject', reason?: string | null,
		 *   actor: Actor, meta?: Meta }} input
		 */
		decide: async ({ merchantId, websiteId, decision, reason = null, actor, meta = {} }) => {
			const website = await loadWebsite(websiteId, merchantId);
			const pending = await pendingOf(website);
			if (!pending) throw problem('not_found', 'This website has no pending identity issuer request.');
			const target = { type: 'website', id: websiteId, merchantId, websiteId };
			/** @type {Record<string, any> | null} */
			let issuer = null;
			if (decision === 'approve') {
				// the product must still be eligible (subscription and capability unchanged)
				await eligibleProduct(String(pending.appId), websiteId);
				issuer = await issuers.setIssuer({
					merchantId,
					websiteId,
					input: pending.input,
					actor,
					meta,
					managedBy: { appId: pending.appId, slug: pending.productSlug, name: pending.productName },
				});
			}
			const status = decision === 'approve' ? 'approved' : 'rejected';
			const decided = await of(merchantId).findOneAndUpdate(
				{ _id: websiteId, merchantId, status: 'pending', requestedAt: pending.requestedAt },
				{ $set: { status, decidedAt: new Date(ctx.now()), decidedBy: actor.id, reason } },
				{ returnDocument: 'after' },
			);
			if (!decided) throw problem('conflict', 'The request changed while you decided; review it again.');
			await audit(
				actor,
				decision === 'approve' ? 'website.identity_request_approved' : 'website.identity_request_rejected',
				target,
				{ after: { appId: pending.appId, issuer: pending.input.issuer }, ...(reason ? { reason } : {}), meta },
			);
			return { request: presentRequest(decided), issuer };
		},

		/**
		 * Drop the requests of deleted or transferred websites.
		 * @param {{ merchantId: string, websiteIds: string[] }} input
		 */
		forget: async ({ merchantId, websiteIds }) =>
			websiteIds.length === 0 ? 0 : (await of(merchantId).deleteMany({ merchantId, _id: { $in: websiteIds } })).deletedCount,
	});
};
/** @typedef {ReturnType<typeof createIssuerRequests>} IssuerRequests */
