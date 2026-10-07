/**
 * Logins (PLAN 0.2): the one sign-in page for admins and merchants, two-step sign-in with recovery codes, the first
 * admin, setup links, Forgot password, changing a login (e-mail, password, two-step) and the signed-in person's own
 * account. Mechanisms (scrypt, TOTP, sessions, throttling) are the infra's.
 *
 * - One e-mail is one login, of exactly one admin or one merchant (`identity_logins`), so the sign-in page knows which
 *   console to open.
 * - Setup links work only while the login has no password; a suspended merchant's links never sign them in.
 * - Changing the e-mail or password, or turning two-step off, needs the current password plus a two-step or recovery
 *   code while two-step is on. A new e-mail takes effect only once confirmed from the new address; the old address
 *   gets a notice. A password change ends every other session of the login.
 * - Anti-enumeration: Forgot password answers the same whether the login exists; sign-in failures are one generic
 *   401; unknown logins burn a dummy scrypt verification.
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
import { linkFor } from './core/links.js';
import { presentAdmin, presentMerchant, twoStepOf } from './core/present.js';
import { SETUP_TTL_MS } from './core/tokens.js';
import { checkSecondFactor, failAttempt, insertUnique, openTotpSecret, sendLater, throttleGate, totpAad } from './repo.js';

/** @typedef {import('./repo.js').Deps} Deps */
/** @typedef {import('./repo.js').Meta} Meta */
/** @typedef {import('../../infra/auth.js').Session} Session */
/** @typedef {'admin' | 'merchant'} Kind */
/** @typedef {{ code?: string, recoveryCode?: string }} SecondFactor */

const BAD_LOGIN = 'The e-mail or password is incorrect.';
const BAD_CODE = 'The code is incorrect.';
const LINK_INVALID = 'This link is invalid or has expired.';

/** @param {Kind} kind @param {string} email */
const throttleKey = (kind, email) => `${kind}:${email}`;

/**
 * @param {Deps} deps
 */
export const createAccounts = (deps) => {
	const { ctx, repo, audit } = deps;
	/** @param {Kind} kind */
	const logins = (kind) => (kind === 'admin' ? repo.admins : repo.merchants);
	/** @param {Kind} kind */
	const maxAge = (kind) => Math.floor(ctx.config.sessions[kind].absoluteMs / 1000);
	/** @param {Kind} kind @param {string} token */
	const cookie = (kind, token) => ctx.cookies.set(kind, token, maxAge(kind));
	/** @param {string} password */
	const hash = (password) => hashPassword(password, { randomBytes: ctx.randomBytes });
	/** @param {Kind} kind @param {Record<string, any>} doc */
	const actorOf = (kind, doc) =>
		kind === 'admin'
			? { type: /** @type {const} */ ('admin'), id: String(doc._id), name: doc.name ?? null }
			: { type: /** @type {const} */ ('merchant'), id: String(doc._id) };
	/** @param {Kind} kind @param {Record<string, any>} doc */
	const targetOf = (kind, doc) =>
		kind === 'admin'
			? { type: 'admin', id: String(doc._id) }
			: { type: 'merchant', id: String(doc._id), merchantId: String(doc._id) };
	/** @param {Kind} kind @param {Record<string, any>} doc */
	const present = (kind, doc) => (kind === 'admin' ? presentAdmin(doc) : presentMerchant(doc, { forAdmin: false }));

	/**
	 * A live login of a session (admin active, merchant not deleted); 401 otherwise.
	 * @param {Kind} kind
	 * @param {string} id
	 */
	const loadLogin = async (kind, id) => {
		const doc = await logins(kind).findOne({ _id: id });
		if (!doc || (kind === 'admin' ? doc.status !== 'active' : doc.status === 'deleted'))
			throw problem('unauthorized', 'The session has ended. Sign in again.');
		return doc;
	};

	/**
	 * Refuse a suspended merchant (PLAN 0.2: they cannot sign in; the page shows the support contact).
	 * @param {Kind} kind
	 * @param {Record<string, any>} doc
	 */
	const refuseSuspended = (kind, doc) => {
		if (kind === 'merchant' && doc.status === 'suspended')
			throw problem('merchant_suspended', 'Your account is suspended. Contact support.');
	};

	/**
	 * Start a session after every factor passed.
	 * @param {Kind} kind
	 * @param {Record<string, any>} doc
	 * @param {Meta} meta
	 */
	const startSession = async (kind, doc, meta) => {
		const { token } = await ctx.sessions.create({
			kind,
			subject: String(doc._id),
			mfa: true,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
		});
		await logins(kind).updateOne({ _id: doc._id }, { $set: { lastSignInAt: new Date(ctx.now()) } });
		await ctx.loginThrottle.recordSuccess({ account: throttleKey(kind, doc.email) });
		await audit(actorOf(kind, doc), 'login.signed_in', targetOf(kind, doc), { meta });
		return {
			status: /** @type {'ok'} */ ('ok'),
			console: kind,
			[kind]: present(kind, doc),
			cookie: cookie(kind, token),
		};
	};

	/**
	 * A failed sign-in of an existing login is written to Activity (PLAN 0.5.12), then the generic problem is thrown.
	 * @param {Kind | null} kind
	 * @param {Record<string, any> | null} doc
	 * @param {string} email
	 * @param {Meta} meta
	 * @param {string} detail
	 * @returns {Promise<never>}
	 */
	const failSignIn = async (kind, doc, email, meta, detail) => {
		if (kind && doc) await audit(actorOf(kind, doc), 'login.sign_in_failed', targetOf(kind, doc), { meta });
		return failAttempt(ctx, throttleKey(kind ?? 'merchant', email), meta, detail);
	};

	/**
	 * Require the current password, plus a two-step or recovery code while two-step is on (PLAN 0.2 Changing a login).
	 * @param {Kind} kind
	 * @param {Record<string, any>} doc
	 * @param {string} password
	 * @param {SecondFactor} factor
	 * @param {Meta} meta
	 */
	const proveLogin = async (kind, doc, password, factor, meta) => {
		const key = throttleKey(kind, doc.email);
		await throttleGate(ctx, key, meta);
		if (!(await verifyPassword(password, doc.passwordHash))) return failAttempt(ctx, key, meta, BAD_LOGIN);
		if (doc.totp) {
			if (factor.code === undefined && factor.recoveryCode === undefined)
				throw problem('validation_failed', 'Enter a two-step code or a recovery code.', {
					errors: [{ path: '/code', message: 'is required while two-step is on' }],
				});
			const passed = await checkSecondFactor(ctx, logins(kind), doc, {
				...(factor.code === undefined ? {} : { code: factor.code }),
				...(factor.recoveryCode === undefined ? {} : { recoveryCode: factor.recoveryCode }),
			});
			if (!passed) return failAttempt(ctx, key, meta, BAD_CODE);
		}
	};

	/**
	 * Mint a setup link for a login without a password (cancels the previous one).
	 * @param {Kind} kind
	 * @param {string} id
	 */
	const setupLink = async (kind, id) => {
		await repo.dropTokens('setup', `${kind}:${id}`);
		const ttlMs = SETUP_TTL_MS[kind];
		const token = await repo.issueToken('setup', { subject: `${kind}:${id}`, ttlMs });
		return { link: linkFor(ctx.config.portalUrl, 'setup', token), expiresAt: new Date(ctx.now() + ttlMs).toISOString() };
	};

	/**
	 * The login a single-use token belongs to (`<kind>:<id>` subject).
	 * @param {Record<string, any> | null} pending
	 */
	const subjectOf = async (pending) => {
		const [kind, id] = String(pending?.subject ?? '').split(':');
		if (!pending || (kind !== 'admin' && kind !== 'merchant') || !id) throw problem('token_invalid', LINK_INVALID);
		const doc = await logins(kind).findOne({ _id: id });
		if (!doc || doc.status === 'deleted') throw problem('token_invalid', LINK_INVALID);
		return { kind: /** @type {Kind} */ (kind), doc };
	};

	return Object.freeze({
		setupLink,

		// -----------------------------------------------------------------------------------------------------------
		// Sign-in

		/**
		 * The one sign-in page: the login of the e-mail decides the console. With two-step on, a short-lived challenge
		 * is returned instead of a session.
		 * @param {{ email: string, password: string }} input
		 * @param {Meta} meta
		 */
		signIn: async ({ email, password }, meta) => {
			const login = await repo.loginOf(email);
			const kind = login?.kind ?? null;
			await throttleGate(ctx, throttleKey(kind ?? 'merchant', email), meta);
			const doc = login ? await logins(login.kind).findOne({ _id: login.subject }) : null;
			const ok = await verifyPassword(password, doc?.passwordHash);
			const usable = doc && (kind === 'admin' ? doc.status === 'active' : doc.status !== 'deleted');
			if (!ok || !kind || !doc || !usable) return failSignIn(kind, usable ? doc : null, email, meta, BAD_LOGIN);
			refuseSuspended(kind, doc);
			if (needsRehash(doc.passwordHash))
				await logins(kind).updateOne({ _id: doc._id }, { $set: { passwordHash: await hash(password) } });
			if (doc.totp) {
				const challenge = await repo.issueToken('two_step', { subject: `${kind}:${doc._id}` });
				return { status: /** @type {'two_step_required'} */ ('two_step_required'), challenge };
			}
			return startSession(kind, doc, meta);
		},

		/**
		 * Second step of a sign-in: a two-step code or a recovery code.
		 * @param {SecondFactor & { challenge: string }} input
		 * @param {Meta} meta
		 */
		signInTwoStep: async ({ challenge, code, recoveryCode }, meta) => {
			const pending = await repo.peekToken('two_step', challenge);
			if (!pending) throw problem('token_invalid', 'The sign-in attempt has expired. Sign in again.');
			const { kind, doc } = await subjectOf(pending);
			if (kind === 'admin' && doc.status !== 'active')
				throw problem('token_invalid', 'The sign-in attempt has expired. Sign in again.');
			const key = throttleKey(kind, doc.email);
			await throttleGate(ctx, key, meta);
			const passed = await checkSecondFactor(ctx, logins(kind), doc, {
				...(code === undefined ? {} : { code }),
				...(recoveryCode === undefined ? {} : { recoveryCode }),
			});
			if (!passed) return failSignIn(kind, doc, doc.email, meta, BAD_CODE);
			if (!(await repo.consumeToken('two_step', challenge)))
				throw problem('token_invalid', 'The sign-in attempt has expired. Sign in again.');
			refuseSuspended(kind, doc);
			if (recoveryCode !== undefined)
				await audit(actorOf(kind, doc), 'two_step.recovery_code_used', targetOf(kind, doc), { meta });
			return startSession(kind, doc, meta);
		},

		/** @returns {Promise<boolean>} true while no admin exists (the sign-in page offers Create admin) */
		firstAdminAvailable: async () => (await repo.admins.countDocuments({})) === 0,

		/**
		 * Create the first admin (an Owner) and sign it in: only while no admin exists. Atomic: the `firstAdmin` unique
		 * index admits one, whatever the timing.
		 * @param {{ name: string, email: string, password: string }} input
		 * @param {Meta} meta
		 */
		createFirstAdmin: async ({ name, email, password }, meta) => {
			if ((await repo.admins.countDocuments({})) > 0) throw problem('conflict', 'An admin already exists. Sign in.');
			const doc = {
				_id: repo.id('adm'),
				firstAdmin: true,
				email,
				name,
				role: 'owner',
				status: 'active',
				passwordHash: await hash(password),
				totp: null,
				pendingTotp: null,
				recoveryHashes: [],
				lastSignInAt: null,
			};
			await insertUnique(() => repo.admins.insertOne(doc), 'conflict', 'An admin already exists. Sign in.');
			try {
				await repo.claimLogin(email, 'admin', doc._id);
			} catch (error) {
				await repo.admins.deleteOne({ _id: doc._id });
				throw error;
			}
			await audit(
				{ type: 'system', id: 'first_admin' },
				'admin.created',
				{ type: 'admin', id: doc._id },
				{
					after: { role: 'owner', firstAdmin: true },
					meta,
				},
			);
			return startSession('admin', { ...doc, createdAt: new Date(ctx.now()) }, meta);
		},

		/**
		 * Sign out: this session ends.
		 * @param {Kind} kind
		 * @param {string} token
		 */
		signOut: async (kind, token) => {
			await ctx.sessions.revoke(token);
			return { cookie: ctx.cookies.clear(kind) };
		},

		// -----------------------------------------------------------------------------------------------------------
		// Links

		/**
		 * Forgot password (always the same answer). Only a login with a password gets a reset link; a suspended merchant
		 * gets none. Earlier reset links of the login stop working.
		 * @param {{ email: string }} input
		 */
		forgotPassword: async ({ email }) => {
			const login = await repo.loginOf(email);
			const doc = login ? await logins(login.kind).findOne({ _id: login.subject }) : null;
			if (login && doc?.passwordHash && doc.status === 'active') {
				const subject = `${login.kind}:${doc._id}`;
				await repo.dropTokens('password_reset', subject);
				const token = await repo.issueToken('password_reset', { subject });
				await audit(actorOf(login.kind, doc), 'login.reset_link_issued', targetOf(login.kind, doc), {});
				await sendLater(deps, {
					to: email,
					template: 'password_reset',
					data: { link: linkFor(ctx.config.portalUrl, 'password_reset', token) },
				});
			}
			return { status: 'reset_sent' };
		},

		/**
		 * Set a new password with a reset link (single use, 30 minutes). Every session of the login ends.
		 * @param {{ token: string, password: string }} input
		 * @param {Meta} meta
		 */
		resetPassword: async ({ token, password }, meta) => {
			const { kind, doc } = await subjectOf(await repo.consumeToken('password_reset', token));
			if (doc.status !== 'active' || !doc.passwordHash) throw problem('token_invalid', LINK_INVALID);
			await logins(kind).updateOne({ _id: doc._id }, { $set: { passwordHash: await hash(password) } });
			await ctx.sessions.revokeAll(kind, String(doc._id));
			await ctx.loginThrottle.recordSuccess({ account: throttleKey(kind, doc.email) });
			await audit(actorOf(kind, doc), 'login.password_reset', targetOf(kind, doc), { meta });
		},

		/**
		 * What a setup link is for (the page asks an invited admin for a name too). The link is not used up.
		 * @param {{ token: string }} input
		 */
		checkSetupLink: async ({ token }) => {
			const { kind, doc } = await subjectOf(await repo.peekToken('setup', token));
			if (doc.passwordHash) throw problem('token_invalid', LINK_INVALID);
			return { console: kind, email: doc.email, needsName: kind === 'admin' };
		},

		/**
		 * Use a setup link: set the first password (and an invited admin's name), then sign in. Works only while the
		 * login has no password; a suspended merchant's link is refused.
		 * @param {{ token: string, password: string, name?: string }} input
		 * @param {Meta} meta
		 */
		setPassword: async ({ token, password, name }, meta) => {
			const peeked = await subjectOf(await repo.peekToken('setup', token));
			if (peeked.doc.passwordHash) throw problem('token_invalid', LINK_INVALID);
			if (peeked.kind === 'merchant' && peeked.doc.status === 'suspended') throw problem('token_invalid', LINK_INVALID);
			if (peeked.kind === 'admin' && !name)
				throw problem('validation_failed', 'Enter your name.', { errors: [{ path: '/name', message: 'is required' }] });
			const { kind, doc } = await subjectOf(await repo.consumeToken('setup', token));
			const set =
				kind === 'admin'
					? { passwordHash: await hash(password), name, status: 'active' }
					: { passwordHash: await hash(password) };
			const changed = await logins(kind).updateOne({ _id: doc._id, passwordHash: null }, { $set: set });
			if (changed.modifiedCount !== 1) throw problem('token_invalid', LINK_INVALID);
			const fresh = { ...doc, ...set };
			await audit(
				actorOf(kind, fresh),
				kind === 'admin' ? 'admin.invite_accepted' : 'login.password_set',
				targetOf(kind, fresh),
				{
					meta,
				},
			);
			return startSession(kind, fresh, meta);
		},

		/**
		 * Confirm a new login e-mail from the link sent to it. Refused when the address became another login meanwhile.
		 * @param {{ token: string }} input
		 * @param {Meta} meta
		 */
		confirmEmail: async ({ token }, meta) => {
			const pending = await repo.consumeToken('email_change', token);
			const { kind, doc } = await subjectOf(pending);
			const next = String(pending?.data?.email ?? '');
			if (!next || doc.email !== pending?.data?.from) throw problem('token_invalid', LINK_INVALID);
			await repo.claimLogin(next, kind, String(doc._id));
			await logins(kind).updateOne({ _id: doc._id }, { $set: { email: next } });
			await repo.releaseLogin(doc.email, String(doc._id));
			await audit(actorOf(kind, doc), 'login.email_changed', targetOf(kind, doc), { meta });
			return { console: kind, email: next };
		},

		// -----------------------------------------------------------------------------------------------------------
		// The signed-in person

		/**
		 * The signed-in admin or merchant, with what the consoles need.
		 * @param {Session} session
		 * @param {{ twoStepRequired?: boolean }} [actor]
		 */
		me: async (session, actor = {}) => {
			const kind = session.kind;
			const doc = await loadLogin(kind, session.subject);
			return {
				kind,
				[kind]: present(kind, doc),
				twoStepRequired: actor.twoStepRequired === true,
			};
		},

		/**
		 * An admin edits their own name (My account).
		 * @param {{ id: string, name: string }} input
		 * @param {Meta} meta
		 */
		updateAdminProfile: async ({ id, name }, meta) => {
			const doc = await loadLogin('admin', id);
			await repo.admins.updateOne({ _id: doc._id }, { $set: { name } });
			await audit(actorOf('admin', { ...doc, name }), 'admin.profile_updated', targetOf('admin', doc), {
				after: { fields: ['name'] },
				meta,
			});
			return presentAdmin({ ...doc, name });
		},

		/**
		 * Ask to change the login e-mail: a confirmation link goes to the new address and a notice to the old one.
		 * @param {Kind} kind
		 * @param {SecondFactor & { id: string, email: string, password: string }} input
		 * @param {Meta} meta
		 */
		requestEmailChange: async (kind, { id, email, password, code, recoveryCode }, meta) => {
			const doc = await loadLogin(kind, id);
			await proveLogin(kind, doc, password, { ...(code ? { code } : {}), ...(recoveryCode ? { recoveryCode } : {}) }, meta);
			if (email === doc.email) throw problem('conflict', 'This is already your sign-in e-mail.');
			if (await repo.loginOf(email)) throw problem('email_taken', 'This e-mail is already used by another login.');
			const subject = `${kind}:${doc._id}`;
			await repo.dropTokens('email_change', subject);
			const token = await repo.issueToken('email_change', { subject, data: { email, from: doc.email } });
			await sendLater(deps, {
				to: email,
				template: 'email_change_confirm',
				data: { link: linkFor(ctx.config.portalUrl, 'email_change', token) },
			});
			await sendLater(deps, { to: doc.email, template: 'email_change_notice', data: { newEmail: email } });
			await audit(actorOf(kind, doc), 'login.email_change_requested', targetOf(kind, doc), { meta });
			return { status: 'confirmation_sent' };
		},

		/**
		 * Change the password (current password, plus a code while two-step is on); every other session ends.
		 * @param {Kind} kind
		 * @param {SecondFactor & { id: string, token: string, currentPassword: string, newPassword: string }} input
		 * @param {Meta} meta
		 */
		changePassword: async (kind, { id, token, currentPassword, newPassword: next, code, recoveryCode }, meta) => {
			const doc = await loadLogin(kind, id);
			await proveLogin(
				kind,
				doc,
				currentPassword,
				{ ...(code ? { code } : {}), ...(recoveryCode ? { recoveryCode } : {}) },
				meta,
			);
			await logins(kind).updateOne({ _id: doc._id }, { $set: { passwordHash: await hash(next) } });
			await ctx.sessions.revokeAll(kind, id, { exceptToken: token });
			await audit(actorOf(kind, doc), 'login.password_changed', targetOf(kind, doc), { meta });
		},

		// -----------------------------------------------------------------------------------------------------------
		// Two-step

		/**
		 * Start setting two-step up: the secret and `otpauth://` URI (shown once; sealed at rest with `ENCRYPTION_KEY`).
		 * @param {Kind} kind
		 * @param {string} id
		 */
		twoStepStart: async (kind, id) => {
			const doc = await loadLogin(kind, id);
			if (doc.totp) throw problem('conflict', 'Two-step sign-in is already on.');
			const secret = generateTotpSecret({ randomBytes: ctx.randomBytes });
			await logins(kind).updateOne(
				{ _id: doc._id },
				{ $set: { pendingTotp: { secret: ctx.secretBox.seal(secret, { aad: totpAad(id) }), at: new Date(ctx.now()) } } },
			);
			return { secret, uri: totpUri({ secret, issuer: ctx.config.settings.branding.name, account: doc.email }) };
		},

		/**
		 * Confirm two-step with a first code: turns it on and returns 10 recovery codes (shown once).
		 * @param {Kind} kind
		 * @param {{ id: string, code: string }} input
		 * @param {Meta} meta
		 */
		twoStepConfirm: async (kind, { id, code }, meta) => {
			const doc = await loadLogin(kind, id);
			if (doc.totp) throw problem('conflict', 'Two-step sign-in is already on.');
			const secret = doc.pendingTotp ? openTotpSecret(ctx, doc.pendingTotp.secret, id) : null;
			if (!secret) throw problem('conflict', 'Start setting two-step up first.');
			const key = throttleKey(kind, doc.email);
			await throttleGate(ctx, key, meta);
			const result = verifyTotp(secret, code, { now: ctx.now });
			if (!result.ok) return failAttempt(ctx, key, meta, BAD_CODE);
			const { codes, hashes } = generateRecoveryCodes({ secret: ctx.config.sessionSecret, randomBytes: ctx.randomBytes });
			const enabled = await logins(kind).updateOne(
				{ _id: doc._id, totp: null },
				{
					$set: {
						totp: { secret: doc.pendingTotp.secret, lastStep: result.step, enabledAt: new Date(ctx.now()) },
						pendingTotp: null,
						recoveryHashes: hashes,
					},
				},
			);
			if (enabled.modifiedCount !== 1) throw problem('conflict', 'Two-step sign-in is already on.');
			await ctx.loginThrottle.recordSuccess({ account: key });
			await audit(actorOf(kind, doc), 'two_step.turned_on', targetOf(kind, doc), { meta });
			return { recoveryCodes: codes };
		},

		/**
		 * Turn two-step off yourself: password + a two-step or recovery code.
		 * @param {Kind} kind
		 * @param {SecondFactor & { id: string, password: string }} input
		 * @param {Meta} meta
		 */
		twoStepOff: async (kind, { id, password, code, recoveryCode }, meta) => {
			const doc = await loadLogin(kind, id);
			if (!doc.totp) throw problem('conflict', 'Two-step sign-in is not on.');
			await proveLogin(kind, doc, password, { ...(code ? { code } : {}), ...(recoveryCode ? { recoveryCode } : {}) }, meta);
			await logins(kind).updateOne({ _id: doc._id }, { $set: { totp: null, pendingTotp: null, recoveryHashes: [] } });
			await audit(actorOf(kind, doc), 'two_step.turned_off', targetOf(kind, doc), { meta });
			return { twoStep: twoStepOf({}) };
		},

		/**
		 * Make a new set of 10 recovery codes (password + a code); the old set stops working.
		 * @param {Kind} kind
		 * @param {SecondFactor & { id: string, password: string }} input
		 * @param {Meta} meta
		 */
		newRecoveryCodes: async (kind, { id, password, code, recoveryCode }, meta) => {
			const doc = await loadLogin(kind, id);
			if (!doc.totp) throw problem('conflict', 'Two-step sign-in is not on.');
			await proveLogin(kind, doc, password, { ...(code ? { code } : {}), ...(recoveryCode ? { recoveryCode } : {}) }, meta);
			const { codes, hashes } = generateRecoveryCodes({ secret: ctx.config.sessionSecret, randomBytes: ctx.randomBytes });
			await logins(kind).updateOne({ _id: doc._id }, { $set: { recoveryHashes: hashes } });
			await audit(actorOf(kind, doc), 'two_step.recovery_codes_replaced', targetOf(kind, doc), { meta });
			return { recoveryCodes: codes };
		},

		/**
		 * An Owner turns off someone else's two-step (lost authenticator and recovery codes): never their own. The
		 * person is e-mailed and their recovery codes are deleted.
		 * @param {Kind} kind
		 * @param {{ id: string, actor: import('../../infra/rbac.js').Actor, meta?: Meta }} input
		 */
		turnOffTwoStepFor: async (kind, { id, actor, meta = {} }) => {
			if (kind === 'admin' && actor.id === id)
				throw problem('conflict', 'You cannot turn off your own two-step here. Use My account.');
			const doc = await logins(kind).findOne({ _id: id });
			if (!doc || doc.status === 'deleted')
				throw problem('not_found', kind === 'admin' ? 'No such admin.' : 'No such merchant.');
			if (!doc.totp) throw problem('conflict', 'Two-step sign-in is not on.');
			await logins(kind).updateOne({ _id: doc._id }, { $set: { totp: null, pendingTotp: null, recoveryHashes: [] } });
			await sendLater(deps, { to: doc.email, template: 'two_step_off', data: {} });
			await audit(actor, 'two_step.turned_off_by_owner', targetOf(kind, doc), { meta });
			return present(kind, { ...doc, totp: null, recoveryHashes: [] });
		},
	});
};
/** @typedef {ReturnType<typeof createAccounts>} Accounts */
