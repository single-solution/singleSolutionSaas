/**
 * Staff impersonation of a merchant user in the Merchant Console (PLAN §2 "impersonate time-boxed").
 *
 * Two steps, so the merchant session cookie is only ever set in the browser of the staff member who asked for it:
 * 1. `start` (staff, `platform.impersonate`): checks the merchant and the member, and mints a **one-time exchange
 *    token** (60 s, single use, only its HMAC stored) bound to the staff member.
 * 2. `exchange` (the same staff session): consumes the token atomically and creates a merchant session for the member
 *    with `via: { type: 'staff', id, name }`, MFA complete and an absolute lifetime of the requested minutes
 *    (≤ 60). The route sets the merchant session cookie.
 *
 * Starting is audited on the staff (global) chain and the merchant's chain; every request made with the session is
 * audited as the member with `via` (the session actor carries it). Ending (merchant sign-out) is audited too.
 * @module
 */
import { problem } from '../../infra/http.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('../../infra/auth.js').Session} Session */

/** Longest impersonation (minutes; the protocol caps impersonation at one hour, F.5). */
export const MAX_IMPERSONATION_MINUTES = 60;
export const EXCHANGE_PATH = '/v1/auth/impersonation/exchange';

const INVALID = 'The impersonation link is invalid or expired. Start again.';

/**
 * @param {Deps} deps
 * @param {{ loadMerchant: (merchantId: string) => Promise<Record<string, any>> }} hooks
 */
export const createImpersonation = (deps, hooks) => {
	const { ctx, repo, audit } = deps;

	/**
	 * The member to impersonate: an active user with a membership of the merchant.
	 * @param {string} merchantId
	 * @param {string} userId
	 */
	const loadMember = async (merchantId, userId) => {
		const membership = await repo.memberships.of(merchantId).findOne({ merchantId, userId });
		const user = membership ? await repo.users.findOne({ _id: userId }) : null;
		if (!membership || !user) throw problem('not_found', 'No such member of this merchant.');
		if (user.status !== 'active') throw problem('conflict', 'This user is deactivated and cannot be impersonated.');
		return { membership, user };
	};

	/**
	 * @param {Actor} actor
	 */
	const staffOf = async (actor) => {
		const staff = actor.type === 'staff' ? await repo.staff.findOne({ _id: actor.id }) : null;
		if (!staff || staff.status !== 'active') throw problem('forbidden', 'Only active staff can impersonate.');
		return staff;
	};

	return Object.freeze({
		/**
		 * Mint the one-time exchange token.
		 * @param {{ merchantId: string, userId: string, minutes: number, reason: string, actor: Actor, meta?: Meta }} input
		 */
		start: async ({ merchantId, userId, minutes, reason, actor }) => {
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_IMPERSONATION_MINUTES)
				throw problem('validation_failed', 'The request is invalid.', {
					errors: [{ path: '/minutes', message: `must be 1..${MAX_IMPERSONATION_MINUTES}` }],
				});
			await staffOf(actor);
			await hooks.loadMerchant(merchantId);
			await loadMember(merchantId, userId);
			const token = await repo.issueToken('impersonation', {
				subject: actor.id,
				data: { merchantId, userId, minutes, reason },
			});
			return { exchangeToken: token, exchangePath: EXCHANGE_PATH, expiresAt: new Date(ctx.now() + 60_000).toISOString() };
		},

		/**
		 * Redeem the token (single use, only by the staff member who minted it): a merchant session with `via`.
		 * @param {{ token: string, actor: Actor, meta?: Meta }} input
		 * @returns {Promise<{ token: string, maxAgeSeconds: number, merchantId: string, userId: string, expiresAt: string }>}
		 */
		exchange: async ({ token, actor, meta = {} }) => {
			const staff = await staffOf(actor);
			const peeked = await repo.peekToken('impersonation', token);
			// a token of another staff member is not consumed (and is indistinguishable from an unknown one)
			if (!peeked || peeked.subject !== actor.id) throw problem('token_invalid', INVALID);
			const doc = await repo.consumeToken('impersonation', token);
			if (!doc) throw problem('token_invalid', INVALID);
			const { merchantId, userId, minutes, reason } =
				/** @type {{ merchantId: string, userId: string, minutes: number, reason: string }} */ (doc.data);
			await hooks.loadMerchant(merchantId);
			const { membership, user } = await loadMember(merchantId, userId);
			const via = { type: /** @type {const} */ ('staff'), id: actor.id, name: staff.name ?? staff.email };
			const created = await ctx.sessions.create({
				kind: 'merchant',
				subject: userId,
				merchantId,
				roles: membership.roles,
				grants: membership.grants,
				mfa: true,
				via,
				absoluteMs: minutes * 60_000,
				ip: meta.ip ?? null,
				userAgent: meta.userAgent ?? null,
			});
			const expiresAt = created.session.absoluteExpiresAt.toISOString();
			const details = { merchantId, userId, email: user.email, minutes, sessionId: created.session.id, expiresAt };
			await audit(actor, 'staff.impersonation_started', { type: 'staff', id: actor.id }, { after: details, reason, meta });
			await audit(
				actor,
				'merchant.impersonation_started',
				{ type: 'user', id: userId, merchantId },
				{ after: details, reason, meta },
			);
			return { token: created.token, maxAgeSeconds: minutes * 60, merchantId, userId, expiresAt };
		},

		/**
		 * An impersonation session signed out ("End impersonation"): audited on both chains.
		 * @param {{ session: Session, meta?: Meta }} input
		 */
		ended: async ({ session, meta = {} }) => {
			if (!session.via) return;
			const staffActor = { type: /** @type {const} */ ('staff'), id: session.via.id };
			const details = { merchantId: session.merchantId, userId: session.subject, sessionId: session.id };
			await audit(staffActor, 'staff.impersonation_ended', { type: 'staff', id: session.via.id }, { after: details, meta });
			await audit(
				{ type: 'merchant_user', id: session.subject, via: { type: 'staff', id: session.via.id } },
				'merchant.impersonation_ended',
				{ type: 'user', id: session.subject, merchantId: session.merchantId },
				{ after: details, meta },
			);
		},
	});
};
/** @typedef {ReturnType<typeof createImpersonation>} Impersonation */
