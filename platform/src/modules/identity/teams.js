/**
 * Merchants and their teams: merchant profile, invitations (hashed tokens, mailed links), member roles and
 * website-scoped grants, removal and ownership transfer. Every mutation is audited.
 * @module
 */
import { verifyPassword } from '../../infra/auth.js';
import { problem } from '../../infra/http.js';
import { nameKey } from './core/search.js';
import { linkFor } from './core/links.js';
import { presentInvite, presentMember, presentMerchant } from './core/present.js';
import { applyMemberChange, checkOwnerTransfer, grantsSomething, isOwner, unknownGrantWebsites } from './core/team.js';
import { newToken, TOKEN_TTL_MS } from './core/tokens.js';
import { failAttempt, insertUnique, requireMailer, throttleGate } from './repo.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('./repo.js').AuditActor} AuditActor */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./core/team.js').Grant} Grant */

/**
 * @param {Deps} deps
 */
export const createTeams = (deps) => {
	const { ctx, repo, mailer, audit } = deps;

	/** @param {string} merchantId */
	const loadMerchant = async (merchantId) => {
		const merchant = await repo.merchants.findOne({ _id: merchantId });
		if (!merchant) throw problem('not_found', 'No such merchant.');
		return merchant;
	};

	/** @param {string} merchantId */
	const activeMerchant = async (merchantId) => {
		const merchant = await loadMerchant(merchantId);
		if (merchant.status !== 'active') throw problem('merchant_suspended', 'The merchant is suspended.');
		return merchant;
	};

	/**
	 * Grants must reference live, active websites of this merchant.
	 * @param {string} merchantId
	 * @param {Grant[]} grants
	 */
	const checkGrantWebsites = async (merchantId, grants) => {
		if (grants.length === 0) return;
		const live = await repo.websites
			.of(merchantId)
			.find({ merchantId, _id: { $in: grants.map((g) => g.websiteId) }, env: 'live', status: 'active' })
			.project({ _id: 1 })
			.toArray();
		const unknown = unknownGrantWebsites(grants, new Set(live.map((w) => String(w._id))));
		if (unknown.length > 0)
			throw problem('validation_failed', 'Grants must name live websites of this merchant.', {
				errors: unknown.map((id) => ({ path: '/grants', message: `unknown website ${id}` })),
			});
	};

	/**
	 * @param {string} merchantId
	 * @param {string} userId
	 */
	const loadMember = async (merchantId, userId) => {
		const member = await repo.memberships.of(merchantId).findOne({ merchantId, userId });
		if (!member) throw problem('not_found', 'No such member.');
		return member;
	};

	return Object.freeze({
		loadMerchant,
		activeMerchant,

		/**
		 * @param {string} merchantId
		 */
		getMerchant: async (merchantId) => presentMerchant(await loadMerchant(merchantId)),

		/**
		 * @param {{ merchantId: string, name: string, actor: Actor, meta?: Meta }} input
		 */
		renameMerchant: async ({ merchantId, name, actor, meta = {} }) => {
			const before = await loadMerchant(merchantId);
			await repo.merchants.updateOne({ _id: merchantId }, { $set: { name, nameKey: nameKey(name) } });
			await audit(
				actor,
				'merchant.renamed',
				{ type: 'merchant', id: merchantId, merchantId },
				{
					before: { name: before.name },
					after: { name },
					meta,
				},
			);
			return presentMerchant({ ...before, name });
		},

		/**
		 * Members (with account e-mail) and pending invites.
		 * @param {string} merchantId
		 */
		listTeam: async (merchantId) => {
			await loadMerchant(merchantId);
			const members = await repo.memberships.of(merchantId).find({ merchantId }).sort({ createdAt: 1 }).limit(1000).toArray();
			const users = await repo.users
				.find({ _id: { $in: members.map((m) => m.userId) } })
				.project({ email: 1, name: 1, status: 1 })
				.toArray();
			const byId = new Map(users.map((u) => [String(u._id), u]));
			const invites = await repo.invites
				.of(merchantId)
				.find({ merchantId, status: 'pending', expiresAt: { $gt: new Date(ctx.now()) } })
				.sort({ createdAt: 1 })
				.limit(1000)
				.toArray();
			return {
				members: members.map((m) => presentMember(m, byId.get(m.userId))),
				invites: invites.map(presentInvite),
			};
		},

		/**
		 * Invite by e-mail. A pending invite for the same address is replaced (new token, new roles).
		 * @param {{ merchantId: string, email: string, roles?: string[], grants?: Grant[], actor: Actor, meta?: Meta }} input
		 */
		invite: async ({ merchantId, email, roles = [], grants = [], actor, meta = {} }) => {
			requireMailer(mailer);
			const merchant = await activeMerchant(merchantId);
			if (!grantsSomething(roles, grants))
				throw problem('validation_failed', 'An invitation needs roles or website grants.', {
					errors: [{ path: '/roles', message: 'name roles or grants' }],
				});
			await checkGrantWebsites(merchantId, grants);
			const existing = await repo.users.findOne({ email });
			if (existing && (await repo.memberships.of(merchantId).findOne({ merchantId, userId: existing._id })))
				throw problem('conflict', 'This person is already a member.');
			const token = newToken(ctx.randomBytes);
			const invites = repo.invites.of(merchantId);
			await invites.updateMany({ merchantId, email, status: 'pending' }, { $set: { status: 'replaced' } });
			const invite = {
				_id: repo.id('inv'),
				email,
				roles,
				grants,
				tokenHash: repo.tokenHash('invite', token),
				status: 'pending',
				expiresAt: new Date(ctx.now() + TOKEN_TTL_MS.invite),
				invitedBy: actor.id,
			};
			await insertUnique(() => invites.insertOne(invite), 'conflict', 'An invitation for this address is being sent.');
			await mailer.send({
				to: email,
				template: 'invite',
				data: { link: linkFor(ctx.config.portalUrl, 'invite', token), merchantName: merchant.name },
			});
			await audit(
				actor,
				'team.invited',
				{ type: 'invite', id: invite._id, merchantId },
				{ after: { email, roles, grants }, meta },
			);
			return presentInvite({ ...invite, createdAt: new Date(ctx.now()) });
		},

		/**
		 * @param {{ merchantId: string, inviteId: string, actor: Actor, meta?: Meta }} input
		 */
		revokeInvite: async ({ merchantId, inviteId, actor, meta = {} }) => {
			const result = await repo.invites
				.of(merchantId)
				.updateOne({ merchantId, _id: inviteId, status: 'pending' }, { $set: { status: 'revoked' } });
			if (result.modifiedCount !== 1) throw problem('not_found', 'No such pending invitation.');
			await audit(actor, 'team.invite_revoked', { type: 'invite', id: inviteId, merchantId }, { meta });
		},

		/**
		 * Change a member's merchant-wide roles and/or website grants (never the owner's).
		 * @param {{ merchantId: string, userId: string, roles?: string[], grants?: Grant[], actor: Actor, meta?: Meta }} input
		 */
		updateMember: async ({ merchantId, userId, roles, grants, actor, meta = {} }) => {
			const member = await loadMember(merchantId, userId);
			const change = applyMemberChange(/** @type {any} */ (member), {
				...(roles === undefined ? {} : { roles }),
				...(grants === undefined ? {} : { grants }),
			});
			if (!change.ok) throw problem(change.code, change.message);
			await checkGrantWebsites(merchantId, change.grants);
			await repo.memberships
				.of(merchantId)
				.updateOne({ merchantId, _id: member._id }, { $set: { roles: change.roles, grants: change.grants } });
			await audit(
				actor,
				'team.member_updated',
				{ type: 'user', id: userId, merchantId },
				{
					before: { roles: member.roles, grants: member.grants },
					after: { roles: change.roles, grants: change.grants },
					meta,
				},
			);
			const user = await repo.users.findOne({ _id: userId });
			return presentMember({ ...member, roles: change.roles, grants: change.grants }, user);
		},

		/**
		 * @param {{ merchantId: string, userId: string, actor: Actor, meta?: Meta }} input
		 */
		removeMember: async ({ merchantId, userId, actor, meta = {} }) => {
			const member = await loadMember(merchantId, userId);
			if (isOwner(/** @type {any} */ (member)))
				throw problem('owner_protected', 'The owner cannot be removed; transfer ownership first.');
			await repo.memberships.of(merchantId).deleteOne({ merchantId, _id: member._id });
			await audit(
				actor,
				'team.member_removed',
				{ type: 'user', id: userId, merchantId },
				{
					before: { roles: member.roles, grants: member.grants },
					meta,
				},
			);
		},

		/**
		 * Transfer ownership to another member; the previous owner becomes `admin`. A merchant user (the owner) must
		 * confirm with their password; staff need no password.
		 * @param {{ merchantId: string, userId: string, password?: string, actor: Actor, meta?: Meta }} input
		 */
		transferOwnership: async ({ merchantId, userId, password, actor, meta = {} }) => {
			const merchant = await loadMerchant(merchantId);
			const ownerId = String(merchant.ownerUserId);
			if (actor.type === 'merchant_user') {
				if (actor.id !== ownerId) throw problem('forbidden', 'Only the owner can transfer ownership.');
				const owner = await repo.users.findOne({ _id: ownerId });
				const key = `merchant:${owner?.email ?? ownerId}`;
				await throttleGate(ctx, key, meta);
				if (!(await verifyPassword(password ?? '', owner?.passwordHash)))
					return failAttempt(ctx, key, meta, 'The password is incorrect.');
			}
			const target = await repo.memberships.of(merchantId).findOne({ merchantId, userId });
			const check = checkOwnerTransfer(/** @type {any} */ (target), ownerId);
			if (!check.ok) throw problem(check.code, check.message);
			const members = repo.memberships.of(merchantId);
			await members.updateOne({ merchantId, userId }, { $set: { roles: ['owner'], grants: [] } });
			await members.updateOne({ merchantId, userId: ownerId }, { $set: { roles: ['admin'], grants: [] } });
			await repo.merchants.updateOne({ _id: merchantId }, { $set: { ownerUserId: userId } });
			await audit(
				actor,
				'merchant.owner_transferred',
				{ type: 'merchant', id: merchantId, merchantId },
				{
					before: { ownerUserId: ownerId },
					after: { ownerUserId: userId },
					meta,
				},
			);
			return presentMerchant({ ...merchant, ownerUserId: userId });
		},
	});
};
/** @typedef {ReturnType<typeof createTeams>} Teams */
