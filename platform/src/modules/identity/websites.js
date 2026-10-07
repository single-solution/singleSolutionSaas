/**
 * Websites (PLAN 0.2 Websites, 0.5.9): one exact domain each (normalised with `@ss/contracts` `normaliseDomain`:
 * lowercase, punycode, no scheme, path, port or trailing dot; IP addresses, localhost, single-label names and wildcards
 * refused), added and removed only by Owner and Support. A domain belongs to at most one website platform-wide: it is
 * claimed in `identity_domains` (`_id` = domain, so concurrent claims race on the unique `_id`). A website can be
 * removed only after its products are removed; the domain is then free again at once, for any merchant, and the
 * website's tokens stop for good. Until the switch (PLAN 0.12 step 5) each website keeps its `test` twin and its
 * settings (`timeZone`, `language`, `currency`). Every change is written to Activity.
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
 *   revokeWebsiteKeys: (input: { merchantId: string, websiteIds: string[], reason: string, actor: any, meta?: Meta }) => Promise<string[]>,
 *   isPublicSuffix?: (domain: string) => boolean,
 *   forgetIssuers?: (input: { merchantId: string, websiteIds: string[] }) => Promise<unknown>,
 *   resign?: (websiteId: string) => Promise<unknown>,
 * }} hooks `productsOn`: products not removed from the website (commerce); `resign`: re-sign the website's
 *   entitlement documents (commerce)
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
				if (isDuplicateKey(error)) throw problem('domain_taken', 'This domain already belongs to a website.');
				throw error;
			}
			await audit(
				actor,
				'website.added',
				{ type: 'website', id: liveId, merchantId, websiteId: liveId },
				{
					after: { domain },
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
		 * Change the website settings of a pair (either id): `timeZone` (IANA), `language` (BCP 47), `currency`
		 * (ISO 4217); `null` clears one. Re-signs the documents of both websites (the `website` section is hashed).
		 * @param {{ merchantId: string, websiteId: string, settings: { timeZone?: string | null, language?: string | null,
		 *   currency?: string | null }, actor: Actor, meta?: Meta }} input
		 */
		updateSettings: async ({ merchantId, websiteId, settings, actor, meta = {} }) => {
			const website = await loadWebsite(websiteId, merchantId);
			if (website.status !== 'active') throw problem('not_found', 'No such website.');
			const ids = [String(website._id), String(website.twinId)];
			const before = { ...(website.settings ?? {}) };
			/** @type {Record<string, unknown>} */
			const set = {};
			/** @type {Record<string, ''>} */
			const unset = {};
			for (const [name, value] of Object.entries(settings)) {
				if (value === undefined) continue;
				if (value === null) unset[`settings.${name}`] = '';
				else set[`settings.${name}`] = value;
			}
			await repo.websites.of(merchantId).updateMany(
				{ merchantId, _id: { $in: ids }, status: 'active' },
				{
					...(Object.keys(set).length > 0 ? { $set: set } : {}),
					...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
				},
			);
			const updated = await loadWebsite(String(website._id), merchantId);
			const liveId = liveIdOf(website);
			await audit(
				actor,
				'website.settings_updated',
				{ type: 'website', id: liveId, merchantId, websiteId: liveId },
				{ before, after: { ...(updated.settings ?? {}) }, meta },
			);
			for (const id of ids) await hooks.resign?.(id);
			return presentWebsite(updated);
		},

		/**
		 * Remove a website (either id of the pair; typed confirmation with the domain): only once its products are
		 * removed. Its tokens stop for good, the domain is free again at once, and past usage and Activity are kept.
		 * @param {{ merchantId: string, websiteId: string, confirm: string, actor: Actor, meta?: Meta }} input
		 */
		removeWebsite: async ({ merchantId, websiteId, confirm, actor, meta = {} }) => {
			const website = await loadWebsite(websiteId, merchantId);
			if (website.status !== 'active') throw problem('not_found', 'No such website.');
			if (confirm !== website.domain) throw problem('validation_failed', 'Type the domain exactly to confirm.');
			const liveId = liveIdOf(website);
			const ids = [String(website._id), String(website.twinId)];
			for (const id of ids)
				if ((await hooks.productsOn(id)) > 0) throw problem('products_on_website', 'Remove its products first.');
			const now = new Date(ctx.now());
			await repo.websites
				.of(merchantId)
				.updateMany({ merchantId, _id: { $in: ids }, status: 'active' }, { $set: { status: 'removed', deletedAt: now } });
			await repo.domains.deleteOne({ _id: website.domain, websiteId: liveId });
			await hooks.revokeWebsiteKeys({ merchantId, websiteIds: ids, reason: 'website_removed', actor, meta });
			await hooks.forgetIssuers?.({ merchantId, websiteIds: ids });
			await audit(
				actor,
				'website.removed',
				{ type: 'website', id: liveId, merchantId, websiteId: liveId },
				{
					before: { domain: website.domain },
					meta,
				},
			);
			return { websiteIds: ids };
		},

		/**
		 * Active websites of a merchant (live only; Delete merchant needs none).
		 * @param {string} merchantId
		 */
		activeWebsitesOf: async (merchantId) =>
			repo.websites
				.of(merchantId)
				.find({ merchantId, status: 'active', env: 'live' })
				.limit(MAX_WEBSITES_PER_MERCHANT)
				.toArray(),
	});
};
/** @typedef {ReturnType<typeof createWebsites>} Websites */
