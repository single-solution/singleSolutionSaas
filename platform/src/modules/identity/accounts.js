/**
 * Console accounts: merchant self-signup with e-mail verification, staff and merchant login/logout, TOTP
 * enrolment/verification/disable with recovery codes (required at sign-in once enrolled), password reset and change,
 * sessions, merchant switching and invite acceptance.
 *
 * First admin: while no staff user exists, the staff sign-in page offers "Create admin": the visitor chooses a password
 * and becomes the superadmin `admin` (no e-mail). Afterwards `admin` (or an e-mail) signs in with a password. Mechanisms (scrypt, TOTP, sessions, throttling) are the infra's.
 *
 * Anti-enumeration: signup and reset requests answer the same whether the account exists; login failures are one
 * generic 401; unknown accounts burn a dummy scrypt verification.
 * @module
 */
import {
	generateRecoveryCodes,
	generateTotpSecret,
	hashPassword,
	needsRehash,
	totpUri,
	verifyPassword,
	verifyTotp,
} from '../../infra/auth.js';
import { problem } from '../../infra/http.js';
import { isDuplicateKey } from '../../infra/util.js';
import { nameKey } from './core/search.js';
import { newPassword } from './core/inputs.js';
import { linkFor } from './core/links.js';
import { presentMerchant, presentStaff, presentUser, iso } from './core/present.js';
import { checkSecondFactor, failAttempt, insertUnique, requireMailer, sendQuietly, throttleGate, totpAad } from './repo.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/auth.js').Session} Session */
/** @typedef {'staff' | 'merchant'} Kind */

const BAD_LOGIN = 'The e-mail or password is incorrect.';
const BAD_CODE = 'The verification code is incorrect.';
const ISSUER = 'Single Solution';
const STAFF_WELCOME_TTL_MS = 24 * 60 * 60_000;
const MERCHANT_WELCOME_TTL_MS = 72 * 60 * 60_000;

/** @param {Kind} kind @param {string | null | undefined} email (the first admin may have none) */
const accountKey = (kind, email) => `${kind}:${email ?? 'admin'}`;

/** The first admin's login name. */
export const ADMIN_LOGIN = 'admin';

/**
 * @param {Deps} deps
 */
export const createAccounts = (deps) => {
	const { ctx, repo, mailer, audit } = deps;
	/** @param {Kind} kind */
	const accounts = (kind) => (kind === 'staff' ? repo.staff : repo.users);
	/** @param {Kind} kind */
	const maxAge = (kind) => Math.floor(ctx.config.sessions[kind].absoluteMs / 1000);
	/** @param {Kind} kind @param {string} token */
	const cookie = (kind, token) => ctx.cookies.set(kind, token, maxAge(kind));

	/**
	 * @param {Kind} kind
	 * @param {string} id
	 */
	const loadAccount = async (kind, id) => {
		const doc = await accounts(kind).findOne({ _id: id });
		if (!doc || doc.status !== 'active') throw problem('unauthorized', 'The account is no longer active.');
		return doc;
	};

	/**
	 * Memberships of a user, oldest first.
	 * @param {string} userId
	 */
	const membershipsOf = (userId) => repo.memberships.all().find({ userId }).sort({ createdAt: 1, _id: 1 }).limit(500).toArray();

	/**
	 * Start a merchant session (after every factor passed).
	 * @param {Record<string, any>} user
	 * @param {string | null | undefined} preferredMerchantId
	 * @param {Meta} meta
	 */
	const startMerchantSession = async (user, preferredMerchantId, meta) => {
		const memberships = await membershipsOf(String(user._id));
		const membership = preferredMerchantId ? memberships.find((m) => m.merchantId === preferredMerchantId) : memberships[0];
		if (preferredMerchantId && !membership) throw problem('forbidden', 'You are not a member of this merchant.');
		const { token, session } = await ctx.sessions.create({
			kind: 'merchant',
			subject: String(user._id),
			merchantId: membership?.merchantId ?? null,
			roles: membership?.roles ?? [],
			grants: membership?.grants ?? [],
			mfa: Boolean(user.totp),
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
		});
		await ctx.loginThrottle.recordSuccess({ account: accountKey('merchant', user.email) });
		return {
			status: /** @type {'ok'} */ ('ok'),
			user: presentUser(user),
			merchantId: session.merchantId,
			cookie: cookie('merchant', token),
		};
	};

	/**
	 * Password accepted: either a session, or an MFA challenge when the user has TOTP.
	 * @param {Record<string, any>} user
	 * @param {string | null | undefined} merchantId
	 * @param {Meta} meta
	 */
	const afterPassword = async (user, merchantId, meta) => {
		if (user.totp) {
			const challenge = await repo.issueToken('mfa_challenge', {
				subject: String(user._id),
				data: { merchantId: merchantId ?? null },
			});
			return { status: /** @type {'mfa_required'} */ ('mfa_required'), challenge };
		}
		return startMerchantSession(user, merchantId, meta);
	};

	/**
	 * @param {Kind} kind
	 * @param {Record<string, any>} account
	 * @param {string} password
	 */
	const maybeRehash = async (kind, account, password) => {
		if (account.passwordHash && needsRehash(account.passwordHash))
			await accounts(kind).updateOne(
				{ _id: account._id },
				{ $set: { passwordHash: await hashPassword(password, { randomBytes: ctx.randomBytes }) } },
			);
	};

	/** @param {string} password */
	const hash = (password) => hashPassword(password, { randomBytes: ctx.randomBytes });

	return Object.freeze({
		membershipsOf,

		// -----------------------------------------------------------------------------------------------------------
		// Merchant signup

		/**
		 * Self-signup: nothing is created until the e-mail is verified. The pending signup (password hash included)
		 * lives in the single-use token, so whoever verifies gets exactly the password chosen in that signup.
		 * @param {{ email: string, password: string, merchantName: string, name?: string }} input
		 */
		signup: async ({ email, password, merchantName, name }) => {
			requireMailer(mailer);
			const existing = await repo.users.findOne({ email });
			if (existing) {
				await sendQuietly(deps, {
					to: email,
					template: 'account_exists',
					data: { link: `${ctx.config.portalUrl}/login` },
				});
			} else {
				const token = await repo.issueToken('signup', {
					subject: email,
					data: { email, passwordHash: await hash(password), merchantName, name: name ?? null },
				});
				await sendQuietly(deps, {
					to: email,
					template: 'verify_email',
					data: { link: linkFor(ctx.config.portalUrl, 'verify_email', token), merchantName },
				});
			}
			return { status: 'verification_sent' };
		},

		/**
		 * Verify a signup: create the user, the merchant and the owner membership, then sign in.
		 * @param {{ token: string }} input
		 * @param {Meta} meta
		 */
		verifyEmail: async ({ token }, meta) => {
			const pending = await repo.consumeToken('signup', token);
			if (!pending) throw problem('token_invalid', 'This link is invalid or has expired.');
			const { email, passwordHash, merchantName, name } = pending.data;
			const now = new Date(ctx.now());
			const user = {
				_id: repo.id('usr'),
				email,
				name: name ?? null,
				status: 'active',
				passwordHash,
				emailVerifiedAt: now,
				totp: null,
				pendingTotp: null,
				recoveryHashes: [],
			};
			await insertUnique(() => repo.users.insertOne(user), 'conflict', 'An account with this e-mail already exists.');
			const merchantId = repo.id('mer');
			const merchant = {
				_id: merchantId,
				name: merchantName,
				nameKey: nameKey(merchantName),
				status: 'active',
				ownerUserId: user._id,
				suspension: null,
			};
			await repo.merchants.insertOne(merchant);
			await repo.memberships.of(merchantId).insertOne({ _id: repo.id('mbr'), userId: user._id, roles: ['owner'], grants: [] });
			const actor = { type: /** @type {'merchant_user'} */ ('merchant_user'), id: user._id };
			await audit(
				actor,
				'merchant.created',
				{ type: 'merchant', id: merchantId, merchantId },
				{
					after: { name: merchantName, ownerUserId: user._id },
					meta,
				},
			);
			const stored = await repo.users.findOne({ _id: user._id });
			const session = await startMerchantSession(stored ?? user, merchantId, meta);
			return { ...session, merchant: presentMerchant({ ...merchant, createdAt: now }) };
		},

		// -----------------------------------------------------------------------------------------------------------
		// Login / logout

		/**
		 * @param {{ email: string, password: string, merchantId?: string }} input
		 * @param {Meta} meta
		 */
		merchantLogin: async ({ email, password, merchantId }, meta) => {
			const account = accountKey('merchant', email);
			await throttleGate(ctx, account, meta);
			const user = await repo.users.findOne({ email });
			const ok = await verifyPassword(password, user?.passwordHash);
			if (!ok || !user || user.status !== 'active') return failAttempt(ctx, account, meta, BAD_LOGIN);
			await maybeRehash('merchant', user, password);
			return afterPassword(user, merchantId, meta);
		},

		/**
		 * Second step of a merchant login (or invite acceptance) for users with TOTP.
		 * @param {{ challenge: string, code?: string, recoveryCode?: string }} input
		 * @param {Meta} meta
		 */
		merchantLoginMfa: async ({ challenge, code, recoveryCode }, meta) => {
			const pending = await repo.peekToken('mfa_challenge', challenge);
			if (!pending) throw problem('token_invalid', 'The sign-in attempt has expired. Sign in again.');
			const user = await repo.users.findOne({ _id: pending.subject });
			if (!user || user.status !== 'active') throw problem('token_invalid', 'The sign-in attempt has expired. Sign in again.');
			const account = accountKey('merchant', user.email);
			await throttleGate(ctx, account, meta);
			const passed = await checkSecondFactor(ctx, repo.users, user, {
				...(code === undefined ? {} : { code }),
				...(recoveryCode === undefined ? {} : { recoveryCode }),
			});
			if (!passed) return failAttempt(ctx, account, meta, BAD_CODE);
			if (!(await repo.consumeToken('mfa_challenge', challenge)))
				throw problem('token_invalid', 'The sign-in attempt has expired. Sign in again.');
			return startMerchantSession(user, pending.data.merchantId, meta);
		},

		/**
		 * Staff login by e-mail or as `admin`. Staff with an authenticator get a session with `mfa: false` that only
		 * reaches the MFA routes until the code is verified; staff without one are signed in (the console then asks
		 * them to turn two-factor sign-in on).
		 * @param {{ email: string, password: string }} input
		 * @param {Meta} meta
		 */
		staffLogin: async ({ email, password }, meta) => {
			const account = accountKey('staff', email);
			await throttleGate(ctx, account, meta);
			const staff = await repo.staff.findOne(email === ADMIN_LOGIN ? { login: ADMIN_LOGIN } : { email });
			const ok = await verifyPassword(password, staff?.passwordHash);
			if (!ok || !staff || staff.status !== 'active') return failAttempt(ctx, account, meta, BAD_LOGIN);
			await maybeRehash('staff', staff, password);
			const { token } = await ctx.sessions.create({
				kind: 'staff',
				subject: String(staff._id),
				roles: staff.roles,
				mfa: !staff.totp,
				ip: meta.ip ?? null,
				userAgent: meta.userAgent ?? null,
			});
			if (!staff.totp) await ctx.loginThrottle.recordSuccess({ account });
			return {
				status: staff.totp ? 'mfa_required' : 'ok',
				staff: presentStaff(staff),
				cookie: cookie('staff', token),
			};
		},

		/**
		 * Create the first admin and sign it in: only while no staff user exists (then `conflict`). The visitor
		 * chooses the password; the account is the superadmin `admin`, without an e-mail.
		 * @param {{ password: string }} input
		 * @param {Meta} meta
		 */
		createFirstAdmin: async ({ password }, meta) => {
			if ((await repo.staff.countDocuments({})) > 0) throw problem('conflict', 'An admin already exists. Sign in.');
			const doc = {
				_id: repo.id('stf'),
				login: ADMIN_LOGIN,
				email: null,
				name: null,
				roles: ['superadmin'],
				status: 'active',
				passwordHash: await hash(password),
				totp: null,
				pendingTotp: null,
				recoveryHashes: [],
				createdBy: 'first_admin',
			};
			// concurrent attempts agree: the e-mail index admits a single account without an e-mail
			await insertUnique(() => repo.staff.insertOne(doc), 'conflict', 'An admin already exists. Sign in.');
			await audit(
				{ type: 'system', id: 'first_admin' },
				'staff.bootstrapped',
				{ type: 'staff', id: doc._id },
				{
					after: { login: ADMIN_LOGIN, roles: doc.roles },
					meta,
				},
			);
			const { token } = await ctx.sessions.create({
				kind: 'staff',
				subject: doc._id,
				roles: doc.roles,
				mfa: true,
				ip: meta.ip ?? null,
				userAgent: meta.userAgent ?? null,
			});
			return {
				status: 'ok',
				staff: presentStaff({ ...doc, createdAt: new Date(ctx.now()) }),
				cookie: cookie('staff', token),
			};
		},

		/**
		 * Change the signed-in staff member's name or e-mail (both optional).
		 * @param {{ id: string, name?: string, email?: string }} input
		 * @param {Meta} meta
		 */
		updateStaffProfile: async ({ id, name, email }, meta) => {
			const staff = await loadAccount('staff', id);
			const next = { ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) };
			try {
				await repo.staff.updateOne({ _id: staff._id }, { $set: next });
			} catch (error) {
				if (isDuplicateKey(error)) throw problem('conflict', 'A staff user with this e-mail exists.');
				throw error;
			}
			await audit(
				{ type: 'staff', id },
				'staff.profile_updated',
				{ type: 'staff', id },
				{
					before: { name: staff.name ?? null, email: staff.email ?? null },
					after: next,
					meta,
				},
			);
			return presentStaff({ ...staff, ...next });
		},

		/**
		 * Complete a staff login with a TOTP or recovery code: the session is rotated to `mfa: true`.
		 * @param {{ session: Session, token: string, code?: string, recoveryCode?: string }} input
		 * @param {Meta} meta
		 */
		staffVerifyMfa: async ({ session, token, code, recoveryCode }, meta) => {
			const staff = await loadAccount('staff', session.subject);
			if (!staff.totp) throw problem('conflict', 'Enrol an authenticator first.');
			const account = accountKey('staff', staff.email);
			await throttleGate(ctx, account, meta);
			const passed = await checkSecondFactor(ctx, repo.staff, staff, {
				...(code === undefined ? {} : { code }),
				...(recoveryCode === undefined ? {} : { recoveryCode }),
			});
			if (!passed) return failAttempt(ctx, account, meta, BAD_CODE);
			const rotated = await ctx.sessions.rotate(token, { mfa: true, roles: staff.roles });
			if (!rotated) throw problem('unauthorized', 'The session has expired. Sign in again.');
			await ctx.loginThrottle.recordSuccess({ account });
			if (recoveryCode !== undefined)
				await audit({ type: 'staff', id: staff._id }, 'staff.recovery_code_used', { type: 'staff', id: staff._id }, { meta });
			return { status: 'ok', staff: presentStaff(staff), cookie: cookie('staff', rotated.token) };
		},

		/**
		 * @param {Kind} kind
		 * @param {string} token
		 */
		logout: async (kind, token) => {
			await ctx.sessions.revoke(token);
			return { cookie: ctx.cookies.clear(kind) };
		},

		// -----------------------------------------------------------------------------------------------------------
		// MFA

		/**
		 * Start TOTP enrolment: returns the secret and `otpauth://` URI (shown once; sealed at rest).
		 * @param {Kind} kind
		 * @param {string} id
		 */
		mfaEnrol: async (kind, id) => {
			const account = await loadAccount(kind, id);
			if (account.totp) throw problem('conflict', 'Two-factor authentication is already enabled.');
			const secret = generateTotpSecret({ randomBytes: ctx.randomBytes });
			await accounts(kind).updateOne(
				{ _id: account._id },
				{ $set: { pendingTotp: { secret: ctx.envelope.seal(secret, { aad: totpAad(id) }), at: new Date(ctx.now()) } } },
			);
			return { secret, uri: totpUri({ secret, issuer: ISSUER, account: account.email ?? account.login ?? ADMIN_LOGIN }) };
		},

		/**
		 * Confirm enrolment with a first code: enables TOTP, returns 10 recovery codes (shown once) and rotates the
		 * session (`mfa: true`).
		 * @param {Kind} kind
		 * @param {{ id: string, token: string, code: string }} input
		 * @param {Meta} meta
		 */
		mfaConfirm: async (kind, { id, token, code }, meta) => {
			const account = await loadAccount(kind, id);
			if (account.totp) throw problem('conflict', 'Two-factor authentication is already enabled.');
			if (!account.pendingTotp) throw problem('conflict', 'Start the enrolment first.');
			const secret = ctx.envelope.openText(account.pendingTotp.secret, { aad: totpAad(id) });
			const key = accountKey(kind, account.email);
			await throttleGate(ctx, key, meta);
			const result = verifyTotp(secret, code, { now: ctx.now });
			if (!result.ok) return failAttempt(ctx, key, meta, BAD_CODE);
			const { codes, hashes } = generateRecoveryCodes({ secret: ctx.config.sessionSecret, randomBytes: ctx.randomBytes });
			const enabled = await accounts(kind).updateOne(
				{ _id: account._id, totp: null },
				{
					$set: {
						totp: { secret: account.pendingTotp.secret, lastStep: result.step, enabledAt: new Date(ctx.now()) },
						pendingTotp: null,
						recoveryHashes: hashes,
					},
				},
			);
			if (enabled.modifiedCount !== 1) throw problem('conflict', 'Two-factor authentication is already enabled.');
			const rotated = await ctx.sessions.rotate(token, { mfa: true });
			if (!rotated) throw problem('unauthorized', 'The session has expired. Sign in again.');
			await ctx.loginThrottle.recordSuccess({ account: key });
			const actor = { type: kind === 'staff' ? /** @type {const} */ ('staff') : /** @type {const} */ ('merchant_user'), id };
			await audit(
				actor,
				`${kind === 'staff' ? 'staff' : 'user'}.mfa_enabled`,
				{ type: kind === 'staff' ? 'staff' : 'user', id },
				{ meta },
			);
			return { recoveryCodes: codes, cookie: cookie(kind, rotated.token) };
		},

		/**
		 * Disable TOTP (merchant users only — staff MFA is mandatory). Needs the password and a second factor.
		 * @param {{ id: string, password: string, code?: string, recoveryCode?: string }} input
		 * @param {Meta} meta
		 */
		mfaDisable: async ({ id, password, code, recoveryCode }, meta) => {
			const user = await loadAccount('merchant', id);
			if (!user.totp) throw problem('conflict', 'Two-factor authentication is not enabled.');
			const key = accountKey('merchant', user.email);
			await throttleGate(ctx, key, meta);
			const passed =
				(await verifyPassword(password, user.passwordHash)) &&
				(await checkSecondFactor(ctx, repo.users, user, {
					...(code === undefined ? {} : { code }),
					...(recoveryCode === undefined ? {} : { recoveryCode }),
				}));
			if (!passed) return failAttempt(ctx, key, meta, BAD_CODE);
			await repo.users.updateOne({ _id: user._id }, { $set: { totp: null, pendingTotp: null, recoveryHashes: [] } });
			await audit({ type: 'merchant_user', id }, 'user.mfa_disabled', { type: 'user', id }, { meta });
			return { mfa: { enabled: false, recoveryCodesLeft: 0 } };
		},

		/**
		 * Replace the recovery codes (needs a current second factor).
		 * @param {Kind} kind
		 * @param {{ id: string, code?: string, recoveryCode?: string }} input
		 * @param {Meta} meta
		 */
		regenerateRecoveryCodes: async (kind, { id, code, recoveryCode }, meta) => {
			const account = await loadAccount(kind, id);
			if (!account.totp) throw problem('conflict', 'Two-factor authentication is not enabled.');
			const key = accountKey(kind, account.email);
			await throttleGate(ctx, key, meta);
			const passed = await checkSecondFactor(ctx, accounts(kind), account, {
				...(code === undefined ? {} : { code }),
				...(recoveryCode === undefined ? {} : { recoveryCode }),
			});
			if (!passed) return failAttempt(ctx, key, meta, BAD_CODE);
			const { codes, hashes } = generateRecoveryCodes({ secret: ctx.config.sessionSecret, randomBytes: ctx.randomBytes });
			await accounts(kind).updateOne({ _id: account._id }, { $set: { recoveryHashes: hashes } });
			const type = kind === 'staff' ? 'staff' : 'user';
			await audit(
				{ type: kind === 'staff' ? 'staff' : 'merchant_user', id },
				`${type}.recovery_codes_regenerated`,
				{ type, id },
				{ meta },
			);
			return { recoveryCodes: codes };
		},

		// -----------------------------------------------------------------------------------------------------------
		// Passwords

		/**
		 * Request a reset link (always the same answer). Earlier reset tokens of the account are invalidated.
		 * @param {Kind} kind
		 * @param {{ email: string }} input
		 */
		requestPasswordReset: async (kind, { email }) => {
			requireMailer(mailer);
			const account = await accounts(kind).findOne({ email });
			if (account && account.status === 'active') {
				await repo.dropTokens('password_reset', `${kind}:${account._id}`);
				const token = await repo.issueToken('password_reset', { subject: `${kind}:${account._id}` });
				await sendQuietly(deps, {
					to: email,
					template: 'password_reset',
					data: { link: linkFor(ctx.config.portalUrl, kind === 'staff' ? 'staff_password_reset' : 'password_reset', token) },
				});
			}
			return { status: 'reset_sent' };
		},

		/**
		 * Mint a staff password-setup link without mailing it (staff creation).
		 * @param {string} staffId
		 * @param {{ ttlMs?: number }} [options]
		 */
		staffSetupLink: async (staffId, { ttlMs } = {}) => {
			await repo.dropTokens('password_reset', `staff:${staffId}`);
			const token = await repo.issueToken('password_reset', {
				subject: `staff:${staffId}`,
				...(ttlMs === undefined ? {} : { ttlMs }),
			});
			return linkFor(ctx.config.portalUrl, 'staff_password_reset', token);
		},
		STAFF_WELCOME_TTL_MS,

		/**
		 * Mint a merchant user's password-setup link without mailing it (merchant created by staff): a single-use
		 * password-reset token, valid 72 h, consumed on the console's reset-password page.
		 * @param {string} userId
		 */
		merchantSetupLink: async (userId) => {
			await repo.dropTokens('password_reset', `merchant:${userId}`);
			const token = await repo.issueToken('password_reset', { subject: `merchant:${userId}`, ttlMs: MERCHANT_WELCOME_TTL_MS });
			return {
				link: linkFor(ctx.config.portalUrl, 'password_reset', token),
				expiresAt: new Date(ctx.now() + MERCHANT_WELCOME_TTL_MS).toISOString(),
			};
		},

		/**
		 * Set a new password with a reset token (single use, 30 min). Every session of the account is revoked and
		 * its lockout cleared.
		 * @param {Kind} kind
		 * @param {{ token: string, password: string }} input
		 * @param {Meta} meta
		 */
		confirmPasswordReset: async (kind, { token, password }, meta) => {
			const pending = await repo.consumeToken('password_reset', token);
			const [tokenKind, id] = String(pending?.subject ?? '').split(':');
			if (!pending || tokenKind !== kind || !id) throw problem('token_invalid', 'This link is invalid or has expired.');
			const account = await accounts(kind).findOne({ _id: id });
			if (!account || account.status !== 'active') throw problem('token_invalid', 'This link is invalid or has expired.');
			await accounts(kind).updateOne({ _id: account._id }, { $set: { passwordHash: await hash(password) } });
			await ctx.sessions.revokeAll(kind, id);
			await ctx.loginThrottle.recordSuccess({ account: accountKey(kind, account.email) });
			const type = kind === 'staff' ? 'staff' : 'user';
			await audit(
				{ type: kind === 'staff' ? 'staff' : 'merchant_user', id },
				`${type}.password_reset`,
				{ type, id },
				{ meta },
			);
		},

		/**
		 * Change the password (current password required); other sessions are revoked.
		 * @param {Kind} kind
		 * @param {{ id: string, token: string, currentPassword: string, newPassword: string }} input
		 * @param {Meta} meta
		 */
		changePassword: async (kind, { id, token, currentPassword, newPassword: next }, meta) => {
			const account = await loadAccount(kind, id);
			const key = accountKey(kind, account.email);
			await throttleGate(ctx, key, meta);
			if (!(await verifyPassword(currentPassword, account.passwordHash))) return failAttempt(ctx, key, meta, BAD_LOGIN);
			await accounts(kind).updateOne({ _id: account._id }, { $set: { passwordHash: await hash(next) } });
			await ctx.sessions.revokeAll(kind, id, { exceptToken: token });
			const type = kind === 'staff' ? 'staff' : 'user';
			await audit(
				{ type: kind === 'staff' ? 'staff' : 'merchant_user', id },
				`${type}.password_changed`,
				{ type, id },
				{ meta },
			);
		},

		// -----------------------------------------------------------------------------------------------------------
		// Me and sessions

		/**
		 * @param {Session} session
		 */
		me: async (session) => {
			if (session.kind === 'staff') {
				const staff = await loadAccount('staff', session.subject);
				return { kind: 'staff', staff: presentStaff(staff) };
			}
			const user = await loadAccount('merchant', session.subject);
			const memberships = await membershipsOf(session.subject);
			const merchants = await repo.merchants.find({ _id: { $in: memberships.map((m) => m.merchantId) } }).toArray();
			const byId = new Map(merchants.map((m) => [String(m._id), m]));
			return {
				kind: 'merchant',
				user: presentUser(user),
				merchantId: session.merchantId,
				memberships: memberships.map((m) => ({
					merchantId: m.merchantId,
					name: byId.get(m.merchantId)?.name ?? null,
					status: byId.get(m.merchantId)?.status ?? null,
					roles: m.roles,
					grants: m.grants,
				})),
			};
		},

		/**
		 * Switch the session to another merchant the user belongs to (session rotated).
		 * @param {{ session: Session, token: string, merchantId: string }} input
		 */
		switchMerchant: async ({ session, token, merchantId }) => {
			const membership = await repo.memberships.of(merchantId).findOne({ merchantId, userId: session.subject });
			if (!membership) throw problem('forbidden', 'You are not a member of this merchant.');
			const rotated = await ctx.sessions.rotate(token, {
				merchantId,
				roles: membership.roles,
				grants: membership.grants,
			});
			if (!rotated) throw problem('unauthorized', 'The session has expired. Sign in again.');
			return { merchantId, cookie: cookie('merchant', rotated.token) };
		},

		/** @param {Session} session */
		listSessions: async (session) =>
			(await ctx.sessions.list(session.kind, session.subject)).map((s) => ({
				sessionId: s.id,
				current: s.id === session.id,
				mfa: s.mfa,
				createdAt: iso(s.createdAt),
				lastSeenAt: iso(s.lastSeenAt),
				expiresAt: iso(s.expiresAt),
			})),

		/**
		 * @param {Session} session
		 * @param {string} sessionId
		 */
		revokeSession: async (session, sessionId) => {
			if (!(await ctx.sessions.revokeById(sessionId, { kind: session.kind, subject: session.subject })))
				throw problem('not_found', 'No such session.');
		},

		// -----------------------------------------------------------------------------------------------------------
		// Invites

		/**
		 * Accept an invite: an existing account proves itself with its password; otherwise a new account is created
		 * (the invite link proves the e-mail). Users with TOTP get an MFA challenge instead of a session.
		 * @param {{ token: string, password: string, name?: string }} input
		 * @param {Meta} meta
		 */
		acceptInvite: async ({ token, password, name }, meta) => {
			const invite = await repo.invites.all().findOne({ tokenHash: repo.tokenHash('invite', token), status: 'pending' });
			if (!invite || invite.expiresAt.getTime() <= ctx.now())
				throw problem('token_invalid', 'This invitation is invalid or has expired.');
			const merchantId = invite.merchantId;
			let user = await repo.users.findOne({ email: invite.email });
			if (user) {
				const account = accountKey('merchant', user.email);
				await throttleGate(ctx, account, meta);
				if (!(await verifyPassword(password, user.passwordHash)) || user.status !== 'active')
					return failAttempt(ctx, account, meta, BAD_LOGIN);
			} else {
				const checked = newPassword(password);
				if (!checked.ok)
					throw problem('validation_failed', 'The password is too weak.', {
						errors: [{ path: '/password', message: checked.message }],
					});
				user = {
					_id: repo.id('usr'),
					email: invite.email,
					name: name ?? null,
					status: 'active',
					passwordHash: await hash(password),
					emailVerifiedAt: new Date(ctx.now()),
					totp: null,
					pendingTotp: null,
					recoveryHashes: [],
				};
				const created = user;
				await insertUnique(() => repo.users.insertOne(created), 'conflict', 'Accept again: the account was just created.');
			}
			const userId = String(user._id);
			const claimed = await repo.invites
				.of(merchantId)
				.updateOne(
					{ merchantId, _id: invite._id, status: 'pending' },
					{ $set: { status: 'accepted', acceptedAt: new Date(ctx.now()), acceptedBy: userId } },
				);
			if (claimed.modifiedCount !== 1) throw problem('token_invalid', 'This invitation is invalid or has expired.');
			await insertUnique(
				() =>
					repo.memberships
						.of(merchantId)
						.insertOne({ _id: repo.id('mbr'), userId, roles: invite.roles, grants: invite.grants }),
				'conflict',
				'You are already a member of this merchant.',
			);
			await audit(
				{ type: 'merchant_user', id: userId },
				'team.invite_accepted',
				{ type: 'user', id: userId, merchantId },
				{ after: { inviteId: invite._id, roles: invite.roles, grants: invite.grants }, meta },
			);
			return afterPassword(user, merchantId, meta);
		},
	});
};
/** @typedef {ReturnType<typeof createAccounts>} Accounts */
