/**
 * Sign-up and sign-in (PLAN 0.8.6), one handler per method, plus sessions (renew, sign out), two-step, invites and
 * social sign-ins (start, the provider's callback, the hand-over). Every method ends in `service.finish()`, which runs
 * the blocked, approval, terms and two-step checks before a session starts.
 * @module
 */
import { problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { normaliseEmail } from '../core/identifiers.js';
import { checkCustomValues, checkName, identityOfMethod, resetsByEmail, selfView } from '../core/profile.js';
import { DEFAULT_ROLE } from '../core/roles.js';
import {
	CODE_ATTEMPTS,
	CODE_COOLDOWN_SECONDS,
	CODES_PER_HOUR,
	emailRefused,
	generateCode,
	lockAfter,
	newUserNameOf,
	normaliseCode,
	passwordProblem,
	phoneCountryAllowed,
	returnAddress,
} from '../core/rules.js';
import { LINK_PARAMS } from '../core/widgets.js';
import {
	dummyPasswordCheck,
	generateRecoveryCodes,
	hashPassword,
	matchRecoveryCode,
	randomBytes,
	randomSecret,
	safeEqual,
	sha256,
	verifyTotp,
} from '../adapters/crypto.js';
import { parseSecret } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/profile.js').UserRecord} UserRecord */
/** @typedef {import('../adapters/store.js').SessionRecord} SessionRecord */

/** Fixed windows of the network limit (A9), of the reset e-mails per address (ST-12) and of the hourly code caps (A7). */
const NETWORK_WINDOW_MS = 15 * 60_000;
const RESET_WINDOW_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
/** Digits of a sign-in code staff make (A3). */
export const STAFF_CODE_LENGTH = 6;
/**
 * A refresh token presented again this soon after its renewal gets the current pair instead of ending the session:
 * the merchant's server renews from parallel requests, or retries a renew (RW-1; code constant).
 */
const REFRESH_GRACE_MS = 30_000;

/** @param {unknown} value */
const bodyOf = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {});

/** Refusals of a code (cooldown, caps) that a Forgot password request never shows (ST-3). */
const QUIET_REFUSALS = Object.freeze(['code_cooldown', 'code_limit']);

/**
 * Work right after the answer whose refusals the visitor never sees, so the answer is the same for every address.
 * @param {any} ctx @param {() => Promise<unknown>} task
 */
const afterAnswer = (ctx, task) =>
	ctx.after(() =>
		task().catch((error) => {
			if (!QUIET_REFUSALS.includes(String(/** @type {{ code?: unknown } | null} */ (error)?.code))) throw error;
		}),
	);

/** @param {string} field @param {string} message */
export const invalid = (field, message) =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code: 'invalid' }] });

/** A new user's empty profile. @returns {Omit<UserRecord, 'id' | 'createdAt'>} */
const blankUser = () => ({
	email: null,
	emailVerified: false,
	phone: null,
	phoneVerified: false,
	name: '',
	addresses: [],
	custom: {},
	notes: '',
	blocked: null,
	status: 'active',
	role: DEFAULT_ROLE,
	providers: {},
	passwordHash: null,
	twoStep: null,
	failedLogins: 0,
	lockedUntil: null,
	lockLevel: 0,
	terms: null,
	deletion: null,
	deviceHash: null,
	lastSignInAt: null,
});

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createFlows = (product, service) => {
	const { now, providers } = product;

	/**
	 * The profile a sign-up gives: the required standard fields, the custom fields and accepted terms, checked
	 * against the website's rules. `known` holds the address the method proved.
	 * @param {Site} s @param {Record<string, any>} body @param {{ email?: string, phone?: string, social?: boolean }} known
	 */
	const signUpProfile = async (s, body, known) => {
		const rules = await service.signUpRules(s);
		if (rules.mode === 'invite') throw problem('sign_up_closed', 'Sign-up is by invitation only.');
		const name = checkName(body.name);
		if (name === null) throw invalid('name', 'The name is too long.');
		const email = known.email ?? (body.email === undefined || body.email === '' ? null : normaliseEmail(body.email));
		if (email === null && body.email !== undefined && body.email !== '')
			throw invalid('email', 'Enter a valid e-mail address.');
		const phone = known.phone ?? (body.phone === undefined || body.phone === '' ? null : await service.phoneOf(s, body.phone));
		if (phone === null && body.phone !== undefined && body.phone !== '')
			throw invalid('phone', 'Enter the phone number with its country code.');
		if (!known.social)
			for (const field of rules.requiredFields)
				if ((field === 'name' && !name) || (field === 'email' && !email) || (field === 'phone' && !phone))
					throw invalid(
						field,
						`The ${field === 'name' ? 'name' : field === 'email' ? 'e-mail address' : 'phone number'} is required.`,
					);
		/** @type {Record<string, string | number>} */
		let custom = {};
		if (s.on.includes('custom_fields')) {
			const checked = checkCustomValues(await s.store.fields.list(), body.custom, { complete: !known.social });
			if (!checked.ok) throw invalid(checked.field, checked.message);
			custom = checked.value;
		}
		/** @type {{ version: string, acceptedAt: Date } | null} */
		let terms = null;
		if (s.on.includes('terms')) {
			const { version, url } = await service.settings(s, 'terms');
			if (body.acceptTerms !== true && !known.social)
				throw problem('terms_required', 'Accept the terms to continue.', { extensions: { version, url } });
			if (body.acceptTerms === true) terms = { version: String(version), acceptedAt: new Date(now()) };
		}
		return { mode: rules.mode, name, email, phone, custom, terms };
	};

	/**
	 * Risk checks of a sign-up (disposable e-mails, accounts per device and per network).
	 * @param {Site} s @param {string | null} email @param {ReturnType<Service['howOf']>} how
	 */
	const riskCheck = async (s, email, how) => {
		const deviceHash = how.deviceId ? sha256(`${s.websiteId}|device|${how.deviceId}`) : null;
		const networkHash = sha256(`${s.websiteId}|network|${how.network}`);
		if (s.on.includes('risk_checks')) {
			const rules = await service.settings(s, 'risk_checks');
			if (email && emailRefused(email, { blockDisposable: rules.blockDisposable, blockedDomains: rules.blockedDomains }))
				throw problem('risk_refused', 'This e-mail address cannot be used here.');
			if (deviceHash && (await s.store.signups.byDevice(deviceHash)) >= rules.maxAccountsPerDevice)
				throw problem('risk_refused', 'Too many accounts were made on this device.');
			if ((await s.store.signups.byNetwork(networkHash, new Date(now() - 86_400_000))) >= rules.maxSignUpsPerNetworkPerDay)
				throw problem('risk_refused', 'Too many accounts were made from this network in the last 24 hours.');
		}
		return { deviceHash, networkHash };
	};

	/**
	 * Create a user from a sign-up; `pending` when approval is required. Refused while the default role's sign-in is
	 * paused or does not allow the method (A6). The account keeps the address it was made with (its identity), which
	 * Forgot password by e-mail goes by.
	 * @param {Site} s @param {Awaited<ReturnType<typeof signUpProfile>>} profile @param {Partial<UserRecord>} extra
	 * @param {ReturnType<Service['howOf']>} how @param {string} method
	 */
	const createUser = async (s, profile, extra, how, method) => {
		await service.allowCode(s, null, method);
		const risk = await riskCheck(s, profile.email, how);
		const user = await s.store.users.create({
			...blankUser(),
			email: profile.email,
			phone: profile.phone,
			name: profile.name ?? '',
			custom: profile.custom,
			terms: profile.terms,
			status: profile.mode === 'approval' ? 'pending' : 'active',
			deviceHash: risk.deviceHash,
			identity: identityOfMethod(method),
			...extra,
		});
		if (!user) throw problem('already_exists', 'An account with this e-mail address or phone number exists. Sign in instead.');
		await s.store.signups.add(risk);
		return user;
	};

	/**
	 * The answer to a sign-up waiting for approval, else the sign-in.
	 * @param {Site} s @param {UserRecord} user @param {{ method: string, remember: boolean, device: string, acceptTerms?: unknown }} how
	 */
	const afterSignUp = async (s, user, how) => (user.status === 'pending' ? { status: 'pending' } : service.finish(s, user, how));

	/**
	 * The password rules of a method (A2, A9, ST-26): each of Email + password and Phone + password has its own lengths,
	 * letter-and-digit, breached-password and lock settings; the lock mode, the network limit and the personal check
	 * are Email + password's, for both.
	 * @param {Site} s @param {string} method
	 */
	const passwordRules = async (s, method) => {
		const email = await service.settings(s, 'email_password');
		const own = method === 'phone_password' ? await service.settings(s, 'phone_password') : email;
		return {
			minLength: Number(own.minLength),
			maxLength: Number(own.maxLength),
			letterAndDigit: own.letterAndDigit === true,
			breachedCheck: own.breachedCheck === true,
			maxAttempts: Number(own.maxAttempts),
			lockMinutes: Number(own.lockMinutes),
			lockMode: String(email.lockMode),
			networkLimit: Number(email.networkLimit),
			personalCheck: email.personalCheck === true,
		};
	};

	/**
	 * A new password: the method's rules, then the breached-password list.
	 * @param {Site} s @param {unknown} password
	 * @param {{ method?: string, who?: { name?: string | null, email?: string | null } }} [options] whose password (the
	 *   personal check)
	 */
	const newPassword = async (s, password, { method = 'email_password', who = {} } = {}) => {
		const rules = await passwordRules(s, method);
		const reason = passwordProblem(password, {
			minLength: rules.minLength,
			maxLength: rules.maxLength,
			letterAndDigit: rules.letterAndDigit,
			personal: rules.personalCheck ? who : null,
		});
		if (reason === 'too_short') throw problem('weak_password', `Use at least ${rules.minLength} characters.`);
		if (reason === 'too_long') throw problem('weak_password', `Use at most ${rules.maxLength} characters.`);
		if (reason === 'letter_and_digit') throw problem('weak_password', 'Use at least one letter and one digit.');
		if (reason === 'personal')
			throw problem('weak_password', 'Do not use your name, your e-mail address or runs like 1234 or qwer.');
		if (rules.breachedCheck && (await providers.breached(/** @type {string} */ (password))))
			throw problem('weak_password', 'This password appeared in a data breach. Choose another one.');
		return hashPassword(/** @type {string} */ (password));
	};

	/**
	 * A password sign-in (e-mail or phone, A2, A9): the network limit, the lock, the password (or, with Phone +
	 * password, a sign-in code from staff, A3), the lock after a failure and the sign-in log (A10).
	 * @param {Site} s @param {any} ctx
	 * @param {{ method: 'email_password' | 'phone_password', identifier: string | null, user: UserRecord | null }} who
	 */
	const passwordSignInOf = async (s, ctx, { method, identifier, user }) => {
		const body = bodyOf(ctx.body);
		const rules = await passwordRules(s, method);
		const failed = () =>
			problem(
				'sign_in_failed',
				method === 'phone_password' ? 'The phone number or password is wrong.' : 'The e-mail address or password is wrong.',
			);
		if (
			identifier &&
			rules.networkLimit > 0 &&
			!(await s.store.counters.take(`tries|${sha256(`${s.ip}|${identifier}`)}`, NETWORK_WINDOW_MS, rules.networkLimit))
		)
			throw problem('rate_limited', 'Too many tries from this network. Try again later.');
		if (!user || typeof body.password !== 'string' || body.password.length > 1024) {
			await dummyPasswordCheck();
			throw failed();
		}
		if (user.lockedUntil && user.lockedUntil.getTime() > now())
			throw problem('locked', 'Too many wrong passwords. Try again later.', {
				extensions: { lockedUntil: user.lockedUntil.toISOString() },
			});
		const passwordOk = await service.checkPassword(s, user, body.password);
		// with Phone + password, a sign-in code from staff works in the password box (A3)
		const staffCode = !passwordOk && method === 'phone_password' ? await staffCodeOf(s, user, body.password) : null;
		if (!passwordOk && !staffCode) {
			const failures = await s.store.users.failedLogin(user.id);
			await s.store.users.update(user.id, { ...lockAfter({ ...rules, failures, now: now() }) });
			await service.logSignIn(s, user, 'user.sign_in_failed', 'Wrong password');
			throw failed();
		}
		const answer = await service.finish(s, user, { method, ...service.howOf(ctx), acceptTerms: body.acceptTerms });
		if (staffCode) await s.store.codes.consume(staffCode);
		return answer;
	};

	/**
	 * The record of a sign-in code staff made for the user (A3, while the feature is on) that matches what they typed,
	 * or null.
	 * @param {Site} s @param {UserRecord} user @param {unknown} typed
	 */
	const staffCodeOf = async (s, user, typed) => {
		if (!s.on.includes('staff_links')) return null;
		const record = await s.store.codes.latest('staff_code', user.id);
		const code = record ? normaliseCode(typed, STAFF_CODE_LENGTH) : null;
		return record && code !== null && safeEqual(record.hash, sha256(`${record.id}:${code}`)) ? record.id : null;
	};

	/**
	 * A one-time code for an address, sent through Notifications (cooldown and hourly cap are code constants).
	 * @param {Site} s @param {'phone' | 'email' | 'phone_reset'} kind @param {string} target
	 * @param {{ length: number, minutes: number, linkTo?: string | null }} shape
	 * @param {(code: string, link: string | null, expireAt: Date) => Promise<void>} deliver
	 */
	const sendCode = async (s, kind, target, { length, minutes, linkTo }, deliver) => {
		const latest = await s.store.codes.latest(kind, target);
		if (kind === 'email') {
			if (latest && now() - latest.createdAt.getTime() < CODE_COOLDOWN_SECONDS * 1000)
				throw problem('too_soon', `Wait ${CODE_COOLDOWN_SECONDS} seconds before asking for another code.`);
			if ((await s.store.codes.countSince(kind, target, new Date(now() - 3_600_000))) >= CODES_PER_HOUR)
				throw problem('too_soon', 'Too many codes were asked for. Try again later.');
		} else {
			// codes by SMS or WhatsApp: the Phone code settings (A7), for sign-in and reset codes alike
			const { cooldownSeconds, perHour, websitePerHour } = await service.settings(s, 'phone_code');
			if (latest && now() - latest.createdAt.getTime() < cooldownSeconds * 1000)
				throw problem('code_cooldown', `Wait ${cooldownSeconds} seconds before asking for another code.`, {
					extensions: { retryAt: new Date(latest.createdAt.getTime() + cooldownSeconds * 1000).toISOString() },
				});
			if (!(await s.store.counters.take(`codes|${target}`, HOUR_MS, perHour)))
				throw problem('code_limit', 'Too many codes were asked for this number. Try again later.');
			if (websitePerHour > 0 && !(await s.store.counters.take('codes|website', HOUR_MS, websitePerHour)))
				throw problem('code_limit', 'Too many codes were asked for. Try again later.');
		}
		const code = generateCode({ length, randomBytes });
		const linkSecret = linkTo ? randomSecret(32) : null;
		const expireAt = new Date(now() + minutes * 60_000);
		const id = createId('cod');
		await s.store.codes.add({
			id,
			kind,
			target,
			hash: sha256(`${id}:${code}`),
			expireAt,
			data: { length, ...(linkSecret ? { linkHash: sha256(linkSecret) } : {}) },
		});
		const link = linkTo && linkSecret ? `${linkTo}#${LINK_PARAMS.magic}=${id}.${linkSecret}` : null;
		try {
			await deliver(code, link, expireAt);
		} catch (error) {
			await s.store.codes.consume(id);
			throw error;
		}
		return { expiresAt: expireAt.toISOString() };
	};

	/**
	 * Check a code the user typed against the newest one sent to the address (used up after too many wrong tries);
	 * the right one is used up by `codeSignIn` once the sign-in passed its checks, so a terms or profile step can be
	 * retried with the same code.
	 * @param {Site} s @param {'phone' | 'email' | 'phone_reset'} kind @param {string} target @param {unknown} typed
	 * @returns {Promise<{ id: string, staff: boolean }>} the code record's id; `staff`: it is a sign-in code staff made
	 *   for the address's user (A3), which says who the user is but does not prove the address
	 */
	const checkCode = async (s, kind, target, typed) => {
		const sent = await s.store.codes.latest(kind, target);
		// a sign-in code staff made for the user works in the same screen (A3)
		const user =
			kind === 'phone' ? await s.store.users.byPhone(target) : kind === 'email' ? await s.store.users.byEmail(target) : null;
		const staff = user && s.on.includes('staff_links') ? await s.store.codes.latest('staff_code', user.id) : null;
		for (const record of [sent, staff]) {
			const code = record ? normaliseCode(typed, Number(record.data.length)) : null;
			if (record && code !== null && safeEqual(record.hash, sha256(`${record.id}:${code}`)))
				return { id: record.id, staff: record === staff };
		}
		for (const record of [sent, staff])
			if (record && (await s.store.codes.attempt(record.id)) >= CODE_ATTEMPTS) await s.store.codes.consume(record.id);
		throw problem('code_invalid', 'The code is not valid or has expired.');
	};

	/**
	 * The account an e-mail code, a magic link or a social sign-in (which prove the address) may open: only one whose
	 * address was proven before. An address typed but never proven (at a phone sign-up, a role request, an e-mail +
	 * password sign-up) is no way in: it counts as unknown, so the sign-up that follows finds it taken.
	 * @param {Site} s @param {string} email
	 */
	const provenHolderOf = async (s, email) => {
		const holder = await s.store.users.byEmail(email);
		return holder?.emailVerified ? holder : null;
	};

	/**
	 * Sign in (or up) the owner of a proven address, then use up the code or link. A sign-in code staff made (A3) opens
	 * the account it was made for, but proves no e-mail address.
	 * @param {Site} s @param {any} ctx @param {'phone' | 'email'} kind @param {string} target
	 * @param {{ id: string, staff: boolean }} record the code or link used
	 */
	const codeSignIn = async (s, ctx, kind, target, { id: recordId, staff }) => {
		const body = bodyOf(ctx.body);
		const how = {
			method: kind === 'phone' ? 'phone_code' : 'email_code',
			...service.howOf(ctx),
			acceptTerms: body.acceptTerms,
		};
		const verified = kind === 'phone' ? 'phoneVerified' : 'emailVerified';
		const existing =
			kind === 'phone'
				? await s.store.users.byPhone(target)
				: staff
					? await s.store.users.byEmail(target)
					: await provenHolderOf(s, target);
		/** @type {Record<string, unknown>} */
		let answer;
		if (existing) {
			const user =
				existing[verified] || (staff && kind === 'email')
					? existing
					: ((await s.store.users.update(existing.id, { [verified]: true })) ?? existing);
			answer = await service.finish(s, user, how);
		} else {
			const profile = await signUpProfile(s, body, kind === 'phone' ? { phone: target } : { email: target });
			if (kind === 'phone' && !profile.name) {
				// a new phone-code user without a name gets the website's name for them (A7)
				const { newUserName } = await service.settings(s, 'phone_code');
				profile.name = newUserNameOf(String(newUserName), target);
			}
			answer = await afterSignUp(s, await createUser(s, profile, { [verified]: true }, service.howOf(ctx), how.method), how);
		}
		// used up only now: a terms or profile step can be retried with the same code or link
		if (!(await s.store.codes.consume(recordId))) throw problem('code_invalid', 'The code is not valid or has expired.');
		return answer;
	};

	// ----------------------------------------------------------------------------------------- email + password

	/** @param {any} ctx */
	const passwordSignUp = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const email = normaliseEmail(body.email);
		if (!email) throw invalid('email', 'Enter a valid e-mail address.');
		const profile = await signUpProfile(s, body, { email });
		const passwordHash = await newPassword(s, body.password, { who: { name: profile.name, email } });
		const how = service.howOf(ctx);
		const user = await createUser(s, profile, { passwordHash }, how, 'email_password');
		return afterSignUp(s, user, { method: 'email_password', ...how, acceptTerms: body.acceptTerms });
	};

	/** @param {any} ctx */
	const passwordSignIn = async (ctx) => {
		const s = await service.site(ctx);
		const email = normaliseEmail(bodyOf(ctx.body).email);
		const user = email ? await s.store.users.byEmail(email) : null;
		return passwordSignInOf(s, ctx, { method: 'email_password', identifier: email, user });
	};

	// ----------------------------------------------------------------------------------------- phone + password

	/**
	 * Sign up with a phone number and a password (A2; the number is not verified), while the website lets visitors
	 * sign up this way (SA-2: off, only staff give passwords).
	 * @param {any} ctx
	 */
	const phonePasswordSignUp = async (ctx) => {
		const s = await service.site(ctx);
		const { signUp } = await service.settings(s, 'phone_password');
		if (signUp === false) throw problem('sign_up_closed', 'Sign-up with a phone number and a password is closed.');
		const body = bodyOf(ctx.body);
		const phone = await service.phoneOf(s, body.phone);
		if (!phone) throw invalid('phone', 'Enter the phone number with its country code.');
		const profile = await signUpProfile(s, body, { phone });
		const passwordHash = await newPassword(s, body.password, {
			method: 'phone_password',
			who: { name: profile.name, email: profile.email },
		});
		const how = service.howOf(ctx);
		const user = await createUser(s, profile, { passwordHash }, how, 'phone_password');
		return afterSignUp(s, user, { method: 'phone_password', ...how, acceptTerms: body.acceptTerms });
	};

	/** Sign in with a phone number and a password, or a sign-in code from staff (A2, A3). @param {any} ctx */
	const phonePasswordSignIn = async (ctx) => {
		const s = await service.site(ctx);
		const phone = await service.phoneOf(s, bodyOf(ctx.body).phone);
		const user = phone ? await s.store.users.byPhone(phone) : null;
		return passwordSignInOf(s, ctx, { method: 'phone_password', identifier: phone, user });
	};

	/**
	 * Forgot password (A2): a code by SMS or WhatsApp. The answer is the same, at once, whether or not the number has an
	 * account and whatever the send gives (ST-3): the code is made and sent right after it (a cooldown or cap sends
	 * nothing), and a code Notifications cannot send now is sent again on later requests while it is valid.
	 * @param {any} ctx
	 */
	const phoneForgot = async (ctx) => {
		const s = await service.site(ctx);
		const { selfReset } = await service.settings(s, 'phone_password');
		if (selfReset !== 'code') throw problem('self_reset_off', 'Passwords are not reset here: ask the shop.');
		const phone = await service.phoneOf(s, bodyOf(ctx.body).phone);
		if (!phone) throw invalid('phone', 'Enter the phone number with its country code.');
		afterAnswer(ctx, async () => {
			const user = await s.store.users.byPhone(phone);
			if (!user?.passwordHash || user.blocked) return;
			const { channel, codeLength, codeMinutes } = await service.settings(s, 'phone_code');
			await sendCode(s, 'phone_reset', phone, { length: codeLength, minutes: codeMinutes }, (code, _link, expireAt) =>
				service.deliver(s, channel, 'accounts.phone_code', { phone }, { code, minutes: codeMinutes }, expireAt),
			);
		});
		return new Response(null, { status: 202 });
	};

	/** Choose a new password with the code (A2); every device signs in again. @param {any} ctx */
	const phoneReset = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const { selfReset } = await service.settings(s, 'phone_password');
		if (selfReset !== 'code') throw problem('self_reset_off', 'Passwords are not reset here: ask the shop.');
		const phone = await service.phoneOf(s, body.phone);
		const user = phone ? await s.store.users.byPhone(phone) : null;
		if (!phone || !user) throw problem('code_invalid', 'The code is not valid or has expired.');
		const { id: recordId } = await checkCode(s, 'phone_reset', phone, body.code);
		const passwordHash = await newPassword(s, body.password, { method: 'phone_password', who: user });
		if (!(await s.store.codes.consume(recordId))) throw problem('code_invalid', 'The code is not valid or has expired.');
		await s.store.users.update(user.id, {
			passwordHash,
			failedLogins: 0,
			lockedUntil: null,
			lockLevel: 0,
			phoneVerified: true,
		});
		await s.store.sessions.revokeAll(user.id);
		await service.logSignIn(s, user, 'user.password_reset', 'With a code by phone');
		return undefined;
	};

	/**
	 * Forgot password (e-mail): the same answer, at once, whether or not the address has an account and whatever the
	 * send gives (ST-3). The reset link is made and sent right after the answer; a link Notifications cannot send now
	 * is sent again on later requests while it is valid. It goes only to a proven address or to the address the account
	 * was made with: an address typed but never proven on an account that signs in another way (a phone + password
	 * member's) gets nothing, as an unknown one, so its owner cannot take that account over. Requests per address are
	 * limited (`resetLimit` per 15 minutes, ST-12), counted for every address, known or not, so the refusal tells
	 * nothing either.
	 * @param {any} ctx
	 */
	const forgotPassword = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const email = normaliseEmail(body.email);
		if (!email) throw invalid('email', 'Enter a valid e-mail address.');
		const returnTo = returnAddress(body.returnTo, s.domain);
		if (!returnTo) throw invalid('returnTo', 'returnTo must be a page of your website (or a local page while testing).');
		const { resetMinutes, resetLimit } = await service.settings(s, 'email_password');
		if (!(await s.store.counters.take(`resets|${sha256(email)}`, RESET_WINDOW_MS, Number(resetLimit))))
			throw problem('rate_limited', 'Too many reset requests for this address. Try again later.');
		afterAnswer(ctx, async () => {
			const user = await s.store.users.byEmail(email);
			if (!user?.passwordHash || user.blocked || !resetsByEmail(user)) return;
			const secret = randomSecret(32);
			const expireAt = new Date(now() + resetMinutes * 60_000);
			const id = await s.store.codes.add({ kind: 'reset', target: user.id, hash: sha256(secret), expireAt, replace: true });
			await service.deliver(
				s,
				'email',
				'accounts.password_reset',
				{ email },
				{ link: `${returnTo}#${LINK_PARAMS.reset}=${id}.${secret}`, minutes: resetMinutes },
				expireAt,
			);
		});
		return new Response(null, { status: 202 });
	};

	/** @param {any} ctx */
	const resetPassword = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		if (!parseSecret(body.token)) throw problem('code_invalid', 'This reset link is not valid or has expired.');
		const pending = await service.takeSecret(s, body.token, 'reset', { keep: true });
		const owner = pending ? await s.store.users.get(pending.target) : null;
		const passwordHash = await newPassword(s, body.password, { who: owner ?? {} });
		const record = await service.takeSecret(s, body.token, 'reset');
		const user = record ? await s.store.users.get(record.target) : null;
		if (!user) throw problem('code_invalid', 'This reset link is not valid or has expired.');
		await s.store.users.update(user.id, {
			passwordHash,
			failedLogins: 0,
			lockedUntil: null,
			lockLevel: 0,
			emailVerified: true,
		});
		await s.store.sessions.revokeAll(user.id);
		await service.logSignIn(s, user, 'user.password_reset', 'With an e-mail link');
		return undefined;
	};

	// -------------------------------------------------------------------------------------------- phone code

	/** @param {any} ctx */
	const phoneCodeRequest = async (ctx) => {
		const s = await service.site(ctx);
		const phone = await service.phoneOf(s, bodyOf(ctx.body).phone);
		if (!phone) throw invalid('phone', 'Enter the phone number with its country code.');
		const { channel, codeLength, codeMinutes, countries } = await service.settings(s, 'phone_code');
		if (!phoneCountryAllowed(phone, countries))
			throw problem('country_not_allowed', 'Codes go only to numbers of the countries this website serves.');
		await service.allowCode(s, await s.store.users.byPhone(phone), 'phone_code');
		const sent = await sendCode(s, 'phone', phone, { length: codeLength, minutes: codeMinutes }, (code) =>
			service.notify(s, channel, 'accounts.phone_code', { phone }, { code, minutes: codeMinutes }),
		);
		return new Response(JSON.stringify(sent), { status: 202, headers: { 'content-type': 'application/json' } });
	};

	/** @param {any} ctx */
	const phoneCodeSignIn = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const phone = await service.phoneOf(s, body.phone);
		if (!phone) throw invalid('phone', 'Enter the phone number with its country code.');
		return codeSignIn(s, ctx, 'phone', phone, await checkCode(s, 'phone', phone, body.code));
	};

	// --------------------------------------------------------------------------------- e-mail code and magic link

	/** @param {any} ctx */
	const emailCodeRequest = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const email = normaliseEmail(body.email);
		if (!email) throw invalid('email', 'Enter a valid e-mail address.');
		const returnTo = body.returnTo === undefined ? null : returnAddress(body.returnTo, s.domain);
		if (body.returnTo !== undefined && !returnTo)
			throw invalid('returnTo', 'returnTo must be a page of your website (or a local page while testing).');
		const { codeLength, codeMinutes } = await service.settings(s, 'email_code');
		// an address typed on an account but never proven counts as unknown here too: that account's role never shows
		await service.allowCode(s, await provenHolderOf(s, email), 'email_code');
		const sent = await sendCode(
			s,
			'email',
			email,
			{ length: codeLength, minutes: codeMinutes, linkTo: returnTo },
			(code, link) =>
				service.notify(s, 'email', 'accounts.email_code', { email }, { code, link: link ?? '', minutes: codeMinutes }),
		);
		return new Response(JSON.stringify(sent), { status: 202, headers: { 'content-type': 'application/json' } });
	};

	/** @param {any} ctx */
	const emailCodeSignIn = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		if (body.link !== undefined) {
			const record = await service.takeSecret(s, body.link, 'email', { field: 'linkHash', keep: true });
			if (!record) throw problem('code_invalid', 'This link is not valid or has expired.');
			return codeSignIn(s, ctx, 'email', record.target, { id: record.id, staff: false });
		}
		const email = normaliseEmail(body.email);
		if (!email) throw invalid('email', 'Enter a valid e-mail address.');
		return codeSignIn(s, ctx, 'email', email, await checkCode(s, 'email', email, body.code));
	};

	// ------------------------------------------------------------------------------------------- social sign-in

	/** @param {'google' | 'apple' | 'facebook'} provider */
	const callbackUrl = (/** @type {Site} */ s, provider) => `${s.base}/oauth/${provider}/callback`;

	/**
	 * Start a social sign-in: the provider's page to open (the widget navigates there).
	 * @param {'google' | 'apple' | 'facebook'} provider
	 */
	const socialStart = (provider) => async (/** @type {any} */ ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const returnTo = returnAddress(body.returnTo, s.domain);
		if (!returnTo) throw invalid('returnTo', 'returnTo must be a page of your website (or a local page while testing).');
		const key = await product.connections.value(s.websiteId, provider);
		if (typeof key !== 'object' || key === null)
			throw problem('provider_failed', `Connect the ${provider} keys in the product dashboard first.`);
		const how = service.howOf(ctx);
		const state = `${s.websiteId}.${randomSecret(24)}`;
		const nonce = randomSecret(24);
		const verifier = randomSecret(48);
		await s.store.oauth.add({
			state,
			provider,
			data: { returnTo, nonce, verifier, remember: how.remember ? '1' : '', deviceId: how.deviceId ?? '' },
			expireAt: new Date(now() + 10 * 60_000),
		});
		return { url: providers.authorizeUrl(provider, key, { redirectUri: callbackUrl(s, provider), state, nonce, verifier }) };
	};

	/**
	 * The provider sends the person back here (GET; Apple POSTs a form). Accounts finds or creates the user and sends
	 * the browser back to the website with a single-use hand-over code in the fragment, which the widget exchanges.
	 * @param {'google' | 'apple' | 'facebook'} provider
	 */
	const socialCallback = (provider) => async (/** @type {any} */ ctx) => {
		const params = ctx.method === 'POST' ? new URLSearchParams(ctx.rawBody) : ctx.searchParams;
		const state = params.get('state') ?? '';
		const websiteId = state.split('.')[0] ?? '';
		const page = (/** @type {number} */ status, /** @type {string} */ text) =>
			new Response(`<!doctype html><meta charset="utf-8"><title>Accounts</title><p>${text}</p>`, {
				status,
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
			});
		if (!/^web_[0-9a-z]{10,64}$/.test(websiteId)) return page(400, 'This sign-in link is not valid.');
		const serving = await product.serving(websiteId);
		if (!serving.ok || !(await product.featuresOn(websiteId)).includes(provider))
			return page(404, 'Sign-in is not available right now.');
		/** @type {import('@ss/app-kit').WebsiteData} */
		let data;
		try {
			data = await product.data.forWebsite(websiteId, { merchantId: serving.status.merchantId });
		} catch {
			return page(404, 'Sign-in is not available right now.');
		}
		const s = await service.siteOf({
			websiteId,
			merchantId: serving.status.merchantId,
			domain: serving.status.domain,
			base: product.address() ?? new URL(ctx.request.url).origin,
			data,
			ip: String(ctx.clientIp || 'unknown'),
			after: ctx.after,
		});
		const pending = await s.store.oauth.take(state);
		if (!pending || pending.provider !== provider) return page(400, 'This sign-in has expired. Start again.');
		const back = (/** @type {string} */ fragment) =>
			new Response(null, {
				status: 303,
				headers: { location: `${pending.data.returnTo}#${fragment}`, 'cache-control': 'no-store' },
			});
		const code = params.get('code');
		const key = await product.connections.value(websiteId, provider);
		if (!code || typeof key !== 'object' || key === null) return back(`${LINK_PARAMS.error}=cancelled`);
		/** @type {import('../adapters/providers.js').ProviderIdentity | null} */
		let identity = null;
		try {
			identity = await providers.identify(provider, key, {
				code,
				redirectUri: callbackUrl(s, provider),
				nonce: pending.data.nonce,
				verifier: pending.data.verifier,
				...(params.get('user') ? { appleUser: params.get('user') ?? '' } : {}),
			});
		} catch {
			identity = null;
		}
		if (!identity) return back(`${LINK_PARAMS.error}=provider_failed`);
		const email = identity.email ? normaliseEmail(identity.email) : null;
		// the provider proved the address: it links only an account whose address was proven before
		let user = (await s.store.users.byProvider(provider, identity.subject)) ?? (email ? await provenHolderOf(s, email) : null);
		try {
			if (user) {
				user =
					(await s.store.users.update(user.id, {
						[`providers.${provider}`]: identity.subject,
						...(email && user.email === email ? { emailVerified: true } : {}),
					})) ?? user;
			} else {
				const profile = await signUpProfile(s, { name: identity.name }, { ...(email ? { email } : {}), social: true });
				user = await createUser(
					s,
					profile,
					{ emailVerified: Boolean(email), providers: { [provider]: identity.subject } },
					{
						remember: false,
						device: '',
						deviceId: pending.data.deviceId || null,
						network: String(ctx.clientIp || 'unknown'),
					},
					provider,
				);
			}
		} catch (error) {
			const reason = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'failed';
			return back(`${LINK_PARAMS.error}=${encodeURIComponent(reason)}`);
		}
		const secret = randomSecret(32);
		const id = await s.store.codes.add({
			kind: 'handoff',
			target: user.id,
			hash: sha256(secret),
			expireAt: new Date(now() + 5 * 60_000),
			data: { method: provider, remember: pending.data.remember === '1' },
		});
		return back(`${LINK_PARAMS.handoff}=${id}.${secret}`);
	};

	/** The widget exchanges the hand-over code for the sign-in. @param {any} ctx */
	const socialExchange = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const record = await service.takeSecret(s, body.code, 'handoff', { keep: true });
		const user = record ? await s.store.users.get(record.target) : null;
		if (!record || !user) throw problem('code_invalid', 'This sign-in has expired. Start again.');
		if (user.status === 'pending') {
			await s.store.codes.consume(record.id);
			return { status: 'pending' };
		}
		const answer = await service.finish(s, user, {
			method: String(record.data.method),
			remember: record.data.remember === true,
			device: service.howOf(ctx).device,
			acceptTerms: body.acceptTerms,
		});
		await s.store.codes.consume(record.id);
		return answer;
	};

	// ------------------------------------------------------------------------------------------------- two-step

	/**
	 * The second step of a sign-in: a code from the authenticator app or a recovery code, or the first code while the
	 * user sets two-step up. Wrong codes and wrong recovery codes count toward the user's lock like wrong passwords,
	 * and the step is refused while the user is locked (ST-1), so a known password does not give unlimited guesses.
	 * @param {any} ctx
	 */
	const twoStep = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const record = await service.takeSecret(s, body.challenge, 'step', { keep: true });
		const user = record ? await s.store.users.get(record.target) : null;
		if (!record || !user) throw problem('code_invalid', 'This step has expired. Sign in again.');
		if (user.lockedUntil && user.lockedUntil.getTime() > now())
			throw problem('locked', 'Too many wrong tries. Try again later.', {
				extensions: { lockedUntil: user.lockedUntil.toISOString() },
			});
		const how = {
			method: String(record.data.method),
			remember: record.data.remember === true,
			device: String(record.data.device),
		};
		/** @param {{ counted: boolean }} [options] `counted`: a guess at the user's secret (not while setting it up) */
		const wrong = async ({ counted } = { counted: true }) => {
			if ((await s.store.codes.attempt(record.id)) >= CODE_ATTEMPTS) await s.store.codes.consume(record.id);
			if (counted) {
				const failures = await s.store.users.failedLogin(user.id);
				await s.store.users.update(user.id, {
					...lockAfter({ ...(await passwordRules(s, how.method)), failures, now: now() }),
				});
			}
			await service.logSignIn(s, user, 'user.sign_in_failed', 'Wrong two-step code');
			return problem('code_invalid', 'The code is not valid.');
		};
		if (typeof record.data.setup === 'string') {
			// the role requires two-step and the user sets it up now
			const secret = product.sealer.open(record.data.setup, service.totpAad(s.websiteId, user.id));
			const checked = secret ? verifyTotp(secret, body.code, { now: now(), lastStep: null }) : { ok: false };
			// the user holds the new secret already: a wrong first code is no guess
			if (!secret || !checked.ok) throw await wrong({ counted: false });
			const { codes, hashes } = generateRecoveryCodes();
			const updated = await s.store.users.update(user.id, {
				twoStep: {
					sealed: record.data.setup,
					lastStep: /** @type {{ step: number }} */ (checked).step,
					recovery: hashes.map((hash) => ({ hash, format: 'v1' })),
					enabledAt: new Date(now()),
				},
			});
			if (!(await s.store.codes.consume(record.id))) throw problem('code_invalid', 'This step has expired. Sign in again.');
			return service.issue(s, updated ?? user, how, { recoveryCodes: codes });
		}
		const twoStepState = user.twoStep;
		if (!twoStepState?.enabledAt) throw problem('code_invalid', 'This step has expired. Sign in again.');
		if (typeof body.recoveryCode === 'string') {
			const index = matchRecoveryCode(body.recoveryCode, twoStepState.recovery);
			if (index < 0) throw await wrong();
			// each recovery code works once, an imported one too (A8)
			await s.store.users.update(user.id, { 'twoStep.recovery': twoStepState.recovery.filter((_, i) => i !== index) });
			await service.logSignIn(s, user, 'user.recovery_code_used', `${twoStepState.recovery.length - 1} left`);
		} else {
			const secret = product.sealer.open(twoStepState.sealed, service.totpAad(s.websiteId, user.id));
			const checked = secret ? verifyTotp(secret, body.code, { now: now(), lastStep: twoStepState.lastStep }) : { ok: false };
			if (!checked.ok) throw await wrong();
			await s.store.users.update(user.id, { 'twoStep.lastStep': /** @type {{ step: number }} */ (checked).step });
		}
		if (!(await s.store.codes.consume(record.id))) throw problem('code_invalid', 'This step has expired. Sign in again.');
		return service.issue(s, user, how);
	};

	// -------------------------------------------------------------------------------------------------- sessions

	/** The sealing context of a session's current refresh secret. @param {Site} s @param {string} sessionId */
	const refreshAad = (s, sessionId) => `accounts-refresh|${s.websiteId}|${sessionId}`;

	/** Whether a session is still open. @param {SessionRecord | null} session @returns {session is SessionRecord} */
	const live = (session) => session !== null && !session.revokedAt && session.expiresAt.getTime() > now();

	/** Whether a refresh token was rotated away from the session within the grace period. @param {SessionRecord} session @param {string} hash */
	const rotatedLately = (session, hash) =>
		(session.rotated ?? []).some((entry) => entry.at.getTime() > now() - REFRESH_GRACE_MS && safeEqual(entry.hash, hash));

	/**
	 * The session's current refresh secret, for a token rotated away within the grace period; null otherwise.
	 * @param {Site} s @param {SessionRecord} session @param {string} hash
	 */
	const currentSecret = (s, session, hash) => {
		if (!rotatedLately(session, hash)) return null;
		const secret = product.sealer.open(session.sealedRefresh, refreshAad(s, session.id));
		return secret && safeEqual(session.refreshHash, sha256(secret)) ? secret : null;
	};

	/**
	 * Rotate the session's current refresh token; when another renewal with the same token rotated it a moment ago,
	 * the pair that renewal got.
	 * @param {Site} s @param {SessionRecord} session @param {string} hash
	 * @returns {Promise<{ session: SessionRecord | null, secret: string | null }>}
	 */
	const rotateOrJoin = async (s, session, hash) => {
		const next = randomSecret(32);
		if (await s.store.sessions.rotate(session.id, hash, sha256(next), product.sealer.seal(next, refreshAad(s, session.id))))
			return { session, secret: next };
		const again = await s.store.sessions.get(session.id);
		return { session: again, secret: live(again) ? currentSecret(s, again, hash) : null };
	};

	/**
	 * Renew: a new sign-in and a new refresh token. The token renewed less than 30 seconds ago gets the same new pair
	 * (parallel renewals, a retry; RW-1); an older one came back because it was copied, so the session ends.
	 * @param {any} ctx
	 */
	const refresh = async (ctx) => {
		const s = await service.site(ctx);
		const parsed = parseSecret(bodyOf(ctx.body).refreshToken);
		const found = parsed ? await s.store.sessions.get(parsed.id) : null;
		const out = () => problem('signed_out', 'Sign in again.');
		if (!parsed || !live(found)) throw out();
		const hash = sha256(parsed.secret);
		const current = safeEqual(found.refreshHash, hash);
		const lately = current ? null : currentSecret(s, found, hash);
		if (!current && !lately) {
			if (found.previousHashes.includes(hash)) await s.store.sessions.revoke(found.userId, found.id);
			throw out();
		}
		const user = await s.store.users.get(found.userId);
		if (!user || user.blocked || user.status !== 'active') {
			await s.store.sessions.revoke(found.userId, found.id);
			throw out();
		}
		const { session, secret } = current ? await rotateOrJoin(s, found, hash) : { session: found, secret: lately };
		if (!session || !secret) throw out();
		return {
			status: 'signed_in',
			...(await service.signInFor(s, user, session.id)),
			refreshToken: `${session.id}.${secret}`,
			sessionExpiresAt: session.expiresAt.toISOString(),
			remember: session.remember,
			user: selfView(user),
		};
	};

	/** Sign out with the refresh token (or one renewed within the grace period). @param {any} ctx */
	const signOut = async (ctx) => {
		const s = await service.site(ctx);
		const parsed = parseSecret(bodyOf(ctx.body).refreshToken);
		const session = parsed ? await s.store.sessions.get(parsed.id) : null;
		const hash = parsed ? sha256(parsed.secret) : '';
		if (session && (safeEqual(session.refreshHash, hash) || rotatedLately(session, hash)))
			await s.store.sessions.revoke(session.userId, session.id);
		return undefined;
	};

	// ---------------------------------------------------------------------------------------------- setup links

	/**
	 * Accept a setup link (A3, A5): `{ code, password }` sets the password and signs in; an invited role request of the
	 * user is completed. Staff send the link to the user's phone, so using it proves the number (other products then
	 * join the user's guest orders and points to the account); like a reset, every other device signs in again.
	 * @param {any} ctx
	 */
	const acceptSetup = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const record = await service.takeSecret(s, body.code, 'setup', { keep: true });
		const user = record ? await s.store.users.get(record.target) : null;
		if (!record || !user) throw problem('code_invalid', 'This setup link is not valid or has expired.');
		if (user.blocked) throw problem('blocked', 'This account is blocked.');
		const method = service.passwordMethodOf(s, user) ?? (user.phone ? 'phone_password' : 'email_password');
		const passwordHash = await newPassword(s, body.password, { method, who: user });
		if (!(await s.store.codes.consume(record.id)))
			throw problem('code_invalid', 'This setup link is not valid or has expired.');
		const active =
			(await s.store.users.update(user.id, {
				passwordHash,
				failedLogins: 0,
				lockedUntil: null,
				lockLevel: 0,
				...(user.phone ? { phoneVerified: true } : {}),
				...(user.status === 'invited' ? { status: 'active' } : {}),
			})) ?? user;
		await s.store.sessions.revokeAll(user.id);
		const request = await s.store.requests.invitedFor(user.id);
		if (request) await s.store.requests.update(request.id, { status: 'completed', completedAt: new Date(now()) });
		return service.finish(s, active, { method: 'setup_link', ...service.howOf(ctx), acceptTerms: body.acceptTerms });
	};

	// --------------------------------------------------------------------------------------------------- invites

	/** Accept an invite: the account becomes active (with a password when given) and signs in. @param {any} ctx */
	const acceptInvite = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const record = await service.takeSecret(s, body.token, 'invite', { keep: true });
		const user = record ? await s.store.users.get(record.target) : null;
		if (!record || !user || user.status !== 'invited')
			throw problem('code_invalid', 'This invite is not valid or has expired.');
		const name = checkName(body.name);
		if (name === null) throw invalid('name', 'The name is too long.');
		/** @type {Record<string, unknown>} */
		const set = {
			status: 'active',
			...(user.email ? { emailVerified: true } : { phoneVerified: true }),
			...(name ? { name } : {}),
		};
		if (body.password !== undefined && s.on.includes('email_password') && user.email)
			set.passwordHash = await newPassword(s, body.password, { who: { name: name || user.name, email: user.email } });
		else if (body.password !== undefined && s.on.includes('phone_password') && user.phone)
			set.passwordHash = await newPassword(s, body.password, { method: 'phone_password', who: { name: name || user.name } });
		if (!(await s.store.codes.consume(record.id))) throw problem('code_invalid', 'This invite is not valid or has expired.');
		const active = (await s.store.users.update(user.id, set)) ?? user;
		return service.finish(s, active, { method: 'invite', ...service.howOf(ctx), acceptTerms: body.acceptTerms });
	};

	return Object.freeze({
		passwordSignUp,
		passwordSignIn,
		forgotPassword,
		resetPassword,
		phonePasswordSignUp,
		phonePasswordSignIn,
		phoneForgot,
		phoneReset,
		acceptSetup,
		phoneCodeRequest,
		phoneCodeSignIn,
		emailCodeRequest,
		emailCodeSignIn,
		socialStart,
		socialCallback,
		socialExchange,
		twoStep,
		refresh,
		signOut,
		acceptInvite,
		newPassword,
		blankUser,
		createUser,
	});
};

/** @typedef {ReturnType<typeof createFlows>} Flows */
