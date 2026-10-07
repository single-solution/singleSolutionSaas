/**
 * Websites (PLAN 0.2 Websites, 0.5.9): one exact domain each (normalised with `@ss/contracts` `normaliseDomain`:
 * lowercase, punycode, no scheme, path, port or trailing dot; IP addresses, localhost, single-label names and wildcards
 * refused), added and removed only by Owner and Support. A domain belongs to at most one website platform-wide: it is
 * claimed in `identity_domains` (`_id` = domain, so concurrent claims race on the unique `_id`). A website can be
 * removed only after its products are removed; then its tokens are revoked for good, every product it ever had gets
 * `website.deleted`, and the domain is free again at once, for any merchant. Every change is written to Activity.
 * @module
 */
import { normaliseDomain } from '@ss/contracts';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { presentWebsite } from './core/present.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

const MAX_WEBSITES_PER_MERCHANT = 500;

/**
 * @param {Deps} deps
 * @param {{
 *   activeMerchant: (merchantId: string) => Promise<Record<string, any>>,
 *   productsOn: (websiteId: string) => Promise<number>,
 *   onRemoved: (input: { merchantId: string, websiteId: string }) => Promise<unknown>,
 *   isPublicSuffix?: (domain: string) => boolean,
 * }} hooks `productsOn`: products not removed from the website (commerce); `onRemoved`: revoke its tokens and tell
 *   its products (`website.deleted`)
 */
export const createWebsites = (deps, hooks) => {
	const { ctx, repo, audit } = deps;

	/**
	 * Load a website by id — scoped to a merchant when given (tenant routes), across merchants otherwise.
	 * @param {string} websiteId
	 * @param {string} [merchantId]
	 */
	const loadWebsite = async (websiteId, merchantId) => {
		const doc = merchantId
			? await repo.websites.of(merchantId).findOne({ merchantId, _id: websiteId })
			: await repo.websites.all().findOne({ _id: websiteId });
		if (!doc) throw problem('not_found', 'No such website.');
		return doc;
	};

	/**
	 * Claim a domain for a website (a domain belongs to at most one website platform-wide).
	 * @param {string} domain
	 * @param {string} merchantId
	 * @param {string} websiteId
	 */
	const claimDomain = async (domain, merchantId, websiteId) => {
		try {
			await repo.domains.insertOne({ _id: domain, merchantId, websiteId, claimedAt: new Date(ctx.now()) });
		} catch (error) {
			if (isDuplicateKey(error)) throw problem('domain_taken', 'This domain already belongs to a website.');
			throw error;
		}
	};

	return Object.freeze({
		loadWebsite,

		/** @param {string} websiteId @param {string} [merchantId] */
		getWebsite: async (websiteId, merchantId) => presentWebsite(await loadWebsite(websiteId, merchantId)),

		/**
		 * Active websites of a merchant, oldest first.
		 * @param {string} merchantId
		 */
		listWebsites: async (merchantId) =>
			(
				await repo.websites
					.of(merchantId)
					.find({ merchantId, status: 'active' })
					.sort({ createdAt: 1, _id: 1 })
					.limit(MAX_WEBSITES_PER_MERCHANT)
					.toArray()
			).map(presentWebsite),

		/**
		 * Websites by id across merchants (active and removed), for lists that show a domain.
		 * @param {readonly string[]} websiteIds
		 * @returns {Promise<Map<string, ReturnType<typeof presentWebsite>>>}
		 */
		websitesByIds: async (websiteIds) => {
			/** @type {Map<string, ReturnType<typeof presentWebsite>>} */
			const out = new Map();
			for (const websiteId of new Set(websiteIds)) {
				const doc = await repo.websites.all().findOne({ _id: websiteId });
				if (doc) out.set(websiteId, presentWebsite(doc));
			}
			return out;
		},

		/**
		 * Add a website by domain.
		 * @param {{ merchantId: string, domain: string, actor: Actor, meta?: Meta }} input
		 */
		createWebsite: async ({ merchantId, domain: input, actor, meta = {} }) => {
			const normalised = normaliseDomain(input, hooks.isPublicSuffix ? { isPublicSuffix: hooks.isPublicSuffix } : {});
			if (!normalised.ok)
				throw problem('validation_failed', normalised.message, {
					errors: [{ path: '/domain', message: normalised.message }],
				});
			const domain = normalised.value;
			await hooks.activeMerchant(merchantId);
			const sites = repo.websites.of(merchantId);
			if ((await sites.countDocuments({ merchantId, status: 'active' })) >= MAX_WEBSITES_PER_MERCHANT)
				throw problem('conflict', `A merchant can have at most ${MAX_WEBSITES_PER_MERCHANT} websites.`);
			const websiteId = repo.id('web');
			await claimDomain(domain, merchantId, websiteId);
			const doc = { _id: websiteId, domain, status: 'active', removedAt: null };
			try {
				await sites.insertOne(doc);
			} catch (error) {
				await repo.domains.deleteOne({ _id: domain, websiteId });
				if (isDuplicateKey(error)) throw problem('domain_taken', 'This domain already belongs to a website.');
				throw error;
			}
			await audit(
				actor,
				'website.added',
				{ type: 'website', id: websiteId, merchantId, websiteId },
				{ after: { domain }, meta },
			);
			return { website: presentWebsite({ ...doc, merchantId, createdAt: new Date(ctx.now()) }) };
		},

		/**
		 * Remove a website (typed confirmation with the domain): only once its products are removed. Its tokens stop for
		 * good, its products delete what they hold for it, the domain is free again at once, and past usage and Activity
		 * are kept.
		 * @param {{ merchantId: string, websiteId: string, confirm: string, actor: Actor, meta?: Meta }} input
		 */
		removeWebsite: async ({ merchantId, websiteId, confirm, actor, meta = {} }) => {
			const website = await loadWebsite(websiteId, merchantId);
			if (website.status !== 'active') throw problem('not_found', 'No such website.');
			if (confirm !== website.domain) throw problem('validation_failed', 'Type the domain exactly to confirm.');
			if ((await hooks.productsOn(websiteId)) > 0) throw problem('products_on_website', 'Remove its products first.');
			const removed = await repo.websites
				.of(merchantId)
				.updateOne(
					{ merchantId, _id: websiteId, status: 'active' },
					{ $set: { status: 'removed', removedAt: new Date(ctx.now()) } },
				);
			if (removed.modifiedCount !== 1) throw problem('not_found', 'No such website.');
			await repo.domains.deleteOne({ _id: website.domain, websiteId });
			await hooks.onRemoved({ merchantId, websiteId });
			await audit(
				actor,
				'website.removed',
				{ type: 'website', id: websiteId, merchantId, websiteId },
				{ before: { domain: website.domain }, meta },
			);
			return { websiteId };
		},

		/**
		 * Active websites of a merchant (Delete merchant needs none).
		 * @param {string} merchantId
		 */
		activeWebsitesOf: async (merchantId) =>
			repo.websites.of(merchantId).find({ merchantId, status: 'active' }).limit(MAX_WEBSITES_PER_MERCHANT).toArray(),
	});
};
/** @typedef {ReturnType<typeof createWebsites>} Websites */
