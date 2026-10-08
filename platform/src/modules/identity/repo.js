/**
 * Data access of the `identity` module (its own collections only) and the small orchestration helpers every
 * service file shares: one-time tokens, audit, sessions and second-factor checks.
 * @module
 */
import { createId } from '@ss/contracts';
import { findRecoveryCode, verifyTotp } from '../../infra/auth.js';
import { problem } from '../../infra/http.js';
import { afterResponse } from '../../infra/request-scope.js';
import { isDuplicateKey } from '../../infra/util.js';
import { hashToken, newToken, TOKEN_TTL_MS } from './core/tokens.js';
import { C } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */
/** @typedef {import('../../infra/db.js').TenantRepository} TenantRepository */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./core/tokens.js').TokenPurpose} TokenPurpose */
/** @typedef {import('../../infra/mailer.js').Mailer} Mailer */

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
 * @property {(subject: string) => Promise<unknown>} sessionsEnded every product dashboard session of this person ends
 *   (`sessions.revoked` to every connected product, PLAN 0.4.3)
 */

/** @typedef {{ type: 'admin' | 'merchant' | 'product' | 'system', id: string, name?: string | null }} AuditActor */

/**
 * @param {ModuleContext} ctx
 */
export const createRepo = (ctx) => {
	/** @type {MutableOps} */ const admins = ctx.collection(C.admins);
	/** @type {MutableOps} */ const merchants = ctx.collection(C.merchants);
	/** @type {MutableOps} */ const logins = ctx.collection(C.logins);
	/** @type {MutableOps} */ const tokens = ctx.collection(C.tokens);
	/** @type {MutableOps} */ const domains = ctx.collection(C.domains);
	/** @type {TenantRepository} */ const websites = ctx.collection(C.websites);
	const secret = ctx.config.sessionSecret;

	/** @param {TenantRepository} repo */
	const scoped = (repo) => ({
		/** @param {string} merchantId */
		of: (merchantId) => /** @type {MutableOps} */ (repo.forMerchant(merchantId)),
		all: () => /** @type {MutableOps} */ (repo.acrossMerchants()),
	});

	return Object.freeze({
		admins,
		merchants,
		logins,
		tokens,
		domains,
		websites: scoped(websites),
		/**
		 * Claim a login e-mail for an admin or a merchant (PLAN 0.2: unique across the whole Portal). Throws 409
		 * `email_taken` when another login holds it.
		 * @param {string} email
		 * @param {'admin' | 'merchant'} kind
		 * @param {string} subject
		 */
		claimLogin: async (email, kind, subject) => {
			try {
				await logins.insertOne({ _id: email, kind, subject });
			} catch (error) {
				if (isDuplicateKey(error)) throw problem('email_taken', 'This e-mail is already used by another login.');
				throw error;
			}
		},
		/**
		 * Release a login e-mail (only the holder's claim is removed).
		 * @param {string} email
		 * @param {string} subject
		 */
		releaseLogin: (email, subject) => logins.deleteOne({ _id: email, subject }),
		/**
		 * The login holding an e-mail, or null.
		 * @param {string} email
		 * @returns {Promise<{ kind: 'admin' | 'merchant', subject: string } | null>}
		 */
		loginOf: async (email) => {
			const doc = await logins.findOne({ _id: email });
			return doc ? { kind: doc.kind, subject: doc.subject } : null;
		},
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
 * Audit-log actor from an RBAC actor (website actors are recorded as system). An admin's name is kept with the entry.
 * @param {Actor | AuditActor} actor
 * @returns {AuditActor}
 */
const auditActor = (actor) => {
	const type = actor.type === 'admin' || actor.type === 'merchant' || actor.type === 'product' ? actor.type : 'system';
	return { type, id: actor.id, ...(type === 'admin' && actor.name ? { name: actor.name } : {}) };
};

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

/** AAD of a stored two-step secret (sealed with `ENCRYPTION_KEY`, PLAN 0.4.8). */
/** @param {string} subject */
export const totpAad = (subject) => ({ subject, purpose: 'totp' });

/**
 * Open a stored two-step secret; null when it was sealed under another `ENCRYPTION_KEY` (the person then signs in
 * with a recovery code, or an Owner turns two-step off, PLAN 0.4.8).
 * @param {ModuleContext} ctx
 * @param {string} sealed
 * @param {string} subject
 * @returns {string | null}
 */
export const openTotpSecret = (ctx, sealed, subject) => {
	try {
		return ctx.secretBox.openText(sealed, { aad: totpAad(subject) });
	} catch {
		return null;
	}
};

/**
 * Verify a two-step code or a recovery code for a login document and burn it atomically (a code step and a recovery
 * code are each accepted once, even under concurrent requests).
 * @param {ModuleContext} ctx
 * @param {MutableOps} collection the login's collection (admins or merchants)
 * @param {Record<string, any>} account
 * @param {{ code?: string, recoveryCode?: string }} input
 * @returns {Promise<boolean>}
 */
export const checkSecondFactor = async (ctx, collection, account, input) => {
	if (!account.totp) return false;
	if (input.code !== undefined) {
		const secret = openTotpSecret(ctx, account.totp.secret, String(account._id));
		if (secret === null) return false;
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
 * Send an e-mail right after the response of the current request (F.19 `after()`), or at once outside a request.
 * Without SMTP settings the e-mail is skipped (PLAN 0.5.10). Failures are logged, never thrown. Returns whether the
 * e-mail was handed to the mailer.
 * @param {Deps} deps
 * @param {import('../../infra/mailer.js').MailMessage} message
 * @returns {Promise<boolean>}
 */
export const sendLater = async ({ ctx, mailer }, message) => {
	if (mailer.available === false) return false;
	const send = async () => {
		try {
			await mailer.send(message);
		} catch (error) {
			ctx.logger.warn('mail could not be sent', { template: message.template, error });
		}
	};
	if (!afterResponse(send)) await send();
	return true;
};
