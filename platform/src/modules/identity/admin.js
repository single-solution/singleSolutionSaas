/**
 * Staff operations: merchant creation (owner without a password plus a one-time set-password link), merchant suspension (with reason; commerce reacts through `onMerchantStatus`), merchant listing,
 * staff users (created without a password — they set one through a mailed setup link; two-factor sign-in once they
 * enrol). Every mutation is audited.
 * @module
 */
import { problem } from '../../infra/http.js';
import { presentMerchant, presentStaff } from './core/present.js';
import { insertUnique, requireMailer, sendQuietly } from './repo.js';
import { nameKey, parseMerchantQuery, prefixPattern } from './core/search.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('./repo.js').AuditActor} AuditActor */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

/**
 * @param {Deps} deps
 * @param {{
 *   loadMerchant: (merchantId: string) => Promise<Record<string, any>>,
 *   staffSetupLink: (staffId: string, options?: { ttlMs?: number }) => Promise<string>,
 *   staffWelcomeTtlMs: number,
 *   merchantSetupLink: (userId: string) => Promise<{ link: string, expiresAt: string }>,
 * }} hooks
 */
export const createAdmin = (deps, hooks) => {
	const { ctx, repo, mailer, audit } = deps;

	/**
	 * Let commerce react (pause/resume billing). Best effort: identity's state change stands either way.
	 * @param {string} merchantId
	 * @param {'active' | 'suspended'} status
	 */
	const notifyCommerce = async (merchantId, status) => {
		if (!ctx.moduleNames().includes('commerce')) return;
		try {
			const commerce = ctx.service('commerce');
			if (typeof commerce.onMerchantStatus === 'function') await commerce.onMerchantStatus({ merchantId, status });
		} catch (error) {
			ctx.logger.error('commerce.onMerchantStatus failed', { error, merchantId, status });
		}
	};

	/**
	 * @param {'active' | 'suspended'} status
	 * @returns {(input: { merchantId: string, reason: string, actor?: Actor | AuditActor, meta?: Meta }) => Promise<ReturnType<typeof presentMerchant>>}
	 */
	const setStatus =
		(status) =>
		async ({ merchantId, reason, actor, meta = {} }) => {
			const who = actor ?? { type: /** @type {'system'} */ ('system'), id: 'identity' };
			if (typeof reason !== 'string' || reason.trim().length === 0)
				throw problem('validation_failed', 'A reason is required.');
			const merchant = await hooks.loadMerchant(merchantId);
			if (merchant.status === status) return presentMerchant(merchant);
			const suspension = status === 'suspended' ? { reason, at: new Date(ctx.now()), by: who.id } : null;
			const changed = await repo.merchants.updateOne(
				{ _id: merchantId, status: merchant.status },
				{ $set: { status, suspension } },
			);
			if (changed.modifiedCount !== 1) return presentMerchant(await hooks.loadMerchant(merchantId));
			await audit(
				who,
				status === 'suspended' ? 'merchant.suspended' : 'merchant.resumed',
				{
					type: 'merchant',
					id: merchantId,
					merchantId,
				},
				{ before: { status: merchant.status }, after: { status }, reason, meta },
			);
			await notifyCommerce(merchantId, status);
			return presentMerchant({ ...merchant, status, suspension });
		};

	/** @param {string} staffId */
	const loadStaff = async (staffId) => {
		const staff = await repo.staff.findOne({ _id: staffId });
		if (!staff) throw problem('not_found', 'No such staff user.');
		return staff;
	};

	/**
	 * @param {Record<string, any>} staff
	 * @param {Partial<{ roles: string[], status: string }>} next
	 */
	const keepsASuperadmin = async (staff, next) => {
		const wasSuper = staff.status === 'active' && staff.roles.includes('superadmin');
		const staysSuper = (next.status ?? staff.status) === 'active' && (next.roles ?? staff.roles).includes('superadmin');
		if (!wasSuper || staysSuper) return true;
		const others = await repo.staff.countDocuments({ _id: { $ne: staff._id }, status: 'active', roles: 'superadmin' });
		return others > 0;
	};

	return Object.freeze({
		/**
		 * Create a merchant and its owner. A new owner is an active user without a password; the result carries a
		 * one-time set-password link (72 h) for staff to pass on, also mailed when mail is configured. An existing user
		 * becomes the owner of the new merchant (no link: they sign in with their own password; mailed a notice).
		 * @param {{ name: string, ownerEmail: string, ownerName?: string, actor: Actor, meta?: Meta }} input
		 */
		createMerchant: async ({ name, ownerEmail, ownerName, actor, meta = {} }) => {
			const existing = await repo.users.findOne({ email: ownerEmail });
			if (existing && existing.status !== 'active') throw problem('conflict', 'The user with this e-mail is disabled.');
			const user = existing ?? {
				_id: repo.id('usr'),
				email: ownerEmail,
				name: ownerName ?? null,
				status: 'active',
				passwordHash: null,
				emailVerifiedAt: null,
				totp: null,
				pendingTotp: null,
				recoveryHashes: [],
			};
			if (!existing)
				await insertUnique(() => repo.users.insertOne(user), 'conflict', 'A user with this e-mail was just created; retry.');
			const merchantId = repo.id('mer');
			const merchant = {
				_id: merchantId,
				name,
				nameKey: nameKey(name),
				status: 'active',
				ownerUserId: user._id,
				suspension: null,
			};
			await repo.merchants.insertOne(merchant);
			await repo.memberships.of(merchantId).insertOne({ _id: repo.id('mbr'), userId: user._id, roles: ['owner'], grants: [] });
			const setup = existing?.passwordHash ? null : await hooks.merchantSetupLink(String(user._id));
			const mailed = mailer.available !== false;
			if (mailed)
				await sendQuietly(deps, {
					to: ownerEmail,
					template: setup ? 'merchant_welcome' : 'merchant_added',
					data: { link: setup?.link ?? `${ctx.config.portalUrl.replace(/\/+$/, '')}/login`, merchantName: name },
				});
			await audit(
				actor,
				'merchant.created',
				{ type: 'merchant', id: merchantId, merchantId },
				{ after: { name, ownerUserId: user._id, existingUser: Boolean(existing) }, meta },
			);
			return {
				merchant: presentMerchant({ ...merchant, createdAt: new Date(ctx.now()) }),
				owner: { userId: String(user._id), email: ownerEmail, existing: Boolean(existing) },
				setupLink: setup?.link ?? null,
				setupLinkExpiresAt: setup?.expiresAt ?? null,
				mailed,
			};
		},

		suspendMerchant: setStatus('suspended'),
		resumeMerchant: setStatus('active'),

		/**
		 * Merchants page (by id), optionally filtered by status and searched by `q`: a case- and accent-insensitive
		 * prefix of the name (index `{ nameKey: 1 }`), or — when `q` contains `@` — a prefix of a team member's
		 * e-mail (unique e-mail index, then memberships by user).
		 * @param {{ after: string | null, limit: number, status?: string, q?: string }} input
		 */
		listMerchants: async ({ after, limit, status, q }) => {
			const search = parseMerchantQuery(q);
			/** @type {Record<string, unknown>} */
			const filter = { ...(status ? { status } : {}), ...(after ? { _id: { $gt: after } } : {}) };
			if (search?.kind === 'name') filter.nameKey = { $regex: prefixPattern(search.prefix) };
			if (search?.kind === 'email') {
				const users = await repo.users
					.find({ email: { $regex: prefixPattern(search.prefix) } })
					.project({ _id: 1 })
					.limit(200)
					.toArray();
				if (users.length === 0) return [];
				const members = await repo.memberships
					.all()
					.find({ userId: { $in: users.map((u) => String(u._id)) } })
					.project({ merchantId: 1 })
					.limit(1000)
					.toArray();
				const ids = [...new Set(members.map((m) => String(m.merchantId)))];
				filter._id = after ? { $gt: after, $in: ids } : { $in: ids };
			}
			return repo.merchants.find(filter).sort({ _id: 1 }).limit(limit).toArray();
		},
		presentMerchant,

		// -----------------------------------------------------------------------------------------------------------
		// Merchant notes (append-only, staff only)

		/**
		 * Newest-first staff notes of a merchant (keyset pagination on `{ createdAt, _id }`).
		 * @param {{ merchantId: string, before?: { at: Date, id: string } | null, limit: number }} input
		 */
		listNotes: async ({ merchantId, before = null, limit }) => {
			await hooks.loadMerchant(merchantId);
			const filter = {
				merchantId,
				...(before ? { $or: [{ createdAt: { $lt: before.at } }, { createdAt: before.at, _id: { $lt: before.id } }] } : {}),
			};
			const docs = await repo.notes.of(merchantId).find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
			return docs.map(presentNote);
		},

		/**
		 * Append a note (audited on the merchant's chain; the body is not copied into the audit entry).
		 * @param {{ merchantId: string, body: string, actor: Actor, meta?: Meta }} input
		 */
		addNote: async ({ merchantId, body, actor, meta = {} }) => {
			await hooks.loadMerchant(merchantId);
			const staff = await repo.staff.findOne({ _id: actor.id });
			const doc = {
				_id: repo.id('nte'),
				merchantId,
				body,
				by: { staffId: actor.id, name: staff?.name ?? null, email: staff?.email ?? null },
			};
			await repo.notes.of(merchantId).insertOne(doc);
			await audit(
				actor,
				'merchant.note_added',
				{ type: 'merchant', id: merchantId, merchantId },
				{
					after: { noteId: doc._id, length: body.length },
					meta,
				},
			);
			return presentNote({ ...doc, createdAt: new Date(ctx.now()) });
		},

		// -----------------------------------------------------------------------------------------------------------
		// Staff

		listStaff: async () => (await repo.staff.find({}).sort({ createdAt: 1, _id: 1 }).limit(1000).toArray()).map(presentStaff),

		/** @param {string} staffId */
		getStaff: async (staffId) => presentStaff(await loadStaff(staffId)),

		/**
		 * Create a staff user without a password and mail a 24 h setup link.
		 * @param {{ email: string, name?: string, roles: string[], actor: Actor, meta?: Meta }} input
		 */
		createStaff: async ({ email, name, roles, actor, meta = {} }) => {
			requireMailer(mailer);
			const doc = {
				_id: repo.id('stf'),
				email,
				name: name ?? null,
				roles,
				status: 'active',
				passwordHash: null,
				totp: null,
				pendingTotp: null,
				recoveryHashes: [],
				createdBy: actor.id,
			};
			await insertUnique(() => repo.staff.insertOne(doc), 'conflict', 'A staff user with this e-mail exists.');
			const link = await hooks.staffSetupLink(doc._id, { ttlMs: hooks.staffWelcomeTtlMs });
			await sendQuietly(deps, { to: email, template: 'staff_welcome', data: { link } });
			await audit(actor, 'staff.created', { type: 'staff', id: doc._id }, { after: { email, roles }, meta });
			return presentStaff({ ...doc, createdAt: new Date(ctx.now()) });
		},

		/**
		 * Change roles or status. The last active superadmin cannot be demoted or disabled; nobody disables
		 * themselves. Disabling revokes every session.
		 * @param {{ staffId: string, roles?: string[], status?: 'active' | 'disabled', actor: Actor, meta?: Meta }} input
		 */
		updateStaff: async ({ staffId, roles, status, actor, meta = {} }) => {
			const staff = await loadStaff(staffId);
			if (status === 'disabled' && actor.id === staffId) throw problem('conflict', 'You cannot disable yourself.');
			const next = { ...(roles ? { roles } : {}), ...(status ? { status } : {}) };
			if (!(await keepsASuperadmin(staff, next))) throw problem('conflict', 'At least one active superadmin must remain.');
			await repo.staff.updateOne({ _id: staffId }, { $set: next });
			if (status === 'disabled') await ctx.sessions.revokeAll('staff', staffId);
			await audit(
				actor,
				'staff.updated',
				{ type: 'staff', id: staffId },
				{
					before: { roles: staff.roles, status: staff.status },
					after: next,
					meta,
				},
			);
			return presentStaff({ ...staff, ...next });
		},

		/**
		 * Reset a staff user's authenticator (lost device): TOTP and recovery codes cleared, sessions revoked; the
		 * user must enrol again at the next login.
		 * @param {{ staffId: string, reason: string, actor: Actor, meta?: Meta }} input
		 */
		resetStaffMfa: async ({ staffId, reason, actor, meta = {} }) => {
			if (actor.id === staffId) throw problem('conflict', 'Ask another administrator to reset your authenticator.');
			await loadStaff(staffId);
			await repo.staff.updateOne({ _id: staffId }, { $set: { totp: null, pendingTotp: null, recoveryHashes: [] } });
			await ctx.sessions.revokeAll('staff', staffId);
			await audit(actor, 'staff.mfa_reset', { type: 'staff', id: staffId }, { reason, meta });
		},

		/** @returns {Promise<boolean>} true once any staff user exists (the staff sign-in page then stops offering "Create admin") */
		hasStaff: async () => (await repo.staff.countDocuments({})) > 0,
	});
};
/** @typedef {ReturnType<typeof createAdmin>} Admin */

/** @param {Record<string, any>} n */
export const presentNote = (n) => ({
	noteId: String(n._id),
	merchantId: n.merchantId,
	body: n.body,
	by: n.by,
	at: n.createdAt instanceof Date ? n.createdAt.toISOString() : null,
});
