/**
 * Merchants (PLAN 0.2 Merchants, 0.5.9, 0.8.2): one record holding the business details and exactly one login. Only
 * an admin creates one; the merchant gets a setup link. Admins edit the details (the login e-mail only until the
 * password is set); the merchant edits its own in Account. Suspend blocks sign-in and launches and ends sessions;
 * resume restores. Delete (only without websites) erases the login and personal details and keeps the records under
 * the business name. Every change is written to Activity, without personal details (so nothing needs blanking when a
 * merchant is deleted: screens show "Deleted merchant" for them).
 * @module
 */
import { problem } from '../../infra/http.js';
import { presentMerchant } from './core/present.js';
import { nameKey, parseMerchantQuery, prefixPattern } from './core/search.js';
import { sendLater } from './repo.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./core/inputs.js').MerchantFields} MerchantFields */

const PERSONAL = Object.freeze(['ownerName', 'email', 'phone', 'address', 'country']);

/**
 * @param {Deps} deps
 * @param {{
 *   setupLink: (kind: 'merchant', id: string) => Promise<{ link: string, expiresAt: string }>,
 *   websitesOf: (merchantId: string) => Promise<Array<Record<string, any>>>,
 *   onStatus: (merchantId: string, status: 'active' | 'suspended') => Promise<void>,
 * }} hooks `onStatus` lets commerce react to suspend and resume
 */
export const createMerchants = (deps, hooks) => {
	const { ctx, repo, audit } = deps;

	/** @param {string} merchantId */
	const load = async (merchantId) => {
		const merchant = await repo.merchants.findOne({ _id: merchantId });
		if (!merchant || merchant.status === 'deleted') throw problem('not_found', 'No such merchant.');
		return merchant;
	};

	/** @param {string} merchantId the merchant, deleted ones included (records kept under the business name) */
	const loadAny = async (merchantId) => {
		const merchant = await repo.merchants.findOne({ _id: merchantId });
		if (!merchant) throw problem('not_found', 'No such merchant.');
		return merchant;
	};

	/**
	 * Send (or hand back for copying) a setup link; a new link cancels the previous one. Offered only until the
	 * password is set.
	 * @param {Record<string, any>} merchant
	 * @param {{ copy?: boolean, actor: Actor, meta?: Meta }} input
	 */
	const deliver = async (merchant, { copy = false, actor, meta = {} }) => {
		if (merchant.passwordHash) throw problem('conflict', 'The password is already set: the merchant uses Forgot password.');
		const setup = await hooks.setupLink('merchant', String(merchant._id));
		const target = { type: 'merchant', id: String(merchant._id), merchantId: String(merchant._id) };
		if (copy) {
			await audit(actor, 'merchant.setup_link_copied', target, { meta });
			return { link: setup.link, expiresAt: setup.expiresAt, mailed: false };
		}
		const mailed = await sendLater(deps, {
			to: merchant.email,
			template: 'merchant_setup',
			data: { link: setup.link, merchantName: merchant.name },
		});
		await audit(actor, 'merchant.setup_link_sent', target, { after: { mailed }, meta });
		return { link: null, expiresAt: setup.expiresAt, mailed };
	};

	/**
	 * @param {'active' | 'suspended'} status
	 * @returns {(input: { merchantId: string, reason?: string, actor: Actor, meta?: Meta }) => Promise<ReturnType<typeof presentMerchant>>}
	 */
	const setStatus =
		(status) =>
		async ({ merchantId, reason, actor, meta = {} }) => {
			if (status === 'suspended' && (typeof reason !== 'string' || reason.trim().length === 0))
				throw problem('validation_failed', 'A reason is required.', {
					errors: [{ path: '/reason', message: 'is required' }],
				});
			const merchant = await load(merchantId);
			if (merchant.status === status) return presentMerchant(merchant);
			const suspension = status === 'suspended' ? { reason, at: new Date(ctx.now()), by: actor.id } : null;
			const changed = await repo.merchants.updateOne(
				{ _id: merchantId, status: merchant.status },
				{ $set: { status, suspension } },
			);
			if (changed.modifiedCount !== 1) return presentMerchant(await load(merchantId));
			// suspended: no sign-in, every Portal session ends (product dashboard sessions end with the notices of step 5)
			if (status === 'suspended') await ctx.sessions.revokeAll('merchant', merchantId);
			await audit(
				actor,
				status === 'suspended' ? 'merchant.suspended' : 'merchant.resumed',
				{ type: 'merchant', id: merchantId, merchantId },
				{ before: { status: merchant.status }, after: { status }, reason: reason ?? null, meta },
			);
			await hooks.onStatus(merchantId, status);
			return presentMerchant({ ...merchant, status, suspension });
		};

	const suspend = setStatus('suspended');
	const resume = setStatus('active');

	return Object.freeze({
		load,
		loadAny,
		/** @param {string} merchantId */
		get: async (merchantId) => presentMerchant(await load(merchantId)),

		/**
		 * Create a merchant (Owner, Support): the login e-mail is claimed (unique across the Portal) and a 72-hour setup
		 * link is e-mailed when e-mail sending is set (else the admin copies it).
		 * @param {MerchantFields & { actor: Actor, meta?: Meta }} input
		 */
		create: async ({ name, ownerName, email, phone, address, country, actor, meta = {} }) => {
			const merchantId = repo.id('mer');
			await repo.claimLogin(email, 'merchant', merchantId);
			const doc = {
				_id: merchantId,
				name,
				nameKey: nameKey(name),
				ownerName,
				email,
				phone,
				address,
				country,
				status: 'active',
				suspension: null,
				passwordHash: null,
				totp: null,
				pendingTotp: null,
				recoveryHashes: [],
				lastSignInAt: null,
				deletedAt: null,
			};
			try {
				await repo.merchants.insertOne(doc);
			} catch (error) {
				await repo.releaseLogin(email, merchantId);
				throw error;
			}
			await audit(actor, 'merchant.created', { type: 'merchant', id: merchantId, merchantId }, { after: { name }, meta });
			const setup = await deliver(doc, { actor, meta });
			return { merchant: presentMerchant({ ...doc, createdAt: new Date(ctx.now()) }), setup };
		},

		/**
		 * Edit the merchant fields. Admins may change the login e-mail only until the password is set; the merchant
		 * changes it in Account with a confirmation (accounts).
		 * @param {Partial<MerchantFields> & { merchantId: string, actor: Actor, meta?: Meta }} input
		 */
		update: async ({ merchantId, actor, meta = {}, ...fields }) => {
			const merchant = await load(merchantId);
			/** @type {Record<string, unknown>} */
			const set = {};
			for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== merchant[key]) set[key] = value;
			if (set.email !== undefined) {
				if (merchant.passwordHash || actor.type !== 'admin')
					throw problem('conflict', 'The login e-mail can be corrected only until the password is set.');
				await repo.claimLogin(/** @type {string} */ (set.email), 'merchant', merchantId);
			}
			if (set.name !== undefined) set.nameKey = nameKey(set.name);
			if (Object.keys(set).length === 0) return presentMerchant(merchant, { forAdmin: actor.type === 'admin' });
			await repo.merchants.updateOne({ _id: merchantId }, { $set: set });
			if (set.email !== undefined) {
				await repo.releaseLogin(merchant.email, merchantId);
				await repo.dropTokens('setup', `merchant:${merchantId}`);
			}
			// Activity names the fields, never their values (personal details stay out of the log)
			await audit(
				actor,
				'merchant.edited',
				{ type: 'merchant', id: merchantId, merchantId },
				{
					after: { fields: Object.keys(set).filter((k) => k !== 'nameKey') },
					...(set.name !== undefined ? { before: { name: merchant.name } } : {}),
					meta,
				},
			);
			return presentMerchant({ ...merchant, ...set }, { forAdmin: actor.type === 'admin' });
		},

		suspend,
		resume,

		/**
		 * Resend or copy the setup link (Owner, Support; only until the password is set).
		 * @param {{ merchantId: string, copy?: boolean, actor: Actor, meta?: Meta }} input
		 */
		setupLink: async ({ merchantId, copy = false, actor, meta = {} }) => deliver(await load(merchantId), { copy, actor, meta }),

		/**
		 * Bulk actions of the Merchants list (PLAN 0.6): Suspend / Resume with one reason for all, and Resend setup link
		 * for merchants without a password. Each merchant succeeds or fails on its own.
		 * @param {{ action: 'suspend' | 'resume' | 'resend_setup_link', merchantIds: string[], reason?: string, actor: Actor, meta?: Meta }} input
		 */
		bulk: async ({ action, merchantIds, reason, actor, meta = {} }) => {
			if (action === 'suspend' && !reason)
				throw problem('validation_failed', 'A reason is required.', {
					errors: [{ path: '/reason', message: 'is required' }],
				});
			/** @type {Array<{ merchantId: string, ok: boolean, detail?: string }>} */
			const results = [];
			for (const merchantId of merchantIds) {
				try {
					if (action === 'suspend') await suspend({ merchantId, reason: /** @type {string} */ (reason), actor, meta });
					else if (action === 'resume') await resume({ merchantId, actor, meta });
					else await deliver(await load(merchantId), { actor, meta });
					results.push({ merchantId, ok: true });
				} catch (error) {
					results.push({ merchantId, ok: false, detail: String(/** @type {any} */ (error)?.detail ?? 'failed') });
				}
			}
			return { results };
		},

		/**
		 * Merchants page (by id), deleted ones excluded, optionally filtered by status and searched by `q`: a case- and
		 * accent-insensitive prefix of the business name, or of the owner e-mail (`@`), or of a website domain (PLAN 0.6:
		 * the Merchants search is how an admin finds a website).
		 * @param {{ after: string | null, limit: number, status?: string, q?: string }} input
		 */
		list: async ({ after, limit, status, q }) => {
			const search = parseMerchantQuery(q);
			/** @type {Record<string, unknown>} */
			const filter = { status: status ?? { $ne: 'deleted' }, ...(after ? { _id: { $gt: after } } : {}) };
			if (search?.kind === 'email') filter.email = { $regex: prefixPattern(search.prefix) };
			if (search?.kind === 'name') {
				const domainPrefix = String(q ?? '')
					.trim()
					.toLowerCase();
				const sites = /^[a-z0-9.-]+$/.test(domainPrefix)
					? await repo.websites
							.all()
							.find({ domain: { $regex: prefixPattern(domainPrefix) }, status: 'active' })
							.project({ merchantId: 1 })
							.limit(500)
							.toArray()
					: [];
				const ids = [...new Set(sites.map((s) => String(s.merchantId)))];
				filter.$or = [
					{ nameKey: { $regex: prefixPattern(search.prefix) } },
					...(ids.length > 0 ? [{ _id: { $in: ids } }] : []),
				];
			}
			return (await repo.merchants.find(filter).sort({ _id: 1 }).limit(limit).toArray()).map((m) => presentMerchant(m));
		},

		/**
		 * Delete a merchant (Owner; typed confirmation with the business name): only without websites (removed ones do
		 * not count). The login and personal details are erased, every session ends, the e-mail is free; credits are
		 * forfeited. Receipts, day charges and Activity stay under the business name, marked Deleted.
		 * @param {{ merchantId: string, confirm: string, actor: Actor, meta?: Meta }} input
		 */
		remove: async ({ merchantId, confirm, actor, meta = {} }) => {
			const merchant = await load(merchantId);
			if (confirm !== merchant.name) throw problem('validation_failed', 'Type the business name exactly to confirm.');
			if ((await hooks.websitesOf(merchantId)).length > 0)
				throw problem('conflict', 'Remove the websites of this merchant first.');
			/** @type {Record<string, unknown>} */
			const erased = Object.fromEntries(PERSONAL.map((key) => [key, null]));
			await repo.merchants.updateOne(
				{ _id: merchantId },
				{
					$set: {
						...erased,
						status: 'deleted',
						deletedAt: new Date(ctx.now()),
						passwordHash: null,
						totp: null,
						pendingTotp: null,
						recoveryHashes: [],
						suspension: null,
					},
				},
			);
			if (merchant.email) await repo.releaseLogin(merchant.email, merchantId);
			for (const purpose of /** @type {const} */ (['setup', 'password_reset', 'email_change', 'two_step']))
				await repo.dropTokens(purpose, `merchant:${merchantId}`);
			await ctx.sessions.revokeAll('merchant', merchantId);
			await audit(
				actor,
				'merchant.deleted',
				{ type: 'merchant', id: merchantId, merchantId },
				{ before: { name: merchant.name }, meta },
			);
		},

		/**
		 * Names of merchants by id (Activity and lists), deleted ones included.
		 * @param {string[]} ids
		 */
		namesOf: async (ids) => {
			const docs = await repo.merchants
				.find({ _id: { $in: [...new Set(ids)] } })
				.project({ name: 1, status: 1 })
				.toArray();
			return new Map(docs.map((d) => [String(d._id), { name: d.name, deleted: d.status === 'deleted' }]));
		},
	});
};
/** @typedef {ReturnType<typeof createMerchants>} Merchants */
