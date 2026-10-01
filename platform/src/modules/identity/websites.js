/**
 * Websites: added by domain only (normalised with `@ss/contracts` `normaliseDomain`), each with a `test` twin that
 * shares the domain under a distinct id. A domain is claimed globally in `identity_domains` (`_id` = domain, so
 * concurrent claims race on the unique `_id`); deleting a website keeps the claim for a 30-day cooldown during which
 * only the same merchant may re-add it. Staff may transfer a website pair between merchants (keys are revoked —
 * they embed the merchant). Every mutation is audited.
 * @module
 */
import { normaliseDomain } from '@ss/contracts';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { presentWebsite } from './core/present.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

export const DOMAIN_COOLDOWN_MS = 30 * 24 * 60 * 60_000;
const MAX_WEBSITES_PER_MERCHANT = 500;

/**
 * A website document re-inserted under another merchant (the repository stamps the new merchantId).
 * @param {Record<string, any>} doc
 */
const movable = (doc) => {
	const copy = { ...doc };
	delete copy.merchantId;
	delete copy.updatedAt;
	return copy;
};

/**
 * @param {Deps} deps
 * @param {{
 *   activeMerchant: (merchantId: string) => Promise<Record<string, any>>,
 *   loadMerchant: (merchantId: string) => Promise<Record<string, any>>,
 *   revokeWebsiteKeys: (input: { merchantId: string, websiteIds: string[], reason: string, actor: any, meta?: Meta }) => Promise<string[]>,
 *   isPublicSuffix?: (domain: string) => boolean,
 * }} hooks
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
	 * The live id of a website pair (grants and domain claims reference the live website).
	 * @param {Record<string, any>} website
	 */
	const liveIdOf = (website) => (website.env === 'live' ? String(website._id) : String(website.twinId));

	/**
	 * Claim a domain for a merchant: new claim, an expired cooldown, or the same merchant's own cooldown.
	 * @param {string} domain
	 * @param {string} merchantId
	 * @param {string} websiteId
	 */
	const claimDomain = async (domain, merchantId, websiteId) => {
		const claim = { merchantId, websiteId, releaseAt: null, claimedAt: new Date(ctx.now()) };
		try {
			await repo.domains.insertOne({ _id: domain, ...claim });
			return;
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
		}
		const now = new Date(ctx.now());
		const taken = await repo.domains.updateOne(
			{ _id: domain, $or: [{ releaseAt: { $ne: null, $lte: now } }, { merchantId, releaseAt: { $ne: null } }] },
			{ $set: claim },
		);
		if (taken.modifiedCount !== 1) throw problem('domain_taken', 'This domain is already registered.');
	};

	return Object.freeze({
		loadWebsite,
		liveIdOf,

		/** @param {string} websiteId @param {string} [merchantId] */
		getWebsite: async (websiteId, merchantId) => presentWebsite(await loadWebsite(websiteId, merchantId)),

		/**
		 * Non-deleted websites of a merchant (live and test), oldest first.
		 * @param {string} merchantId
		 */
		listWebsites: async (merchantId) =>
			(
				await repo.websites
					.of(merchantId)
					.find({ merchantId, status: 'active' })
					.sort({ createdAt: 1, _id: 1 })
					.limit(2 * MAX_WEBSITES_PER_MERCHANT)
					.toArray()
			).map(presentWebsite),

		/**
		 * The active website for a domain (live by default), or null.
		 * @param {string} domain
		 * @param {{ env?: 'live' | 'test' }} [options]
		 */
		websiteByDomain: async (domain, { env = 'live' } = {}) => {
			const normalised = normaliseDomain(domain);
			if (!normalised.ok) return null;
			const doc = await repo.websites.all().findOne({ domain: normalised.value, env, status: 'active' });
			return doc ? presentWebsite(doc) : null;
		},

		/**
		 * Add a website by domain; creates the live website and its test twin.
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
			if ((await sites.countDocuments({ merchantId, status: 'active', env: 'live' })) >= MAX_WEBSITES_PER_MERCHANT)
				throw problem('conflict', `A merchant can have at most ${MAX_WEBSITES_PER_MERCHANT} websites.`);
			const liveId = repo.id('web');
			const testId = repo.id('web');
			await claimDomain(domain, merchantId, liveId);
			const base = { domain, status: 'active', deletedAt: null };
			const live = { _id: liveId, ...base, env: 'live', twinId: testId };
			const test = { _id: testId, ...base, env: 'test', twinId: liveId };
			try {
				await sites.insertMany([live, test]);
			} catch (error) {
				await sites.deleteMany({ merchantId, _id: { $in: [liveId, testId] } });
				await repo.domains.deleteOne({ _id: domain, websiteId: liveId });
				if (isDuplicateKey(error)) throw problem('domain_taken', 'This domain is already registered.');
				throw error;
			}
			await audit(
				actor,
				'website.created',
				{ type: 'website', id: liveId, merchantId, websiteId: liveId },
				{
					after: { domain, liveId, testId },
					meta,
				},
			);
			const at = new Date(ctx.now());
			return {
				website: presentWebsite({ ...live, merchantId, createdAt: at }),
				twin: presentWebsite({ ...test, merchantId, createdAt: at }),
			};
		},

		/**
		 * Soft-delete a website pair (either id): keys revoked, grants dropped, domain kept for the cooldown.
		 * @param {{ merchantId: string, websiteId: string, actor: Actor, meta?: Meta }} input
		 */
		deleteWebsite: async ({ merchantId, websiteId, actor, meta = {} }) => {
			const website = await loadWebsite(websiteId, merchantId);
			if (website.status !== 'active') throw problem('not_found', 'No such website.');
			const liveId = liveIdOf(website);
			const ids = [String(website._id), String(website.twinId)];
			const now = new Date(ctx.now());
			await repo.websites
				.of(merchantId)
				.updateMany({ merchantId, _id: { $in: ids }, status: 'active' }, { $set: { status: 'deleted', deletedAt: now } });
			const releaseAt = new Date(ctx.now() + DOMAIN_COOLDOWN_MS);
			await repo.domains.updateOne({ _id: website.domain, websiteId: liveId }, { $set: { releaseAt } });
			await hooks.revokeWebsiteKeys({ merchantId, websiteIds: ids, reason: 'website_deleted', actor, meta });
			await repo.memberships
				.of(merchantId)
				.updateMany({ merchantId, 'grants.websiteId': liveId }, { $pull: { grants: { websiteId: liveId } } });
			await audit(
				actor,
				'website.deleted',
				{ type: 'website', id: liveId, merchantId, websiteId: liveId },
				{
					before: { domain: website.domain, ids },
					after: { releaseAt: releaseAt.toISOString() },
					meta,
				},
			);
			return { websiteIds: ids, domainReleaseAt: releaseAt.toISOString() };
		},

		/**
		 * Staff: move a website pair to another merchant (keys revoked, source grants dropped).
		 * @param {{ websiteId: string, toMerchantId: string, reason: string, actor: Actor, meta?: Meta }} input
		 */
		transferWebsite: async ({ websiteId, toMerchantId, reason, actor, meta = {} }) => {
			const website = await loadWebsite(websiteId);
			if (website.status !== 'active') throw problem('conflict', 'Only active websites can be transferred.');
			const fromMerchantId = String(website.merchantId);
			if (fromMerchantId === toMerchantId) throw problem('conflict', 'The website already belongs to this merchant.');
			await hooks.activeMerchant(toMerchantId);
			const liveId = liveIdOf(website);
			const ids = [liveId, website.env === 'live' ? String(website.twinId) : String(website._id)];
			const source = repo.websites.of(fromMerchantId);
			const target = repo.websites.of(toMerchantId);
			const docs = await source.find({ merchantId: fromMerchantId, _id: { $in: ids } }).toArray();
			await hooks.revokeWebsiteKeys({
				merchantId: fromMerchantId,
				websiteIds: ids,
				reason: 'website_transferred',
				actor,
				meta,
			});
			// tenant records cannot change merchantId: move them (delete + insert, compensating on failure)
			await source.deleteMany({ merchantId: fromMerchantId, _id: { $in: ids } });
			try {
				await target.insertMany(docs.map(movable));
			} catch (error) {
				await target.deleteMany({ merchantId: toMerchantId, _id: { $in: ids } });
				await source.insertMany(docs.map(movable));
				throw error;
			}
			await repo.domains.updateOne({ _id: website.domain, websiteId: liveId }, { $set: { merchantId: toMerchantId } });
			await repo.memberships
				.of(fromMerchantId)
				.updateMany({ merchantId: fromMerchantId, 'grants.websiteId': liveId }, { $pull: { grants: { websiteId: liveId } } });
			for (const merchantId of [fromMerchantId, toMerchantId]) {
				await audit(
					actor,
					'website.transferred',
					{ type: 'website', id: liveId, merchantId, websiteId: liveId },
					{
						before: { merchantId: fromMerchantId },
						after: { merchantId: toMerchantId },
						reason,
						meta,
					},
				);
			}
			return presentWebsite({ ...(await loadWebsite(liveId, toMerchantId)) });
		},
	});
};
/** @typedef {ReturnType<typeof createWebsites>} Websites */
