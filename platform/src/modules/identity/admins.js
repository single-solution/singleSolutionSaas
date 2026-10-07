/**
 * Admins (PLAN 0.8.2 Admins; Owner only): invite (e-mail + role; the invitee sets their name and password through a
 * 24-hour setup link), resend or copy the invite, correct the invite e-mail, change role, remove. There is always at
 * least one Owner: the last Owner cannot be removed or demoted, and no one removes themselves. A role change or removal
 * takes effect at once and ends all that admin's sessions. Activity entries keep a removed admin's name; removing an
 * admin erases the login, so the e-mail is free again (PLAN 0.8.4 builder choice).
 * @module
 */
import { problem } from '../../infra/http.js';
import { presentAdmin } from './core/present.js';
import { insertUnique, sendLater } from './repo.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {'owner' | 'support' | 'finance'} Role */

const ROLE_NAMES = Object.freeze({ owner: 'an Owner', support: 'Support', finance: 'Finance' });

/**
 * @param {Deps} deps
 * @param {{ setupLink: (kind: 'admin', id: string) => Promise<{ link: string, expiresAt: string }> }} hooks
 */
export const createAdmins = (deps, hooks) => {
	const { ctx, repo, audit } = deps;

	/** @param {string} adminId */
	const load = async (adminId) => {
		const doc = await repo.admins.findOne({ _id: adminId });
		if (!doc) throw problem('not_found', 'No such admin.');
		return doc;
	};

	/**
	 * Refuse a change that would leave no active Owner.
	 * @param {Record<string, any>} admin
	 */
	const keepAnOwner = async (admin) => {
		if (admin.role !== 'owner' || admin.status !== 'active') return;
		const others = await repo.admins.countDocuments({ _id: { $ne: admin._id }, role: 'owner', status: 'active' });
		if (others === 0) throw problem('last_owner', 'There must always be at least one Owner.');
	};

	/**
	 * Send (or hand back for copying) an invite link; a new link cancels the previous one.
	 * @param {Record<string, any>} admin
	 * @param {{ copy?: boolean, actor: Actor, meta?: Meta }} input
	 */
	const deliver = async (admin, { copy = false, actor, meta = {} }) => {
		const setup = await hooks.setupLink('admin', String(admin._id));
		if (copy) {
			await audit(actor, 'admin.invite_link_copied', { type: 'admin', id: String(admin._id) }, { meta });
			return { link: setup.link, expiresAt: setup.expiresAt, mailed: false };
		}
		const mailed = await sendLater(deps, {
			to: admin.email,
			template: 'admin_invite',
			data: { link: setup.link, role: ROLE_NAMES[/** @type {Role} */ (admin.role)] },
		});
		await audit(actor, 'admin.invite_link_sent', { type: 'admin', id: String(admin._id) }, { after: { mailed }, meta });
		return { link: null, expiresAt: setup.expiresAt, mailed };
	};

	return Object.freeze({
		/** Every admin, oldest first. */
		list: async () => (await repo.admins.find({}).sort({ createdAt: 1, _id: 1 }).limit(1000).toArray()).map(presentAdmin),

		/** @param {string} adminId */
		get: async (adminId) => presentAdmin(await load(adminId)),

		/**
		 * Invite an admin: the e-mail is claimed at once (unique across the Portal) and a setup link goes out (or is
		 * copied when `copy`).
		 * @param {{ email: string, role: Role, copy?: boolean, actor: Actor, meta?: Meta }} input
		 */
		invite: async ({ email, role, copy = false, actor, meta = {} }) => {
			const doc = {
				_id: repo.id('adm'),
				email,
				name: null,
				role,
				status: 'invited',
				passwordHash: null,
				totp: null,
				pendingTotp: null,
				recoveryHashes: [],
				lastSignInAt: null,
				invitedBy: actor.id,
			};
			await repo.claimLogin(email, 'admin', doc._id);
			try {
				await insertUnique(() => repo.admins.insertOne(doc), 'email_taken', 'This e-mail is already used by another login.');
			} catch (error) {
				await repo.releaseLogin(email, doc._id);
				throw error;
			}
			await audit(actor, 'admin.invited', { type: 'admin', id: doc._id }, { after: { role }, meta });
			const delivered = await deliver(doc, { copy, actor, meta });
			return { admin: presentAdmin({ ...doc, createdAt: new Date(ctx.now()) }), invite: delivered };
		},

		/**
		 * Resend or copy the invite link (only until the invite is accepted).
		 * @param {{ adminId: string, copy?: boolean, actor: Actor, meta?: Meta }} input
		 */
		resendInvite: async ({ adminId, copy = false, actor, meta = {} }) => {
			const admin = await load(adminId);
			if (admin.status !== 'invited' || admin.passwordHash) throw problem('conflict', 'This invite was already accepted.');
			return deliver(admin, { copy, actor, meta });
		},

		/**
		 * Correct the invite e-mail (only until the invite is accepted) or change the role. A role change ends all the
		 * admin's sessions at once.
		 * @param {{ adminId: string, email?: string, role?: Role, actor: Actor, meta?: Meta }} input
		 */
		update: async ({ adminId, email, role, actor, meta = {} }) => {
			const admin = await load(adminId);
			/** @type {Record<string, unknown>} */
			const set = {};
			if (email !== undefined && email !== admin.email) {
				if (admin.status !== 'invited' || admin.passwordHash)
					throw problem('conflict', 'The e-mail can be corrected only until the invite is accepted.');
				await repo.claimLogin(email, 'admin', adminId);
				set.email = email;
			}
			if (role !== undefined && role !== admin.role) {
				if (actor.id === adminId) throw problem('conflict', 'You cannot change your own role.');
				if (role !== 'owner') await keepAnOwner(admin);
				set.role = role;
			}
			if (Object.keys(set).length === 0) return presentAdmin(admin);
			await repo.admins.updateOne({ _id: adminId }, { $set: set });
			if (set.email) {
				await repo.releaseLogin(admin.email, adminId);
				await repo.dropTokens('setup', `admin:${adminId}`);
				await audit(actor, 'admin.invite_email_corrected', { type: 'admin', id: adminId }, { meta });
			}
			if (set.role) {
				await ctx.sessions.revokeAll('admin', adminId);
				await deps.sessionsEnded(adminId);
				await audit(
					actor,
					'admin.role_changed',
					{ type: 'admin', id: adminId },
					{
						before: { role: admin.role },
						after: { role: set.role },
						meta,
					},
				);
			}
			return presentAdmin({ ...admin, ...set });
		},

		/**
		 * Remove an admin: the login is erased (e-mail free again), every session ends; Activity keeps the name.
		 * @param {{ adminId: string, actor: Actor, meta?: Meta }} input
		 */
		remove: async ({ adminId, actor, meta = {} }) => {
			if (actor.id === adminId) throw problem('conflict', 'You cannot remove yourself.');
			const admin = await load(adminId);
			await keepAnOwner(admin);
			await repo.admins.deleteOne({ _id: adminId });
			await repo.releaseLogin(admin.email, adminId);
			await repo.dropTokens('setup', `admin:${adminId}`);
			await ctx.sessions.revokeAll('admin', adminId);
			await deps.sessionsEnded(adminId);
			await audit(
				actor,
				'admin.removed',
				{ type: 'admin', id: adminId },
				{
					before: { name: admin.name ?? null, role: admin.role },
					meta,
				},
			);
		},
	});
};
/** @typedef {ReturnType<typeof createAdmins>} Admins */
