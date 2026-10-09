/**
 * Sign-up and sign-in (PLAN 0.8.6), one handler per method, plus sessions (renew, sign out), two-step, invites and
 * social sign-ins (start, the provider's callback, the hand-over). Every method ends in `service.finish()`, which runs
 * the blocked, approval, terms and two-step checks before a session starts.
 * @module
 */
import { problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { normaliseEmail, normalisePhone } from '../core/identifiers.js';
import { checkCustomValues, checkName, selfView } from '../core/profile.js';
import { DEFAULT_ROLE } from '../core/roles.js';
import {
	CODE_ATTEMPTS,
	CODE_COOLDOWN_SECONDS,
	CODES_PER_HOUR,
	emailRefused,
	generateCode,
	normaliseCode,
	passwordProblem,
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
	verifyPassword,
	verifyTotp,
} from '../adapters/crypto.js';
import { parseSecret } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/profile.js').UserRecord} UserRecord */

/** @param {unknown} value */
const bodyOf = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {});

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

	/** The phone settings of the website. @param {Site} s */
	const phoneOptions = async (s) => {
		const { defaultCallingCode, trunkPrefix } = await service.settings(s, 'phone_code');
		return { defaultCallingCode: String(defaultCallingCode), trunkPrefix: String(trunkPrefix) };
	};

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
		const phone =
			known.phone ??
			(body.phone === undefined || body.phone === '' ? null : normalisePhone(body.phone, await phoneOptions(s)));
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
				throw problem('risk_refused', 'Too many accounts were made from this network today.');
		}
		return { deviceHash, networkHash };
	};

	/**
	 * Create a user from a sign-up; `pending` when approval is required.
	 * @param {Site} s @param {Awaited<ReturnType<typeof signUpProfile>>} profile @param {Partial<UserRecord>} extra
	 * @param {ReturnType<Service['howOf']>} how
	 */
	const createUser = async (s, profile, extra, how) => {
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
	 * A new password: the rules, then the breached-password list.
	 * @param {Site} s @param {unknown} password
	 */
	const newPassword = async (s, password) => {
		const rules = await service.settings(s, 'email_password');
		const reason = passwordProblem(password, { minLength: rules.minLength });
		if (reason === 'too_short') throw problem('weak_password', `Use at least ${rules.minLength} characters.`);
		if (reason === 'too_long') throw problem('weak_password', 'The password is too long.');
		if (rules.breachedCheck && (await providers.breached(/** @type {string} */ (password))))
			throw problem('weak_password', 'This password appeared in a data breach. Choose another one.');
		return hashPassword(/** @type {string} */ (password));
	};

	/**
	 * A one-time code for an address, sent through Notifications (cooldown and hourly cap are code constants).
	 * @param {Site} s @param {'phone' | 'email'} kind @param {string} target
	 * @param {{ length: number, minutes: number, linkTo?: string | null }} shape
	 * @param {(code: string, link: string | null) => Promise<void>} deliver
	 */
	const sendCode = async (s, kind, target, { length, minutes, linkTo }, deliver) => {
		const latest = await s.store.codes.latest(kind, target);
		if (latest && now() - latest.createdAt.getTime() < CODE_COOLDOWN_SECONDS * 1000)
			throw problem('too_soon', `Wait ${CODE_COOLDOWN_SECONDS} seconds before asking for another code.`);
		if ((await s.store.codes.countSince(kind, target, new Date(now() - 3_600_000))) >= CODES_PER_HOUR)
			throw problem('too_soon', 'Too many codes were asked for. Try again later.');
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
			await deliver(code, link);
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
	 * @param {Site} s @param {'phone' | 'email'} kind @param {string} target @param {unknown} typed
	 * @returns {Promise<string>} the code record's id
	 */
	const checkCode = async (s, kind, target, typed) => {
		const record = await s.store.codes.latest(kind, target);
		const code = record ? normaliseCode(typed, Number(record.data.length)) : null;
		if (!record || code === null) throw problem('code_invalid', 'The code is not valid or has expired.');
		if (!safeEqual(record.hash, sha256(`${record.id}:${code}`))) {
			if ((await s.store.codes.attempt(record.id)) >= CODE_ATTEMPTS) await s.store.codes.consume(record.id);
			throw problem('code_invalid', 'The code is not valid or has expired.');
		}
		return record.id;
	};

	/**
	 * Sign in (or up) the owner of a proven address, then use up the code or link.
	 * @param {Site} s @param {any} ctx @param {'phone' | 'email'} kind @param {string} target @param {string} recordId
	 */
	const codeSignIn = async (s, ctx, kind, target, recordId) => {
		const body = bodyOf(ctx.body);
		const how = {
			method: kind === 'phone' ? 'phone_code' : 'email_code',
			...service.howOf(ctx),
			acceptTerms: body.acceptTerms,
		};
		const verified = kind === 'phone' ? 'phoneVerified' : 'emailVerified';
		const existing = kind === 'phone' ? await s.store.users.byPhone(target) : await s.store.users.byEmail(target);
		/** @type {Record<string, unknown>} */
		let answer;
		if (existing) {
			const user = existing[verified]
				? existing
				: ((await s.store.users.update(existing.id, { [verified]: true })) ?? existing);
			answer = await service.finish(s, user, how);
		} else {
			const profile = await signUpProfile(s, body, kind === 'phone' ? { phone: target } : { email: target });
			answer = await afterSignUp(s, await createUser(s, profile, { [verified]: true }, service.howOf(ctx)), how);
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
		const passwordHash = await newPassword(s, body.password);
		const how = service.howOf(ctx);
		const user = await createUser(s, profile, { passwordHash }, how);
		return afterSignUp(s, user, { method: 'email_password', ...how, acceptTerms: body.acceptTerms });
	};

	/** @param {any} ctx */
	const passwordSignIn = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const email = normaliseEmail(body.email);
		const user = email ? await s.store.users.byEmail(email) : null;
		const failed = () => problem('sign_in_failed', 'The e-mail address or password is wrong.');
		if (!user || !user.passwordHash || typeof body.password !== 'string' || body.password.length > 1024) {
			await dummyPasswordCheck();
			throw failed();
		}
		if (user.lockedUntil && user.lockedUntil.getTime() > now())
			throw problem('locked', 'Too many wrong passwords. Try again later.', {
				extensions: { lockedUntil: user.lockedUntil.toISOString() },
			});
		if (!(await verifyPassword(body.password, user.passwordHash))) {
			const { maxAttempts, lockMinutes } = await service.settings(s, 'email_password');
			if ((await s.store.users.failedLogin(user.id)) >= maxAttempts)
				await s.store.users.update(user.id, { failedLogins: 0, lockedUntil: new Date(now() + lockMinutes * 60_000) });
			throw failed();
		}
		return service.finish(s, user, { method: 'email_password', ...service.howOf(ctx), acceptTerms: body.acceptTerms });
	};

	/** @param {any} ctx */
	const forgotPassword = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const email = normaliseEmail(body.email);
		if (!email) throw invalid('email', 'Enter a valid e-mail address.');
		const returnTo = returnAddress(body.returnTo, s.domain);
		if (!returnTo) throw invalid('returnTo', 'returnTo must be a page of your website (or a local page while testing).');
		const user = await s.store.users.byEmail(email);
		if (user?.passwordHash && !user.blocked) {
			const { resetMinutes } = await service.settings(s, 'email_password');
			const secret = randomSecret(32);
			const id = await s.store.codes.add({
				kind: 'reset',
				target: user.id,
				hash: sha256(secret),
				expireAt: new Date(now() + resetMinutes * 60_000),
				replace: true,
			});
			await service.notify(
				s,
				'email',
				'accounts.password_reset',
				{ email },
				{ link: `${returnTo}#${LINK_PARAMS.reset}=${id}.${secret}`, minutes: resetMinutes },
			);
		}
		// the same answer whether or not the address has an account
		return new Response(null, { status: 202 });
	};

	/** @param {any} ctx */
	const resetPassword = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		if (!parseSecret(body.token)) throw problem('code_invalid', 'This reset link is not valid or has expired.');
		const passwordHash = await newPassword(s, body.password);
		const record = await service.takeSecret(s, body.token, 'reset');
		const user = record ? await s.store.users.get(record.target) : null;
		if (!user) throw problem('code_invalid', 'This reset link is not valid or has expired.');
		await s.store.users.update(user.id, { passwordHash, failedLogins: 0, lockedUntil: null, emailVerified: true });
		await s.store.sessions.revokeAll(user.id);
		return undefined;
	};

	// -------------------------------------------------------------------------------------------- phone code

	/** @param {any} ctx */
	const phoneCodeRequest = async (ctx) => {
		const s = await service.site(ctx);
		const options = await phoneOptions(s);
		const phone = normalisePhone(bodyOf(ctx.body).phone, options);
		if (!phone) throw invalid('phone', 'Enter the phone number with its country code.');
		const { channel, codeLength, codeMinutes } = await service.settings(s, 'phone_code');
		const sent = await sendCode(s, 'phone', phone, { length: codeLength, minutes: codeMinutes }, (code) =>
			service.notify(s, channel, 'accounts.phone_code', { phone }, { code, minutes: codeMinutes }),
		);
		return new Response(JSON.stringify(sent), { status: 202, headers: { 'content-type': 'application/json' } });
	};

	/** @param {any} ctx */
	const phoneCodeSignIn = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const phone = normalisePhone(body.phone, await phoneOptions(s));
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
			return codeSignIn(s, ctx, 'email', record.target, record.id);
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
		let user =
			(await s.store.users.byProvider(provider, identity.subject)) ?? (email ? await s.store.users.byEmail(email) : null);
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
						network: ctx.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
					},
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

	/** @param {any} ctx */
	const twoStep = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const record = await service.takeSecret(s, body.challenge, 'step', { keep: true });
		const user = record ? await s.store.users.get(record.target) : null;
		if (!record || !user) throw problem('code_invalid', 'This step has expired. Sign in again.');
		const how = {
			method: String(record.data.method),
			remember: record.data.remember === true,
			device: String(record.data.device),
		};
		const wrong = async () => {
			if ((await s.store.codes.attempt(record.id)) >= CODE_ATTEMPTS) await s.store.codes.consume(record.id);
			return problem('code_invalid', 'The code is not valid.');
		};
		if (typeof record.data.setup === 'string') {
			// the role requires two-step and the user sets it up now
			const secret = product.sealer.open(record.data.setup, service.totpAad(s.websiteId, user.id));
			const checked = secret ? verifyTotp(secret, body.code, { now: now(), lastStep: null }) : { ok: false };
			if (!secret || !checked.ok) throw await wrong();
			const { codes, hashes } = generateRecoveryCodes();
			const updated = await s.store.users.update(user.id, {
				twoStep: {
					sealed: record.data.setup,
					lastStep: /** @type {{ step: number }} */ (checked).step,
					recovery: hashes,
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
			await s.store.users.update(user.id, { 'twoStep.recovery': twoStepState.recovery.filter((_, i) => i !== index) });
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

	/** Renew: a new sign-in and a new refresh token; an old refresh token ends the session. @param {any} ctx */
	const refresh = async (ctx) => {
		const s = await service.site(ctx);
		const parsed = parseSecret(bodyOf(ctx.body).refreshToken);
		const session = parsed ? await s.store.sessions.get(parsed.id) : null;
		const out = () => problem('signed_out', 'Sign in again.');
		if (!parsed || !session || session.revokedAt || session.expiresAt.getTime() <= now()) throw out();
		const hash = sha256(parsed.secret);
		if (!safeEqual(session.refreshHash, hash)) {
			// an old token came back: it was copied, so the session ends
			if (session.previousHashes.includes(hash)) await s.store.sessions.revoke(session.userId, session.id);
			throw out();
		}
		const user = await s.store.users.get(session.userId);
		if (!user || user.blocked || user.status !== 'active') {
			await s.store.sessions.revoke(session.userId, session.id);
			throw out();
		}
		const secret = randomSecret(32);
		if (!(await s.store.sessions.rotate(session.id, hash, sha256(secret)))) throw out();
		return {
			status: 'signed_in',
			...(await service.signInFor(s, user, session.id)),
			refreshToken: `${session.id}.${secret}`,
			sessionExpiresAt: session.expiresAt.toISOString(),
			remember: session.remember,
			user: selfView(user),
		};
	};

	/** @param {any} ctx */
	const signOut = async (ctx) => {
		const s = await service.site(ctx);
		const parsed = parseSecret(bodyOf(ctx.body).refreshToken);
		const session = parsed ? await s.store.sessions.get(parsed.id) : null;
		if (parsed && session && safeEqual(session.refreshHash, sha256(parsed.secret)))
			await s.store.sessions.revoke(session.userId, session.id);
		return undefined;
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
			set.passwordHash = await newPassword(s, body.password);
		if (!(await s.store.codes.consume(record.id))) throw problem('code_invalid', 'This invite is not valid or has expired.');
		const active = (await s.store.users.update(user.id, set)) ?? user;
		return service.finish(s, active, { method: 'invite', ...service.howOf(ctx), acceptTerms: body.acceptTerms });
	};

	return Object.freeze({
		passwordSignUp,
		passwordSignIn,
		forgotPassword,
		resetPassword,
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
	});
};

/** @typedef {ReturnType<typeof createFlows>} Flows */
