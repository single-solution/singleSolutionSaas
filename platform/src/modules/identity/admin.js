/**
 * Staff operations: merchant suspension (with reason; commerce reacts through `onMerchantStatus`), merchant listing,
 * staff users (created without a password — they set one through a mailed or printed setup link; MFA mandatory),
 * the one-time superadmin bootstrap, partners and developers with their grants. Every mutation is audited.
 * @module
 */
import { problem } from '../../infra/http.js';
import { presentMerchant, presentParty, presentStaff } from './core/present.js';
import { insertUnique, requireMailer, sendQuietly } from './repo.js';

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

	/**
	 * @param {'partners' | 'developers'} kind
	 */
	const parties = (kind) => {
		const collection = kind === 'partners' ? repo.partners : repo.developers;
		const idKey = kind === 'partners' ? 'partnerId' : 'developerId';
		const prefix = kind === 'partners' ? 'prt' : 'dev';
		const type = kind === 'partners' ? 'partner' : 'developer';
		/** @param {string} id */
		const load = async (id) => {
			const doc = await collection.findOne({ _id: id });
			if (!doc) throw problem('not_found', `No such ${type}.`);
			return doc;
		};
		return Object.freeze({
			load,
			/** @param {string} id */
			get: async (id) => presentParty(await load(id), /** @type {any} */ (idKey)),
			list: async () =>
				(await collection.find({}).sort({ createdAt: 1, _id: 1 }).limit(1000).toArray()).map((d) =>
					presentParty(d, /** @type {any} */ (idKey)),
				),
			/** @param {{ name: string, email: string, actor: Actor, meta?: Meta }} input */
			create: async ({ name, email, actor, meta = {} }) => {
				const doc = { _id: repo.id(prefix), name, email, status: 'active', grants: [] };
				await insertUnique(() => collection.insertOne(doc), 'conflict', `A ${type} with this e-mail exists.`);
				await audit(actor, `${type}.created`, { type, id: doc._id }, { after: { name, email }, meta });
				return presentParty({ ...doc, createdAt: new Date(ctx.now()) }, /** @type {any} */ (idKey));
			},
			/**
			 * Replace the grant for the same target (merchantId / appId).
			 * @param {{ id: string, grant: Record<string, any>, match: Record<string, string>, actor: Actor, meta?: Meta }} input
			 */
			grant: async ({ id, grant, match, actor, meta = {} }) => {
				await load(id);
				await collection.updateOne({ _id: id }, { $pull: { grants: match } });
				await collection.updateOne({ _id: id }, { $push: { grants: { ...grant, at: new Date(ctx.now()), by: actor.id } } });
				await audit(actor, `${type}.granted`, { type, id, merchantId: grant.merchantId ?? null }, { after: grant, meta });
				return presentParty(await load(id), /** @type {any} */ (idKey));
			},
			/** @param {{ id: string, match: Record<string, string>, actor: Actor, meta?: Meta }} input */
			ungrant: async ({ id, match, actor, meta = {} }) => {
				await load(id);
				const result = await collection.updateOne({ _id: id }, { $pull: { grants: match } });
				if (result.modifiedCount !== 1) throw problem('not_found', 'No such grant.');
				await audit(
					actor,
					`${type}.grant_revoked`,
					{ type, id, merchantId: match.merchantId ?? null },
					{ before: match, meta },
				);
			},
		});
	};

	const partners = parties('partners');
	const developers = parties('developers');

	return Object.freeze({
		suspendMerchant: setStatus('suspended'),
		resumeMerchant: setStatus('active'),

		/**
		 * Merchants page (by id), optionally filtered by status.
		 * @param {{ after: string | null, limit: number, status?: string }} input
		 */
		listMerchants: async ({ after, limit, status }) =>
			repo.merchants
				.find({ ...(status ? { status } : {}), ...(after ? { _id: { $gt: after } } : {}) })
				.sort({ _id: 1 })
				.limit(limit)
				.toArray(),
		presentMerchant,

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

		/**
		 * One-time bootstrap (CLI): create the first superadmin and return a password-setup link. Refused once any
		 * staff user exists. Never sets a password.
		 * @param {{ email: string, name?: string }} input
		 */
		bootstrapSuperadmin: async ({ email, name }) => {
			const result = await ctx.locks.withLock('identity.bootstrap', { ttlMs: 60_000, owner: 'bootstrap' }, async () => {
				if ((await repo.staff.countDocuments({})) > 0)
					throw problem('conflict', 'Staff users already exist; bootstrap is a one-time operation.');
				const doc = {
					_id: repo.id('stf'),
					email,
					name: name ?? null,
					roles: ['superadmin'],
					status: 'active',
					passwordHash: null,
					totp: null,
					pendingTotp: null,
					recoveryHashes: [],
					createdBy: 'bootstrap',
				};
				await insertUnique(() => repo.staff.insertOne(doc), 'conflict', 'A staff user with this e-mail exists.');
				await audit(
					{ type: 'system', id: 'bootstrap' },
					'staff.bootstrapped',
					{ type: 'staff', id: doc._id },
					{
						after: { email, roles: doc.roles },
					},
				);
				return { staffId: doc._id, link: await hooks.staffSetupLink(doc._id) };
			});
			if (result.locked) throw problem('conflict', 'A bootstrap is already running.');
			return result.value;
		},

		// -----------------------------------------------------------------------------------------------------------
		// Partners and developers

		partners,
		developers,
	});
};
/** @typedef {ReturnType<typeof createAdmin>} Admin */
