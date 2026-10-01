/**
 * Data access of the `identity` module (its own collections only) and the small orchestration helpers every
 * service file shares: one-time tokens, audit, sessions and second-factor checks.
 * @module
 */
import { createId } from '@ss/contracts';
import { findRecoveryCode, verifyTotp } from '../../infra/auth.js';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { hashToken, newToken, TOKEN_TTL_MS } from './core/tokens.js';
import { C } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */
/** @typedef {import('../../infra/db.js').TenantRepository} TenantRepository */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./core/tokens.js').TokenPurpose} TokenPurpose */
/** @typedef {import('./mailer.js').Mailer} Mailer */

/**
 * Request metadata carried into audit entries and sessions.
 * @typedef {{ requestId?: string | null, ip?: string | null, userAgent?: string | null }} Meta
 */

/**
 * @typedef {object} Deps
 * @property {ModuleContext} ctx
 * @property {Mailer} mailer
 * @property {ReturnType<typeof createRepo>} repo
 * @property {(actor: Actor | AuditActor, action: string, target: { type: string, id: string, merchantId?: string | null, websiteId?: string | null }, extra?: { before?: unknown, after?: unknown, reason?: string | null, meta?: Meta }) => Promise<string>} audit
 */

/** @typedef {{ type: 'staff' | 'merchant_user' | 'product' | 'system', id: string, via?: { type: 'staff', id: string } | null }} AuditActor */

/**
 * @param {ModuleContext} ctx
 */
export const createRepo = (ctx) => {
	/** @type {MutableOps} */ const staff = ctx.collection(C.staff);
	/** @type {MutableOps} */ const users = ctx.collection(C.users);
	/** @type {MutableOps} */ const merchants = ctx.collection(C.merchants);
	/** @type {MutableOps} */ const tokens = ctx.collection(C.tokens);
	/** @type {MutableOps} */ const domains = ctx.collection(C.domains);
	/** @type {MutableOps} */ const partners = ctx.collection(C.partners);
	/** @type {MutableOps} */ const developers = ctx.collection(C.developers);
	/** @type {TenantRepository} */ const memberships = ctx.collection(C.memberships);
	/** @type {TenantRepository} */ const invites = ctx.collection(C.invites);
	/** @type {TenantRepository} */ const websites = ctx.collection(C.websites);
	/** @type {TenantRepository} */ const keys = ctx.collection(C.keys);
	const secret = ctx.config.sessionSecret;

	/** @param {TenantRepository} repo */
	const scoped = (repo) => ({
		/** @param {string} merchantId */
		of: (merchantId) => /** @type {MutableOps} */ (repo.forMerchant(merchantId)),
		all: () => /** @type {MutableOps} */ (repo.acrossMerchants()),
	});

	return Object.freeze({
		staff,
		users,
		merchants,
		tokens,
		domains,
		partners,
		developers,
		memberships: scoped(memberships),
		invites: scoped(invites),
		websites: scoped(websites),
		keys: scoped(keys),
		/** @param {string} prefix */
		id: (prefix) => createId(prefix, { randomBytes: ctx.randomBytes }),
		/**
		 * @param {TokenPurpose} purpose
		 * @param {string} value
		 */
		tokenHash: (purpose, value) => hashToken(secret, purpose, value),
		/**
		 * Mint a one-time token; returns the plaintext (shown/mailed once).
		 * @param {TokenPurpose} purpose
		 * @param {{ subject: string, data?: Record<string, unknown>, ttlMs?: number }} input
		 */
		issueToken: async (purpose, { subject, data = {}, ttlMs = TOKEN_TTL_MS[purpose] }) => {
			const value = newToken(ctx.randomBytes);
			await tokens.insertOne({
				_id: hashToken(secret, purpose, value),
				purpose,
				subject,
				data,
				createdAt: new Date(ctx.now()),
				expireAt: new Date(ctx.now() + ttlMs),
			});
			return value;
		},
		/**
		 * Read a live token without consuming it.
		 * @param {TokenPurpose} purpose
		 * @param {string} value
		 */
		peekToken: async (purpose, value) => {
			const doc = await tokens.findOne({ _id: hashToken(secret, purpose, value), purpose });
			return doc && doc.expireAt.getTime() > ctx.now() ? doc : null;
		},
		/**
		 * Consume a token atomically (single use): only one concurrent caller gets the document.
		 * @param {TokenPurpose} purpose
		 * @param {string} value
		 */
		consumeToken: async (purpose, value) => {
			const id = hashToken(secret, purpose, value);
			const doc = await tokens.findOne({ _id: id, purpose });
			if (!doc || doc.expireAt.getTime() <= ctx.now()) return null;
			const { deletedCount } = await tokens.deleteOne({ _id: id, purpose });
			return deletedCount === 1 ? doc : null;
		},
		/**
		 * @param {TokenPurpose} purpose
		 * @param {string} subject
		 */
		dropTokens: (purpose, subject) => tokens.deleteMany({ purpose, subject }),
	});
};
/** @typedef {ReturnType<typeof createRepo>} Repo */

/**
 * Audit-log actor from an RBAC actor (website actors are recorded as system).
 * @param {Actor | AuditActor} actor
 * @returns {AuditActor}
 */
export const auditActor = (actor) => {
	const type = actor.type === 'staff' || actor.type === 'merchant_user' || actor.type === 'product' ? actor.type : 'system';
	return { type, id: actor.id, ...(actor.via ? { via: actor.via } : {}) };
};

/** System actor for calls from other modules or jobs that pass none. */
export const SYSTEM_ACTOR = Object.freeze({ type: /** @type {'system'} */ ('system'), id: 'identity' });

/**
 * @param {ModuleContext} ctx
 * @returns {Deps['audit']}
 */
export const createAuditor =
	(ctx) =>
	(actor, action, target, { before, after, reason = null, meta = {} } = {}) =>
		ctx.audit.record({
			actor: auditActor(actor),
			action,
			target,
			...(before === undefined ? {} : { before }),
			...(after === undefined ? {} : { after }),
			reason,
			requestId: meta.requestId ?? null,
			ip: meta.ip ?? null,
		});

/**
 * Insert, mapping a duplicate-key error to a 409 problem.
 * @param {() => Promise<unknown>} insert
 * @param {string} code
 * @param {string} detail
 */
export const insertUnique = async (insert, code, detail) => {
	try {
		await insert();
	} catch (error) {
		if (isDuplicateKey(error)) throw problem(code, detail);
		throw error;
	}
};

/**
 * Throttle gate: throws 429 with Retry-After when the account or IP is locked.
 * @param {ModuleContext} ctx
 * @param {string} account
 * @param {Meta} meta
 */
export const throttleGate = async (ctx, account, meta) => {
	const check = await ctx.loginThrottle.check({ account, ip: meta.ip ?? null });
	if (!check.allowed)
		throw problem('rate_limited', 'Too many failed attempts. Try again later.', {
			headers: { 'retry-after': String(check.retryAfterSeconds) },
		});
};

/**
 * Record a failed attempt and throw the generic credentials problem (429 once the account locks).
 * @param {ModuleContext} ctx
 * @param {string} account
 * @param {Meta} meta
 * @param {string} detail
 * @returns {Promise<never>}
 */
export const failAttempt = async (ctx, account, meta, detail) => {
	const result = await ctx.loginThrottle.recordFailure({ account, ip: meta.ip ?? null });
	if (result.locked)
		throw problem('rate_limited', 'Too many failed attempts. Try again later.', {
			headers: { 'retry-after': String(result.retryAfterSeconds ?? 900) },
		});
	throw problem('invalid_credentials', detail);
};

/** Envelope AAD of a stored TOTP secret. */
/** @param {string} subject */
export const totpAad = (subject) => ({ subject, purpose: 'totp' });

/**
 * Verify a TOTP code or a recovery code for an account document and burn it atomically (a TOTP step and a recovery
 * code are each accepted once, even under concurrent requests).
 * @param {ModuleContext} ctx
 * @param {MutableOps} collection the account collection (staff or users)
 * @param {Record<string, any>} account
 * @param {{ code?: string, recoveryCode?: string }} input
 * @returns {Promise<boolean>}
 */
export const checkSecondFactor = async (ctx, collection, account, input) => {
	if (!account.totp) return false;
	if (input.code !== undefined) {
		const secret = ctx.envelope.openText(account.totp.secret, { aad: totpAad(String(account._id)) });
		const lastStep = typeof account.totp.lastStep === 'number' ? account.totp.lastStep : null;
		const result = verifyTotp(secret, input.code, { now: ctx.now, lastStep });
		if (!result.ok) return false;
		const burned = await collection.updateOne(
			{ _id: account._id, $or: [{ 'totp.lastStep': null }, { 'totp.lastStep': { $lt: result.step } }] },
			{ $set: { 'totp.lastStep': result.step } },
		);
		return burned.modifiedCount === 1;
	}
	const hashes = /** @type {string[]} */ (account.recoveryHashes ?? []);
	const index = findRecoveryCode(input.recoveryCode, hashes, ctx.config.sessionSecret);
	if (index === -1) return false;
	const hash = hashes[index];
	const burned = await collection.updateOne({ _id: account._id, recoveryHashes: hash }, { $pull: { recoveryHashes: hash } });
	return burned.modifiedCount === 1;
};

/**
 * Send a mail; failures are logged, never thrown (flows that must not reveal account existence).
 * @param {Deps} deps
 * @param {import('./mailer.js').MailMessage} message
 */
export const sendQuietly = async ({ ctx, mailer }, message) => {
	try {
		await mailer.send(message);
	} catch (error) {
		ctx.logger.warn('mail could not be sent', { template: message.template, error });
	}
};

/**
 * Refuse flows that must send mail when no mailer is available (503).
 * @param {Mailer} mailer
 */
export const requireMailer = (mailer) => {
	if (mailer.available === false)
		throw problem('unavailable', 'E-mail delivery is not configured.', { headers: { 'retry-after': '3600' } });
};
