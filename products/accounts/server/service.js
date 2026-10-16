/**
 * The machinery behind Accounts' routes (PLAN 0.8.6):
 *
 * - `site(ctx)`: the website of a request (its merchant database store and switched-on features); right after the
 *   answer it erases users whose deletion is due and retries erasures other products have not confirmed (no
 *   background work).
 * - Sign-ins: the website's Ed25519 key (made on first use, sealed in the merchant database), sign-ins of 15 minutes
 *   (`iss` = Accounts' address, `aud` = the website id), sessions with a rotating refresh token whose reuse ends the
 *   session (after a 30-second grace for parallel renewals), and `finish()`: blocked, approval, consents and two-step
 *   checks after the first step of any method.
 * - Messages through Notifications (pasted token): a Forgot password message that cannot go now is kept and sent
 *   again right after later requests; the data-rights fan-out to every connected product and the export.
 * @module
 */
import { problem, verifyIdentityToken } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { normalizePhone, websiteCallingCode } from '@ss/contracts/phone';
import { constantTimeEqual, randomToken, sha256Hex } from '@ss/protocol';
import { labelOf, valuesOf } from '../core/activity.js';
import { ROLE_TEMPLATES, SIGN_UP_TEMPLATE, remembered, sessionEnd, signInRefusal } from '../core/roles.js';
import { answerConsents, consentsToAsk } from '../core/consents.js';
import { checkAddresses, selfView } from '../core/profile.js';
import { OPEN_SIGN_UP, deviceIdOf, deviceOf } from '../core/rules.js';
import { OTHER_PRODUCTS, SIGN_IN_HEADER, SIGN_IN_METHODS, SIGN_IN_SECONDS } from '../core/widgets.js';
import {
	keyAadOf,
	outboxAadOf,
	totpAadOf,
	dummyPasswordCheck,
	generateSigningKey,
	generateTotpSecret,
	hashPassword,
	isImportedHash,
	signJwt,
	totpUri,
	verifyPassword,
} from '../adapters/crypto.js';
import { createStore } from '../adapters/store.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('../core/profile.js').UserRecord} UserRecord */
/** @typedef {import('../adapters/store.js').Store} Store */
/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {string | null} merchantId
 * @property {Store} store
 * @property {string[]} on switched-on features
 * @property {string} domain
 * @property {string} base Accounts' address (the issuer)
 * @property {string} ip the visitor's address (`unknown` without one)
 * @property {((task: () => Promise<unknown>) => void) | null} after work right after the answer (the activity log)
 */

/** The visitor's browser on a sign-in from the merchant's server (A12; the device list names it). */
const VISITOR_AGENT_HEADER = 'ss-visitor-agent';
/** Time a two-step step or a social hand-over stays open. */
const STEP_MS = 10 * 60_000;
/** Data exports are single-use links valid for 15 minutes (PLAN 0.4.11). */
const EXPORT_MS = 15 * 60_000;
/** Erasures handled right after one request (code constant). */
const ERASURES_PER_REQUEST = 3;
/** Kept messages tried again right after one request (code constant). */
const MESSAGES_PER_REQUEST = 3;
/** Who erases a user whose deletion came due without approval (Data rights, after the days set in Settings). */
const DELETION_DUE = Object.freeze({ kind: 'system', id: 'deletion-due', name: 'Data rights' });

/**
 * A single-use secret as the user gets it (`<record id>.<secret>`) and its parts.
 * @param {unknown} value
 * @returns {{ id: string, secret: string } | null}
 */
export const parseSecret = (value) => {
	if (typeof value !== 'string' || value.length > 200) return null;
	const [id, secret, extra] = value.split('.');
	return id && secret && extra === undefined && /^[a-z]{3}_[0-9a-z]{26}$/.test(id) && /^[A-Za-z0-9_-]{32,}$/.test(secret)
		? { id, secret }
		: null;
};

/** @param {unknown} value */
export const bodyOf = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {});

/** Whether an error is a message Notifications did not send (refused, failed, or not connected). @param {unknown} error */
const unsent = (error) =>
	['not_sent', 'notifications_not_connected'].includes(String(/** @type {{ code?: unknown } | null} */ (error)?.code));

/** The sealing context of a kept message. */
const outboxAad = outboxAadOf;

/**
 * @param {Product} product
 */
export const createService = (product) => {
	const { now, sealer } = product;
	/** @type {Map<string, { key: Record<string, string>, publicJwk: Record<string, string> }>} */
	const keyCache = new Map();

	const keyAad = keyAadOf;
	const totpAad = totpAadOf;

	/**
	 * The website's signing key: made on first use; made again when it no longer opens (ENCRYPTION_KEY changed).
	 * @param {Site} s
	 */
	const signingKey = async (s) => {
		const cached = keyCache.get(s.websiteId);
		if (cached) return cached;
		const stored = await s.store.keys.get();
		const opened = stored ? sealer.open(stored.sealed, keyAad(s.websiteId, stored.kid)) : null;
		/** @type {{ key: Record<string, string>, publicJwk: Record<string, string> }} */
		let entry;
		if (stored && opened) entry = { key: JSON.parse(opened), publicJwk: stored.publicJwk };
		else {
			const kid = `acc-${randomToken(9)}`;
			const { privateJwk, publicJwk } = generateSigningKey(kid);
			const record = { kid, sealed: sealer.seal(JSON.stringify(privateJwk), keyAad(s.websiteId, kid)), publicJwk };
			if (stored) await s.store.keys.replace(record);
			const kept = stored ? record : await s.store.keys.put(record);
			const keptOpened = sealer.open(kept.sealed, keyAad(s.websiteId, kept.kid));
			entry = { key: keptOpened ? JSON.parse(keptOpened) : privateJwk, publicJwk: kept.publicJwk };
		}
		keyCache.set(s.websiteId, entry);
		return entry;
	};

	/**
	 * The website of a request. Due erasures and unconfirmed fan-outs are handled right after the answer.
	 * @param {any} ctx a website route's context (browser, server or ticket)
	 * @returns {Promise<Site>}
	 */
	const site = async (ctx) => {
		const s = await siteOf({
			websiteId: ctx.websiteId,
			merchantId: ctx.merchantId,
			domain: ctx.status?.domain ?? '',
			base: product.address() ?? new URL(ctx.request.url).origin,
			data: await ctx.data(),
			ip: String(ctx.clientIp || 'unknown'),
			after: ctx.after,
		});
		ctx.after(() => afterWork(s));
		return s;
	};

	/**
	 * @param {{ websiteId: string, merchantId: string | null, domain: string, base: string, data: import('@ss/app-kit').WebsiteData,
	 *   ip?: string, after?: Site['after'] }} input
	 * @returns {Promise<Site>}
	 */
	const siteOf = async ({ websiteId, merchantId, domain, base, data, ip = 'unknown', after = null }) => ({
		websiteId,
		merchantId,
		store: createStore(data, { now }),
		on: await product.featuresOn(websiteId),
		domain,
		base,
		ip,
		after,
	});

	/** @param {Site} s @param {string} feature */
	const settings = (s, feature) => product.settings.values(s.websiteId, feature);

	/** The website's sign-up rules (open without the Approval / invite sign-up feature). @param {Site} s */
	const signUpRules = async (s) =>
		s.on.includes('approval')
			? /** @type {import('../core/rules.js').SignUpRules} */ (/** @type {unknown} */ (await settings(s, 'approval')))
			: OPEN_SIGN_UP;

	/**
	 * A phone number as typed, in E.164 with the website's phone format (shared by Phone code and Phone + password; the
	 * default calling code is the setting's, else the business.json country's), or null.
	 * @param {Site} s @param {unknown} value
	 */
	const phoneOf = async (s, value) => {
		const { defaultCallingCode, trunkPrefix } = await settings(s, 'phone');
		const code =
			websiteCallingCode(defaultCallingCode) || websiteCallingCode('', (await product.business(s.websiteId)).country);
		return normalizePhone(value, { defaultCallingCode: code, trunkPrefix: String(trunkPrefix) });
	};

	/**
	 * The role for new sign-ups (A4): the one the merchant chose, else the Customer template (also while no role was
	 * ever saved, for example a website whose roles were all imported without the choice).
	 * @param {Site} s
	 * @returns {Promise<import('../core/roles.js').Role>}
	 */
	const signUpRole = async (s) =>
		(await s.store.roles.signUp()) ??
		/** @type {import('../core/roles.js').Role} */ (ROLE_TEMPLATES.find((role) => role.key === SIGN_UP_TEMPLATE));

	/** The user's role (the sign-up role when theirs is gone). @param {Site} s @param {UserRecord} user */
	const roleOf = async (s, user) => (await s.store.roles.get(user.role)) ?? (await signUpRole(s));

	// ------------------------------------------------------------------------------------------------- sign-ins

	/**
	 * A sign-in (15 minutes) for a user's session.
	 * @param {Site} s @param {UserRecord} user @param {string} sessionId
	 */
	const signInFor = async (s, user, sessionId) => {
		const { key } = await signingKey(s);
		const iat = Math.floor(now() / 1000);
		const role = s.on.includes('roles') ? await roleOf(s, user) : null;
		const claims = {
			iss: s.base,
			aud: s.websiteId,
			sub: user.id,
			sid: sessionId,
			iat,
			exp: iat + SIGN_IN_SECONDS,
			...(user.name ? { name: user.name } : {}),
			...(user.email ? { email: user.email, email_verified: user.emailVerified } : {}),
			...(user.phone ? { phone: user.phone, phone_verified: user.phoneVerified } : {}),
			...(role ? { role: role.key, permissions: role.permissions } : {}),
		};
		return { signIn: signJwt(key, claims), expiresAt: new Date((iat + SIGN_IN_SECONDS) * 1000).toISOString() };
	};

	/**
	 * Start a session and answer the sign-in.
	 * @param {Site} s @param {UserRecord} user
	 * @param {{ method: string, remember: boolean, device: { browser: string, system: string } }} how
	 * @param {Record<string, unknown>} [extra] more members of the answer (recovery codes)
	 */
	const issue = async (s, user, { method, remember: asked, device }, extra = {}) => {
		const stored = await roleOf(s, user);
		// the role's "remember me" applies while Roles and permissions is on (A6, A14): `always` remembers whatever the box
		// said; `never` never remembers (the session ends with the browser, within the role's longer length)
		const role = s.on.includes('roles') ? stored : { ...stored, remember: /** @type {const} */ ('ask') };
		const remember = remembered(role, asked);
		const secret = randomToken(32);
		const expiresAt = new Date(sessionEnd({ now: now(), remember, role }));
		const session = await s.store.sessions.create({
			userId: user.id,
			refreshHash: sha256Hex(secret),
			previousHashes: [],
			method,
			device,
			remember,
			expiresAt,
			lastUsedAt: new Date(now()),
			revokedAt: null,
		});
		const fresh =
			(await s.store.users.update(user.id, {
				lastSignInAt: new Date(now()),
				failedLogins: 0,
				lockedUntil: null,
				lockLevel: 0,
			})) ?? user;
		await logSignIn(s, fresh, 'user.signed_in', { method });
		return {
			status: /** @type {const} */ ('signed_in'),
			...(await signInFor(s, fresh, session.id)),
			refreshToken: `${session.id}.${secret}`,
			sessionExpiresAt: expiresAt.toISOString(),
			remember,
			user: selfView(fresh, await s.store.fields.list()),
			...extra,
		};
	};

	/**
	 * The consents a user's answers give (A2): the answers sent are recorded in each consent's current version; with
	 * `ask`, every required agreement must then be given in its current version, else 403 consent_required lists those
	 * still asked ({ key, label, url, version }).
	 * @param {Site} s @param {Record<string, import('../core/consents.js').ConsentAnswer>} given what the user gave so far
	 * @param {unknown} answers `{ [key]: true | false }` @param {{ ask: boolean }} options
	 */
	const consentsFor = async (s, given, answers, { ask }) => {
		const list = await s.store.consents.list();
		const recorded = answerConsents(list, given, answers, new Date(now()));
		if (!recorded.ok)
			throw problem('validation_failed', recorded.message, {
				errors: [{ path: `/${recorded.field}`, message: recorded.message, code: 'invalid' }],
			});
		const missing = ask ? consentsToAsk(list, recorded.value) : [];
		if (missing.length > 0)
			throw problem('consent_required', 'Accept the required consents to continue.', {
				extensions: { consents: missing.map(({ key, label, url, version }) => ({ key, label, url, version })) },
			});
		return recorded.value;
	};

	/**
	 * After the first step of any method: blocked, waiting for approval, consents, then two-step; else the session.
	 * @param {Site} s @param {UserRecord} user
	 * @param {{ method: string, remember: boolean, device: { browser: string, system: string }, consents?: unknown }} how
	 */
	const finish = async (s, user, how) => {
		if (user.blocked) throw problem('blocked', 'This account is blocked.');
		if (user.status === 'pending') throw problem('pending_approval', 'This account is waiting for approval.');
		await allowSignIn(s, await roleOf(s, user), how.method);
		let current = user;
		if (s.on.includes('consents')) {
			const given = current.consents ?? {};
			const next = await consentsFor(s, given, how.consents, { ask: true });
			if (JSON.stringify(next) !== JSON.stringify(given))
				current = (await s.store.users.update(current.id, { consents: next })) ?? current;
		}
		if (s.on.includes('two_step')) {
			const role = await roleOf(s, current);
			const data = { userId: current.id, method: how.method, remember: how.remember, device: how.device };
			if (current.twoStep?.enabledAt) {
				const challenge = await step(s, current.id, data);
				return { status: /** @type {const} */ ('two_step'), ...challenge };
			}
			if (role.twoStep === 'required') {
				const secret = generateTotpSecret();
				const challenge = await step(s, current.id, {
					...data,
					setup: sealer.seal(secret, totpAad(s.websiteId, current.id)),
				});
				const business = (await product.business(s.websiteId)).name;
				return {
					status: /** @type {const} */ ('two_step_setup'),
					...challenge,
					secret,
					otpauthUrl: totpUri({ secret, issuer: business, account: current.email ?? current.phone ?? current.id }),
				};
			}
		}
		return issue(s, current, how);
	};

	/**
	 * Refuse a sign-in the role does not allow (A6, while Roles and permissions is on): its sign-in is paused, or the
	 * method is not one of its methods. Runs before any code is sent and after the first step of every method.
	 * @param {Site} s @param {import('../core/roles.js').Role} role @param {string} method
	 */
	const allowSignIn = async (s, role, method) => {
		if (!s.on.includes('roles')) return;
		const refusal = signInRefusal(role, method);
		if (refusal === 'sign_in_paused') throw problem('sign_in_paused', await pausedText(s));
		if (refusal === 'method_refused') throw problem('method_refused', 'This account signs in another way.');
	};

	/** The paused text the merchant set (the refusal's detail, so their own screens can show it). @param {Site} s */
	const pausedText = async (s) => String((await product.settings.texts(s.websiteId))['signIn.paused']);

	/**
	 * The role of the address a code goes to, before it is sent (A6): its user's role, or the role for new sign-ups.
	 * @param {Site} s @param {UserRecord | null} user @param {string} method
	 */
	const allowCode = async (s, user, method) => {
		if (!s.on.includes('roles')) return;
		const role = user ? await roleOf(s, user) : await signUpRole(s);
		await allowSignIn(s, role, method);
	};

	/**
	 * A sign-in event in the activity log (A10), when the user's role logs them: who, what, and the visitor's address
	 * (`ip`) with the event's own values (A8).
	 * @param {Site} s @param {UserRecord} user @param {string} action
	 * @param {Record<string, string | number>} [more]
	 */
	const logSignIn = async (s, user, action, more = {}) => {
		if (!s.on.includes('roles') || !s.after) return;
		const role = await roleOf(s, user);
		if (!role.logSignIns) return;
		await product.activity.record(
			{ websiteId: s.websiteId, merchantId: s.merchantId, after: s.after },
			{
				actor: { kind: 'user', id: user.id, ...(user.name ? { name: user.name } : {}), role: role.key },
				action,
				target: user.id,
				label: labelOf(user.name || user.email || user.phone),
				values: valuesOf({ ip: s.ip, ...more }),
			},
		);
	};

	/**
	 * A two-step step (10 minutes): the challenge the widget sends back with the code.
	 * @param {Site} s @param {string} userId @param {Record<string, unknown>} data
	 */
	const step = async (s, userId, data) => {
		const secret = randomToken(32);
		const expireAt = new Date(now() + STEP_MS);
		const id = await s.store.codes.add({ kind: 'step', target: userId, hash: sha256Hex(secret), expireAt, data });
		return { challenge: `${id}.${secret}`, expiresAt: expireAt.toISOString() };
	};

	/**
	 * Take a single-use record by its secret (`<id>.<secret>`), of one kind; null when unknown, used or expired.
	 * @param {Site} s @param {unknown} value @param {import('../adapters/store.js').CodeRecord['kind']} kind
	 * @param {{ field?: 'hash' | 'linkHash', keep?: boolean }} [options] `keep`: do not use it up yet
	 */
	const takeSecret = async (s, value, kind, { field = 'hash', keep = false } = {}) => {
		const parsed = parseSecret(value);
		if (!parsed) return null;
		const record = await s.store.codes.get(parsed.id);
		const stored = field === 'hash' ? record?.hash : record?.data?.linkHash;
		if (!record || record.kind !== kind || typeof stored !== 'string' || !constantTimeEqual(stored, sha256Hex(parsed.secret)))
			return null;
		if (!keep && !(await s.store.codes.consume(record.id))) return null;
		return record;
	};

	/**
	 * How the request's device signs in: remember me, the device name, the device id and the network for risk checks.
	 * The network is the kit's visitor address (`SS-Visitor-IP` on a visitor call from the merchant's server, else the
	 * first `X-Forwarded-For` address; PLAN 0.8.10 K3).
	 * @param {any} ctx
	 */
	const howOf = (ctx) => {
		const body = bodyOf(ctx.body);
		return {
			remember: body.remember === true,
			// on a visitor call from the merchant's server, the visitor's browser comes in SS-Visitor-Agent (A12)
			device: deviceOf((ctx.visitor?.server ? ctx.headers.get(VISITOR_AGENT_HEADER) : null) ?? ctx.headers.get('user-agent')),
			deviceId: deviceIdOf(body.deviceId),
			network: String(ctx.clientIp || 'unknown'),
		};
	};

	/**
	 * The signed-in user of a visitor request (`SS-Sign-In` header): a sign-in of this website whose session is still
	 * open and whose user is not blocked.
	 * @param {any} ctx
	 */
	const signedIn = async (ctx) => {
		const s = await site(ctx);
		const { publicJwk } = await signingKey(s);
		const checked = verifyIdentityToken(
			ctx.headers.get(SIGN_IN_HEADER),
			{ issuer: s.base, jwks: [publicJwk], audience: s.websiteId },
			{ now },
		);
		const sid = checked.ok ? checked.identity.claims.sid : undefined;
		if (!checked.ok || typeof sid !== 'string') throw problem('signed_out', 'Sign in again.');
		const session = await s.store.sessions.get(sid);
		const user = await s.store.users.get(checked.identity.subject);
		if (!session || session.revokedAt || session.expiresAt.getTime() <= now() || !user || user.blocked)
			throw problem('signed_out', 'Sign in again.');
		return { s, user, session };
	};

	/**
	 * Check a user's password (PLAN 0.8.10 A1): Accounts' own scrypt hash, or an imported bcrypt or peppered PBKDF2
	 * hash (the pepper from the `imported_password_pepper` connection), which is replaced with scrypt after a good
	 * check. A user without a password takes as long as a real check.
	 * @param {Site} s @param {UserRecord} user @param {string} password
	 */
	const checkPassword = async (s, user, password) => {
		const stored = user.passwordHash;
		if (!stored) return dummyPasswordCheck();
		const pepper = stored.startsWith('pbkdf2$')
			? await product.connections.value(s.websiteId, 'imported_password_pepper')
			: null;
		const ok = await verifyPassword(password, stored, { pepper: typeof pepper === 'string' ? pepper : null });
		if (ok && isImportedHash(stored)) await s.store.users.update(user.id, { passwordHash: await hashPassword(password) });
		return ok;
	};

	/**
	 * The password method of a user (A2): Email + password for a user with an email address while it is on, else
	 * Phone + password for a user with a phone number while it is on; null when neither fits.
	 * @param {Site} s @param {Pick<UserRecord, 'email' | 'phone'>} user
	 * @returns {'email_password' | 'phone_password' | null}
	 */
	const passwordMethodOf = (s, user) => {
		if (user.email && s.on.includes('email_password')) return 'email_password';
		if (user.phone && s.on.includes('phone_password')) return 'phone_password';
		return null;
	};

	/**
	 * A user's whole address list, checked with the website's Profile settings (A11).
	 * @param {Site} s @param {unknown} input @param {Pick<UserRecord, 'addresses'> | null} user null for a new user
	 */
	const addressesOf = async (s, input, user) => {
		const { maxAddresses, keepOneAddress, addressRequired } = await settings(s, 'profile');
		const checked = checkAddresses(input, () => createId('adr'), {
			max: Number(maxAddresses),
			required: /** @type {string[]} */ (addressRequired),
			keepOne: keepOneAddress === true,
			before: user?.addresses.length ?? 0,
			// an address without a country is in the business.json country, whose format it follows (A1)
			country: (await product.business(s.websiteId)).country ?? '',
		});
		if (!checked.ok)
			throw problem('validation_failed', checked.message, {
				errors: [{ path: `/${checked.field}`, message: checked.message, code: 'invalid' }],
			});
		return checked.value;
	};

	/** Whether any sign-in method is on. @param {Site} s */
	const anyMethod = (s) => SIGN_IN_METHODS.some((key) => s.on.includes(key));

	// ------------------------------------------------------------------------------------------------- messages

	/**
	 * Send a message through Notifications with the pasted token.
	 * @param {Site} s @param {'email' | 'sms' | 'whatsapp'} channel @param {string} template
	 * @param {{ email?: string, phone?: string }} to @param {Record<string, string | number>} values
	 */
	const notify = async (s, channel, template, to, values) => {
		const business = (await product.business(s.websiteId)).name;
		const answer = await product.callProduct(s.websiteId, 'notifications', `/v1/messages/${channel}`, {
			method: 'POST',
			body: { template, to, values: { ...values, business } },
		});
		if (!answer.ok && answer.reason === 'not_connected')
			throw problem('notifications_not_connected', 'Notifications not connected: paste its token in Connections.');
		const status = answer.ok ? bodyOf(answer.body).status : null;
		if (!answer.ok || status === 'failed' || status === 'skipped')
			throw problem('not_sent', 'The message could not be sent. Try again later.');
	};

	/**
	 * Send a message the person waits for without seeing the answer (Forgot password): when Notifications cannot send
	 * it now, it is kept (its values sealed) until `until` and sent again right after later requests for this website;
	 * a newer message of the same template to the same address replaces it. A failed send never throws.
	 * @param {Site} s @param {'email' | 'sms' | 'whatsapp'} channel @param {string} template
	 * @param {{ email?: string, phone?: string }} to @param {Record<string, string | number>} values @param {Date} until
	 */
	const deliver = async (s, channel, template, to, values, until) => {
		const key = `${template}|${to.email ?? to.phone ?? ''}`;
		try {
			await notify(s, channel, template, to, values);
		} catch (error) {
			if (!unsent(error)) throw error;
			const sealed = sealer.seal(JSON.stringify(values), outboxAad(s.websiteId, key));
			await s.store.outbox.keep({ key, channel, template, to, sealed, expireAt: until });
			return;
		}
		await s.store.outbox.remove(key);
	};

	/** Send kept messages again, those expiring first first; stops at the first that still cannot go. @param {Site} s */
	const resend = async (s) => {
		for (const entry of await s.store.outbox.pending(MESSAGES_PER_REQUEST)) {
			const values = sealer.open(entry.sealed, outboxAad(s.websiteId, entry.key));
			if (values)
				try {
					await notify(s, entry.channel, entry.template, entry.to, JSON.parse(values));
				} catch (error) {
					if (unsent(error)) return;
					throw error;
				}
			await s.store.outbox.sent(entry.id);
		}
	};

	// ---------------------------------------------------------------------------------------------- data rights

	/** The other products whose token is pasted for this website. @param {string} websiteId */
	const connectedProducts = async (websiteId) => {
		/** @type {string[]} */
		const out = [];
		for (const id of OTHER_PRODUCTS) if ((await product.connections.value(websiteId, id)) !== null) out.push(id);
		return out;
	};

	/** @param {{ id: string, email: string | null, phone: string | null }} user */
	const rightsUser = (user) => ({
		id: user.id,
		...(user.email ? { email: user.email } : {}),
		...(user.phone ? { phone: user.phone } : {}),
	});

	/**
	 * Ask products to erase a user; returns the products that did not confirm.
	 * @param {Site} s @param {{ id: string, email: string | null, phone: string | null }} user @param {string[]} products
	 */
	const fanOutDelete = async (s, user, products) => {
		/** @type {string[]} */
		const pending = [];
		for (const id of products) {
			const answer = await product.callProduct(s.websiteId, id, '/v1/data-rights/delete', {
				method: 'POST',
				body: { user: rightsUser(user) },
			});
			if (!answer.ok && answer.reason !== 'not_connected') pending.push(id);
		}
		return pending;
	};

	/**
	 * Remove a user from Accounts only: their sessions, codes, kept messages and the user; no other product is asked.
	 * @param {Site} s @param {UserRecord} user
	 */
	const removeHere = async (s, user) => {
		await s.store.sessions.removeAll(user.id);
		for (const target of [user.id, user.email, user.phone]) if (target) await s.store.codes.removeTarget(target);
		await s.store.codes.removeSetupTraces(user.id);
		await s.store.outbox.removeTo(user);
		await s.store.users.remove(user.id);
	};

	/**
	 * Complete a role request (A5): its user set a password with its setup link, or already had one. When its role is
	 * given at completion (the request's invite says so; for a request invited before that was kept, the website's
	 * `giveRoleAt`), the user gets the role now, if it still exists and they do not hold it yet.
	 * @param {Site} s @param {import('../adapters/store.js').RequestRecord} request @param {UserRecord} user
	 * @returns {Promise<{ user: UserRecord, request: import('../adapters/store.js').RequestRecord }>}
	 */
	const completeRequest = async (s, request, user) => {
		const at = request.grant?.at ?? (await settings(s, 'role_requests')).giveRoleAt;
		const give = at === 'completion' && user.role !== request.role && (await s.store.roles.get(request.role)) !== null;
		const current = give ? ((await s.store.users.update(user.id, { role: request.role })) ?? user) : user;
		const completed = await s.store.requests.update(request.id, { status: 'completed', completedAt: new Date(now()) });
		return { user: current, request: completed ?? request };
	};

	/**
	 * Erase a user here and in every connected product (PLAN 0.8.6): products that do not confirm are asked again
	 * right after later requests for this website.
	 * @param {Site} s @param {UserRecord} user @param {import('@ss/app-kit').Actor} actor
	 * @param {any} [ctx] the request (for the activity log)
	 * @param {Record<string, string>} [why] the activity log's values: `by` (staff, request or due) and the staff's reason
	 */
	const erase = async (s, user, actor, ctx, why) => {
		const pending = await fanOutDelete(s, user, await connectedProducts(s.websiteId));
		await removeHere(s, user);
		if (pending.length > 0) await s.store.deletions.add({ userId: user.id, email: user.email, phone: user.phone, pending });
		if (ctx)
			await product.activity.record(
				{ websiteId: s.websiteId, merchantId: s.merchantId, after: ctx.after },
				{
					actor,
					action: 'user.deleted',
					target: user.id,
					label: labelOf(user.name),
					values: valuesOf({ ...why, notConfirmedBy: pending.join(',') }),
				},
			);
		return { pending };
	};

	/**
	 * Right after a request: due erasures, then erasures some products have not confirmed, then kept messages.
	 * @param {Site} s
	 */
	const afterWork = async (s) => {
		if (s.on.includes('data_rights'))
			for (const user of await s.store.users.deletionsDue(ERASURES_PER_REQUEST)) await erase(s, user, DELETION_DUE);
		for (const entry of await s.store.deletions.pending(ERASURES_PER_REQUEST)) {
			const still = await fanOutDelete(s, { id: entry.userId, email: entry.email, phone: entry.phone }, entry.pending);
			await s.store.deletions.update(entry.userId, still);
		}
		await resend(s);
	};

	/**
	 * The user's data from Accounts and every connected product, kept for one download (15 minutes).
	 * @param {Site} s @param {any} ctx @param {UserRecord} user
	 */
	const exportFor = async (s, ctx, user) => {
		const sessions = await s.store.sessions.ofUser(user.id);
		/** @type {Record<string, unknown>} */
		const records = {
			accounts: {
				user: selfView(user, await s.store.fields.list()),
				devices: sessions.map((x) => ({
					device: x.device,
					method: x.method,
					signedInAt: x.createdAt.toISOString(),
					lastUsedAt: x.lastUsedAt.toISOString(),
				})),
			},
		};
		for (const id of await connectedProducts(s.websiteId)) {
			const answer = await product.callProduct(s.websiteId, id, '/v1/data-rights/export', {
				method: 'POST',
				body: { user: rightsUser(user) },
			});
			records[id] = answer.ok ? (bodyOf(answer.body).records ?? {}) : { unavailable: true };
		}
		const secret = randomToken(32);
		const expireAt = new Date(now() + EXPORT_MS);
		const id = await s.store.codes.add({
			kind: 'export',
			target: user.id,
			hash: sha256Hex(secret),
			expireAt,
			data: { json: JSON.stringify({ exportedAt: new Date(now()).toISOString(), records }) },
			replace: true,
		});
		return { url: `${s.base}/v1/exports/${s.websiteId}/${id}.${secret}`, expiresAt: expireAt.toISOString() };
	};

	return Object.freeze({
		site,
		siteOf,
		settings,
		signUpRules,
		roleOf,
		signUpRole,
		consentsFor,
		signingKey,
		signInFor,
		issue,
		finish,
		takeSecret,
		howOf,
		signedIn,
		checkPassword,
		passwordMethodOf,
		addressesOf,
		phoneOf,
		allowSignIn,
		allowCode,
		logSignIn,
		anyMethod,
		notify,
		deliver,
		removeHere,
		completeRequest,
		erase,
		exportFor,
		connectedProducts,
		totpAad,
		newAddressId: () => createId('adr'),
	});
};

/** @typedef {ReturnType<typeof createService>} Service */
