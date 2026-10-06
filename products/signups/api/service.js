/**
 * The Signups application service: orchestrates the pure core (`core/`) over the merchant's database
 * (`adapters/db.js`), the merchant's messaging connector (`adapters/messaging.js`) and the key material
 * (`adapters/crypto.js`). Route handlers, event consumers, the dashboard and the daily job all go through it.
 *
 * Security properties (see README "Security"):
 * - codes / links / refresh tokens are stored only as HMAC-SHA-256 with a per-website pepper; comparisons are
 *   constant time; attempts are reserved atomically before comparing; consumption is a compare-and-set;
 * - answers to code / link requests are identical whether or not an account exists (unknown identities under
 *   `allow_signup: false` and blocked accounts get a decoy challenge that is never delivered and never verifies);
 * - every limit (cooldown, per identity / IP / website, velocity) is an atomic counter in the merchant database keyed
 *   by HMACs, never by raw identifiers or IPs.
 * @module
 */
import { alphabetOf, attemptsRemaining, generateCode, normaliseCode } from '../core/codes.js';
import { covers, mergeAcceptances, parseAcceptances, pendingConsents } from '../core/consent.js';
import { anonymisedCustomer, deletionDue, deletionEffectiveAt } from '../core/dataRights.js';
import { normaliseEmail } from '../core/email.js';
import { activationFor, nextGeneration, prunableKeys, publishedKeys, rotationDue, signingKey } from '../core/keys.js';
import { DAY_MS, MINUTE_MS, cooldownLeft, counterDecision, secondsUntil, sendLimits, windowStart } from '../core/limits.js';
import { orderUpdate, orderView } from '../core/orders.js';
import { normalisePhone } from '../core/phone.js';
import { applyProfilePatch, validateProfilePatch } from '../core/profile.js';
import { magicLink, resolveRedirect } from '../core/redirect.js';
import { emailBlocked, isNewDevice, rememberDevice, velocityLimits } from '../core/risk.js';
import { PREVIOUS_HASHES, deviceOf, reuseDecision, sessionState, sessionWindow, sessionsOverLimit } from '../core/sessions.js';
import { renderMessage } from '../core/templates.js';
import { SKEW_MS, accessClaims, checkAccessClaims, formatToken, issuerFor, jwksUrlFor, parseToken } from '../core/tokens.js';
import { challengeView, customerView, sessionView, tokensView } from '../core/views.js';
import {
	generateSigningKeyPair,
	hmac,
	newId,
	randomBytes,
	randomSecret,
	safeEqual,
	signJwt,
	verifyJwt,
} from '../adapters/crypto.js';
import { SCHEMAS } from './settings.js';

/** @typedef {import('../adapters/db.js').Repositories} Repositories */
/** @typedef {import('../core/views.js').Customer} Customer */
/** @typedef {import('../core/sessions.js').Session} Session */
/** @typedef {import('../core/identifier.js').Identifier} Identifier */
/**
 * @typedef {object} Site one website, as resolved from its entitlement document
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {string} env
 * @property {string} domain
 * @property {boolean} allowSubdomains
 * @property {import('./settings.js').Settings} settings
 * @property {Repositories} repos
 * @property {any} doc signed entitlement document
 */
/**
 * @typedef {object} RequestInfo who is asking (never stored in the clear)
 * @property {string | null} ip
 * @property {string | null} userAgent
 * @property {Customer | null} [customer] the signed-in customer (link purpose)
 */
/**
 * @typedef {{ ok: true, status: number, value: any }
 *   | { ok: false, code: string, detail?: string, retryAfter?: number, extensions?: Record<string, unknown>, errors?: Array<{ path: string, code: string, message: string }> }} Outcome
 */

/** How long cached secrets and keys are reused before the database is read again. */
const CACHE_MS = 60_000;
/** Superseded signing keys stay published for the longest possible access-token lifetime plus clock skew. */
const RETAIN_MS = SCHEMAS.sessions.properties.access_ttl_minutes.maximum * MINUTE_MS + 2 * SKEW_MS;

/**
 * @param {number} status
 * @param {any} value
 * @returns {Outcome}
 */
const ok = (status, value) => ({ ok: true, status, value });
/**
 * @param {string} code
 * @param {{ detail?: string, retryAfter?: number, extensions?: Record<string, unknown>, errors?: Array<{ path: string, code: string, message: string }> }} [extra]
 * @returns {Outcome}
 */
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/**
 * @param {{
 *   app: { base: string, now: () => number, strings: Record<string, Record<string, string>>, sealer: import('../adapters/crypto.js').Sealer },
 *   messenger: import('../adapters/messaging.js').Messenger,
 *   publish: (event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>,
 *   recordUsage: (usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string }) => Promise<unknown>,
 *   audit: (entry: Record<string, unknown>) => Promise<unknown>,
 *   requestIssuer?: (input: { websiteId: string, issuer: string, jwksUrl: string, audience: string,
 *     claimMap: Record<string, string> }) => Promise<{ status: 'pending' | 'active' }>,
 *   log?: { warn?: (message: string, fields?: Record<string, unknown>) => void, error?: (message: string, fields?: Record<string, unknown>) => void },
 * }} deps `requestIssuer` is app-kit `product.portal.requestIdentityIssuer` (ask the Portal to make Signups the
 *   website's identity issuer; the merchant approves)
 */
export const createSignupsService = ({ app, messenger, publish, recordUsage, audit, requestIssuer, log }) => {
	const { now, sealer } = app;
	const iso = (/** @type {number} */ ms = now()) => new Date(ms).toISOString();
	/** @type {Map<string, { pepper: Buffer, at: number }>} */
	const peppers = new Map();
	/** @type {Map<string, { records: any[], at: number }>} */
	const keyCache = new Map();
	/** @type {Map<string, Record<string, string>>} */
	const privateKeys = new Map();

	// ── secrets ───────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The website's HMAC pepper (created and sealed on first use).
	 * @param {Site} site
	 * @returns {Promise<Buffer>}
	 */
	const pepperOf = async (site) => {
		const hit = peppers.get(site.websiteId);
		if (hit && now() - hit.at < CACHE_MS) return hit.pepper;
		let [doc] = await site.repos.keys.list('pepper');
		if (!doc) {
			const kid = 'pepper-1';
			await site.repos.keys.insert({
				kind: 'pepper',
				generation: 1,
				kid,
				activatesAt: now(),
				sealed: sealer.seal({ websiteId: site.websiteId, purpose: 'pepper', kid, plaintext: randomBytes(32) }),
			});
			[doc] = await site.repos.keys.list('pepper');
		}
		const opened = doc ? sealer.open(doc.sealed, { websiteId: site.websiteId, purpose: 'pepper', kid: doc.kid }) : null;
		if (!doc || !opened) throw new Error('the website pepper cannot be unsealed (was SIGNUPS_SEAL_SECRET changed?)');
		if (opened.stale)
			await site.repos.keys.reseal(
				'pepper',
				doc.generation,
				sealer.seal({ websiteId: site.websiteId, purpose: 'pepper', kid: doc.kid, plaintext: opened.plaintext }),
			);
		peppers.set(site.websiteId, { pepper: opened.plaintext, at: now() });
		return opened.plaintext;
	};

	/**
	 * Keyed hash `HMAC(pepper, purpose|value)`.
	 * @param {Site} site
	 */
	const hasher = async (site) => {
		const pepper = await pepperOf(site);
		return (/** @type {string} */ purpose, /** @type {string} */ value) => hmac(pepper, `${purpose}|${value}`);
	};

	/**
	 * Create the next signing key (pre-published unless it is the website's first).
	 * @param {Site} site
	 * @param {any[]} records
	 */
	const createKey = async (site, records) => {
		const generation = nextGeneration(records);
		const kid = `${site.websiteId.slice(-8)}-${generation}-${randomSecret(6)}`;
		const { publicJwk, privateJwk } = generateSigningKeyPair(kid);
		await site.repos.keys.insert({
			kind: 'signing',
			generation,
			kid,
			publicJwk,
			activatesAt: activationFor(records, now(), site.settings.sessions.key_prepublish_hours),
			sealed: sealer.seal({
				websiteId: site.websiteId,
				purpose: 'signing',
				kid,
				plaintext: Buffer.from(JSON.stringify(privateJwk)),
			}),
		});
		keyCache.delete(site.websiteId);
	};

	/**
	 * Signing-key records of a website, settled when read from the database: a rotation that is due starts (the new key
	 * is pre-published first) and superseded keys past the retention window are deleted. Nothing rotates on a timer.
	 * @param {Site} site
	 * @returns {Promise<any[]>}
	 */
	const keysOf = async (site) => {
		const hit = keyCache.get(site.websiteId);
		if (hit && now() - hit.at < CACHE_MS && !rotationDue(hit.records, now(), site.settings.sessions.key_rotation_days))
			return hit.records;
		let records = await site.repos.keys.list('signing');
		if (rotationDue(records, now(), site.settings.sessions.key_rotation_days)) {
			await createKey(site, records);
			records = await site.repos.keys.list('signing');
		}
		const prunable = prunableKeys(records, now(), RETAIN_MS);
		if (prunable.length > 0) {
			await site.repos.keys.remove(
				'signing',
				prunable.map((record) => record.generation),
			);
			records = records.filter((/** @type {any} */ record) => !prunable.includes(record));
		}
		keyCache.set(site.websiteId, { records, at: now() });
		return records;
	};

	/**
	 * The private JWK that signs now.
	 * @param {Site} site
	 */
	const currentSigner = async (site) => {
		const record = signingKey(await keysOf(site), now());
		if (!record) throw new Error('no signing key');
		const cached = privateKeys.get(`${site.websiteId}|${record.kid}`);
		if (cached) return cached;
		const opened = sealer.open(record.sealed, { websiteId: site.websiteId, purpose: 'signing', kid: record.kid });
		if (!opened) throw new Error('the signing key cannot be unsealed (was SIGNUPS_SEAL_SECRET changed?)');
		if (opened.stale)
			await site.repos.keys.reseal(
				'signing',
				record.generation,
				sealer.seal({ websiteId: site.websiteId, purpose: 'signing', kid: record.kid, plaintext: opened.plaintext }),
			);
		const jwk = JSON.parse(opened.plaintext.toString('utf8'));
		privateKeys.set(`${site.websiteId}|${record.kid}`, jwk);
		return jwk;
	};

	/**
	 * The website's public JWKS.
	 * @param {Site} site
	 */
	const jwks = async (site) => ({
		keys: publishedKeys(await keysOf(site), now(), RETAIN_MS).map((record) => record.publicJwk),
	});

	/** @param {Site} site */
	const issuerOf = (site) => issuerFor(app.base, site.websiteId);
	/** @param {Site} site */
	const audienceOf = (site) => site.settings.sessions.audience || site.websiteId;

	// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Increment a counter and decide.
	 * @param {Site} site
	 * @param {{ key: string, max: number, windowMs: number }} spec
	 */
	const hit = async (site, spec) => {
		if (spec.max <= 0) return /** @type {const} */ ({ ok: true });
		const start = windowStart(now(), spec.windowMs);
		const count = await site.repos.counters.hit(spec.key, start, spec.windowMs);
		return counterDecision({ count, max: spec.max, start, windowMs: spec.windowMs, now: now() });
	};

	/**
	 * Log a risk event (risk element on; best effort).
	 * @param {Site} site
	 * @param {string} type
	 * @param {Record<string, unknown>} [detail]
	 */
	const riskEvent = async (site, type, detail = {}) => {
		const risk = site.settings.risk;
		if (!risk) return;
		try {
			await site.repos.riskEvents.insert({
				id: newId('rsk'),
				type,
				occurredAt: iso(),
				purgeAt: new Date(now() + risk.retention_days * DAY_MS),
				...detail,
			});
		} catch (error) {
			log?.warn?.('risk event not recorded', {
				websiteId: site.websiteId,
				type,
				error: /** @type {Error} */ (error)?.message,
			});
		}
	};

	/**
	 * Publish an event; failures are logged and never fail the customer's request.
	 * @param {Site} site
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 * @param {string} key idempotency key
	 */
	const emit = async (site, type, data, key) => {
		try {
			await publish({ websiteId: site.websiteId, type, data, idempotencyKey: key });
		} catch (error) {
			log?.warn?.('event not published', { websiteId: site.websiteId, type, error: /** @type {Error} */ (error)?.message });
		}
	};

	/** @param {Site} site */
	const brandOf = (site) => site.settings.otp.brand || site.domain;
	/** @param {Site} site */
	const phoneOptions = (site) => ({
		defaultCallingCode: site.settings.otp.default_calling_code,
		trunkPrefix: site.settings.otp.trunk_prefix,
	});
	/** @param {Site} site @param {Customer} customer */
	const viewOf = (site, customer) => customerView(customer, { fields: site.settings.profile.fields });

	// ── sending codes and links ───────────────────────────────────────────────────────────────────────────

	/**
	 * Request a one-time code or a magic link. The answer is the same whether or not the identifier has an account.
	 * @param {Site} site
	 * @param {{ kind: 'otp' | 'magic_link', identifier: Identifier, purpose: 'sign_in' | 'link', lang?: string,
	 *   deviceId?: string, redirect?: unknown }} input
	 * @param {RequestInfo} rc
	 * @returns {Promise<Outcome>}
	 */
	const requestChallenge = async (site, { kind, identifier, purpose, lang, deviceId, redirect }, rc) => {
		const cfg = kind === 'otp' ? site.settings.otp : site.settings.magicLink;
		if (purpose === 'link' && !rc.customer) return fail('identity_required');
		/** @type {string | null} */
		let target = null;
		if (kind === 'magic_link') {
			const resolved = resolveRedirect({
				redirect,
				domain: site.domain,
				allowSubdomains: site.allowSubdomains,
				allowedPaths: cfg.allowed_paths,
				callbackPath: cfg.callback_path,
			});
			if (!resolved.ok) return fail(resolved.code);
			target = resolved.url;
		}
		const hash = await hasher(site);
		const identityKey = hash('id', `${identifier.kind}:${identifier.value}`);
		const ipKey = rc.ip ? hash('ip', rc.ip) : null;
		const risk = site.settings.risk;
		if (risk && identifier.kind === 'email') {
			const rules = {
				blockDisposable: risk.block_disposable_email,
				disposableDomains: risk.disposable_domains,
				blockedDomains: risk.blocked_domains,
			};
			if (emailBlocked(identifier.value, rules)) {
				await riskEvent(site, 'identifier_blocked', { ipKey, channel: identifier.channel });
				return fail('identifier_blocked');
			}
		}
		if (risk) {
			const velocity = velocityLimits({
				ipKey,
				identityKey,
				maxIdentities: risk.max_identities_per_ip_hour,
				maxFailures: risk.max_failures_per_ip_hour,
			});
			if (velocity.identities) {
				const spec = velocity.identities;
				const start = windowStart(now(), spec.windowMs);
				if (!(await site.repos.counters.addDistinct(spec.key, spec.member, start, spec.windowMs, spec.max))) {
					await riskEvent(site, 'velocity_limit', { ipKey, reason: 'identities' });
					return fail('velocity_limit', { retryAfter: secondsUntil(start, spec.windowMs, now()) });
				}
			}
		}
		const cooldownKey = `${kind}:cool:${identityKey}`;
		if (cfg.resend_cooldown_seconds > 0) {
			const running = await site.repos.cooldowns.start(cooldownKey, now() + cfg.resend_cooldown_seconds * 1000);
			if (running !== null) return fail('too_soon', { retryAfter: Math.max(1, cooldownLeft(running, now())) });
		}
		for (const spec of sendLimits({
			identityKey,
			ipKey,
			prefix: kind,
			perIdentityHour: cfg.max_sends_per_identity_hour,
			perIpHour: cfg.max_sends_per_ip_hour,
			globalHour: cfg.global_sends_per_hour,
		})) {
			const decision = await hit(site, spec);
			if (!decision.ok) {
				if (spec.key.endsWith(':all')) log?.error?.('website-wide send cap reached', { websiteId: site.websiteId, kind });
				return fail('send_limit', { retryAfter: decision.retryAfter });
			}
		}
		// a due deletion runs before the challenge exists (it removes the identity's pending challenges): the address
		// then signs up as a new customer
		const found = /** @type {Customer | null} */ (await site.repos.customers.findBy(identifier.kind, identifier.value));
		const existing =
			(await settleDeletion(site, found))?.status === 'deleted'
				? /** @type {Customer | null} */ (await site.repos.customers.findBy(identifier.kind, identifier.value))
				: found;
		const decoy =
			purpose === 'sign_in' && ((!existing && !cfg.allow_signup) || (existing !== null && existing.status !== 'active'));
		const id = newId(kind === 'otp' ? 'otp' : 'mlk');
		const expiresAt = now() + cfg.expiry_minutes * MINUTE_MS;
		const shape = { length: site.settings.otp.code_length, alphabet: alphabetOf(site.settings.otp.code_alphabet) };
		const secret =
			kind === 'otp' ? generateCode({ length: shape.length, alphabet: shape.alphabet, randomBytes }) : randomSecret(32);
		await site.repos.challenges.insert({
			id,
			kind,
			purpose,
			channel: identifier.channel,
			identifierKind: identifier.kind,
			identifier: identifier.value,
			identityKey,
			// a decoy's hash is of a random value nobody knows: it can never verify
			codeHash: hash(kind, `${id}|${decoy ? randomSecret(32) : secret}`),
			...(kind === 'otp' ? { codeLength: shape.length, codeAlphabet: shape.alphabet } : {}),
			attempts: 0,
			maxAttempts: kind === 'otp' ? site.settings.otp.max_attempts : SCHEMAS.otp.properties.max_attempts.maximum,
			expiresAt: new Date(expiresAt),
			consumedAt: null,
			decoy,
			customerId: purpose === 'link' ? /** @type {Customer} */ (rc.customer).id : null,
			deviceHash: deviceId ? hash('dev', deviceId) : null,
			ipKey,
			lang: lang ?? null,
			purgeAt: new Date(expiresAt + DAY_MS),
		});
		if (!decoy) {
			const minutes = cfg.expiry_minutes;
			const link = target ? magicLink(target, formatToken('ml1', id, secret)) : null;
			/** @type {Record<string, string | number>} */
			const variables = { minutes, brand: brandOf(site), ...(link ? { link } : { code: secret }) };
			const templates =
				kind === 'otp'
					? site.settings.otp.templates
					: site.settings.magicLink.templates.map((/** @type {any} */ t) => ({ ...t, channel: 'email' }));
			const message = renderMessage({
				purpose: kind,
				channel: identifier.channel,
				lang,
				defaultLanguage: site.settings.otp.default_language,
				templates,
				catalogs: app.strings,
				params: variables,
			});
			const delivered = await messenger.send(site.websiteId, {
				channel: identifier.channel,
				to: identifier.value,
				...(message.subject ? { subject: message.subject } : {}),
				text: message.text,
				purpose: kind,
				lang: message.lang,
				reference: id,
				idempotencyKey: `signups:${id}`,
				variables,
			});
			if (!delivered.ok) {
				await site.repos.challenges.remove(id);
				await site.repos.cooldowns.release(cooldownKey);
				return fail(delivered.code === 'resource_missing' ? 'resource_missing' : 'delivery_failed');
			}
			const unit = kind === 'otp' ? 'otp_send' : 'magic_link_send';
			await recordUsage({ websiteId: site.websiteId, unit, quantity: 1, idempotencyKey: `${unit}:${id}` });
		}
		return ok(
			202,
			challengeView({
				id,
				channel: identifier.channel,
				masked: identifier.masked,
				expiresAt: iso(expiresAt),
				resendAfter: cfg.resend_cooldown_seconds,
				...(kind === 'otp' ? { code: { length: shape.length, alphabet: site.settings.otp.code_alphabet } } : {}),
			}),
		);
	};

	/**
	 * Failed-verification velocity of the requester's IP (risk element): `check` before spending an attempt, `count`
	 * after a failure.
	 * @param {Site} site
	 * @param {string | null} ipKey
	 */
	const failures = (site, ipKey) => {
		const risk = site.settings.risk;
		const spec =
			risk && ipKey ? velocityLimits({ ipKey, maxIdentities: 0, maxFailures: risk.max_failures_per_ip_hour }).failures : null;
		return {
			/** @returns {Promise<{ ok: true } | { ok: false, retryAfter: number }>} */
			check: async () => {
				if (!spec) return { ok: true };
				const start = windowStart(now(), spec.windowMs);
				const count = await site.repos.counters.peek(spec.key, start);
				return count < spec.max ? { ok: true } : { ok: false, retryAfter: secondsUntil(start, spec.windowMs, now()) };
			},
			count: async () => {
				if (spec) await hit(site, spec);
			},
		};
	};

	/**
	 * Verify a one-time code.
	 * @param {Site} site
	 * @param {string} challengeId
	 * @param {{ code: string, deviceId?: string, consents?: unknown }} body
	 * @param {RequestInfo} rc
	 * @returns {Promise<Outcome>}
	 */
	const verifyCode = async (site, challengeId, body, rc) => {
		const hash = await hasher(site);
		const ipKey = rc.ip ? hash('ip', rc.ip) : null;
		const velocity = failures(site, ipKey);
		const gate = await velocity.check();
		if (!gate.ok) {
			await riskEvent(site, 'velocity_limit', { ipKey, reason: 'failures' });
			return fail('velocity_limit', { retryAfter: gate.retryAfter });
		}
		const challenge = /^otp_[0-9a-z]{26}$/.test(challengeId) ? await site.repos.challenges.get(challengeId) : null;
		if (!challenge || challenge.kind !== 'otp') return fail('code_invalid');
		if (challenge.consumedAt) return fail(challenge.consumedReason === 'exhausted' ? 'attempts_exhausted' : 'code_invalid');
		if (challenge.expiresAt.getTime() <= now()) return fail('code_expired');
		const remaining = (/** @type {number} */ attempts) => {
			const left = attemptsRemaining(attempts, challenge.maxAttempts);
			return {
				// RFC 9457 extension member; `errors[0]` keeps the v1 shape for existing clients
				extensions: { attemptsRemaining: left },
				errors: [{ path: '/code', code: 'attempts_remaining', message: String(left) }],
			};
		};
		const code = normaliseCode(body.code, { length: challenge.codeLength, alphabet: challenge.codeAlphabet });
		if (!code) return fail('code_invalid', remaining(challenge.attempts));
		const reserved = await site.repos.challenges.reserveAttempt(challengeId, new Date(now()));
		if (!reserved) return fail('attempts_exhausted');
		if (reserved.decoy || !safeEqual(hash('otp', `${challengeId}|${code}`), reserved.codeHash)) {
			await velocity.count();
			if (reserved.attempts >= reserved.maxAttempts) {
				await site.repos.challenges.consume(challengeId, new Date(now()), 'exhausted');
				return fail('attempts_exhausted');
			}
			return fail('code_invalid', remaining(reserved.attempts));
		}
		return completeSignIn(site, reserved, { method: 'otp', body, rc });
	};

	/**
	 * Consume a magic link.
	 * @param {Site} site
	 * @param {{ token: string, deviceId?: string, consents?: unknown }} body
	 * @param {RequestInfo} rc
	 * @returns {Promise<Outcome>}
	 */
	const consumeLink = async (site, body, rc) => {
		const parsed = parseToken(body.token, 'ml1');
		if (!parsed || !parsed.id.startsWith('mlk_')) return fail('link_invalid');
		const hash = await hasher(site);
		const challenge = await site.repos.challenges.get(parsed.id);
		if (!challenge || challenge.kind !== 'magic_link' || challenge.consumedAt) return fail('link_invalid');
		if (challenge.expiresAt.getTime() <= now()) return fail('link_expired');
		const reserved = await site.repos.challenges.reserveAttempt(parsed.id, new Date(now()));
		if (!reserved) return fail('link_invalid');
		const deviceOk =
			!site.settings.magicLink.bind_device ||
			(typeof body.deviceId === 'string' &&
				reserved.deviceHash !== null &&
				safeEqual(hash('dev', body.deviceId), reserved.deviceHash));
		if (reserved.decoy || !safeEqual(hash('magic_link', `${parsed.id}|${parsed.secret}`), reserved.codeHash) || !deviceOk) {
			if (reserved.attempts >= reserved.maxAttempts)
				await site.repos.challenges.consume(parsed.id, new Date(now()), 'exhausted');
			return fail('link_invalid');
		}
		return completeSignIn(site, reserved, { method: 'magic_link', body, rc });
	};

	/**
	 * After a proven code / link: consent, customer, session, events.
	 * @param {Site} site
	 * @param {Record<string, any>} challenge reserved challenge
	 * @param {{ method: 'otp' | 'magic_link', body: { deviceId?: string, consents?: unknown }, rc: RequestInfo }} input
	 * @returns {Promise<Outcome>}
	 */
	const completeSignIn = async (site, challenge, { method, body, rc }) => {
		const kind = /** @type {'email' | 'phone'} */ (challenge.identifierKind);
		const value = /** @type {string} */ (challenge.identifier);
		const at = iso();
		/** @type {Customer | null} */
		let customer;
		if (challenge.purpose === 'link') {
			customer = await settleDeletion(site, await site.repos.customers.get(challenge.customerId));
			if (!customer || customer.status !== 'active') {
				await site.repos.challenges.consume(challenge.id, new Date(now()));
				return fail('session_ended');
			}
			const other = await site.repos.customers.findBy(kind, value);
			if (other && other.id !== customer.id) {
				await site.repos.challenges.consume(challenge.id, new Date(now()));
				return fail('identifier_in_use');
			}
		} else {
			customer = await site.repos.customers.findBy(kind, value);
			if (customer && customer.status !== 'active') {
				await site.repos.challenges.consume(challenge.id, new Date(now()));
				return fail('account_blocked');
			}
		}
		/** @type {Array<{ key: string, version: string }>} */
		let accepted = [];
		const consent = site.settings.consent;
		if (consent) {
			const parsed = parseAcceptances(body.consents, consent.documents);
			if (!parsed.ok) return fail('validation_failed', { errors: parsed.problems.map((p) => ({ ...p, message: p.code })) });
			const pending = pendingConsents(consent.documents, customer?.consents, {
				isNew: !customer,
				requireReacceptance: consent.require_reacceptance,
			});
			// the code stays valid: the client sends it again with the acceptances
			if (!covers(pending, parsed.accepted))
				return fail('consent_required', {
					errors: pending.map((doc) => ({ path: `/consents/${doc.key}`, code: 'required', message: doc.version })),
				});
			accepted = parsed.accepted;
		}
		if (!(await site.repos.challenges.consume(challenge.id, new Date(now()))))
			return fail(method === 'otp' ? 'code_invalid' : 'link_invalid');
		const verifiedField = kind === 'email' ? 'emailVerifiedAt' : 'phoneVerifiedAt';
		let created = false;
		if (challenge.purpose === 'link') {
			const updated = await site.repos.customers.update(/** @type {Customer} */ (customer).id, {
				[kind]: value,
				[verifiedField]: at,
			});
			if (updated === 'conflict' || updated === null) return fail('identifier_in_use');
			customer = /** @type {Customer} */ (updated);
			await emit(site, 'customer.updated@1', { customerId: customer.id, changed: [kind] }, `customer.updated:${challenge.id}`);
		} else if (!customer) {
			const id = newId('cus');
			const inserted = await site.repos.customers.insert({
				id,
				customerId: id,
				email: kind === 'email' ? value : null,
				phone: kind === 'phone' ? value : null,
				emailVerifiedAt: kind === 'email' ? at : null,
				phoneVerifiedAt: kind === 'phone' ? at : null,
				externalId: null,
				status: 'active',
				sessionVersion: 0,
				profile: {},
				addresses: [],
				custom: {},
				consents: {},
				knownDevices: [],
				source: method,
				signInCount: 0,
				lastSignInAt: null,
			});
			customer = /** @type {Customer | null} */ (inserted ?? (await site.repos.customers.findBy(kind, value)));
			if (!customer) throw new Error('customer could not be created');
			created = inserted !== null;
		} else if (!customer[verifiedField]) {
			customer = /** @type {Customer} */ (
				(await site.repos.customers.update(customer.id, { [verifiedField]: at })) ?? customer
			);
		}
		if (accepted.length > 0) {
			const current = /** @type {Customer} */ (customer);
			customer = /** @type {Customer} */ (
				(await site.repos.customers.update(current.id, { consents: mergeAcceptances(current.consents, accepted, at) })) ??
					current
			);
			await site.repos.consents.append(
				accepted.map((a) => ({
					id: newId('cns'),
					customerId: current.id,
					key: a.key,
					version: a.version,
					acceptedAt: at,
					method,
				})),
			);
		}
		const signedIn = /** @type {Customer} */ (customer);
		const session = await openSession(site, signedIn, {
			method,
			deviceId: body.deviceId,
			rc,
			channel: challenge.channel,
			isNew: created,
			lang: challenge.lang,
		});
		if (created) {
			const share = site.settings.profile.share_identifiers_in_events;
			await emit(
				site,
				'customer.created@1',
				{
					customerId: signedIn.id,
					source: `signups.${method}`,
					...(share ? { identities: [{ type: kind, value }] } : {}),
				},
				`customer.created:${signedIn.id}`,
			);
			await emit(
				site,
				'signups.customer_created@1',
				{ customerId: signedIn.id, method, channel: challenge.channel },
				`signups.customer_created:${signedIn.id}`,
			);
		}
		await emit(site, 'customer.signed_in@1', { customerId: signedIn.id, method }, `customer.signed_in:${session.session.id}`);
		await emit(
			site,
			'signups.signed_in@1',
			{
				customerId: signedIn.id,
				method,
				channel: challenge.channel,
				sessionId: session.session.id,
				newDevice: session.newDevice,
			},
			`signups.signed_in:${session.session.id}`,
		);
		return ok(200, {
			customer: viewOf(site, session.customer),
			created,
			tokens: tokensView(session),
		});
	};

	// ── sessions ──────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Sign an access token for a customer's session.
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {Session} session
	 */
	const accessToken = async (site, customer, session) => {
		const cfg = site.settings.sessions;
		const claims = accessClaims({
			issuer: issuerOf(site),
			audience: audienceOf(site),
			customer,
			sessionId: session.id,
			method: session.method,
			now: now(),
			ttlMinutes: cfg.access_ttl_minutes,
			jti: randomSecret(12),
			include: { email: cfg.include_email_claim, phone: cfg.include_phone_claim },
		});
		return {
			accessToken: signJwt(await currentSigner(site), /** @type {any} */ (claims)),
			accessExpiresAt: iso(claims.exp * 1000),
		};
	};

	/**
	 * Open a session for a signed-in customer (oldest sessions over the limit are ended; new-device notice).
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {{ method: string, deviceId?: string, rc: RequestInfo, channel: string, isNew: boolean, lang?: string | null }} input
	 */
	const openSession = async (site, customer, { method, deviceId, rc, channel, isNew, lang }) => {
		const cfg = site.settings.sessions;
		const hash = await hasher(site);
		const at = iso();
		const deviceHash = deviceId ? hash('dev', deviceId) : null;
		const active = /** @type {Session[]} */ (await site.repos.sessions.active(customer.id)).filter(
			(s) => sessionState(s, now()) === 'active',
		);
		const over = sessionsOverLimit(active, cfg.max_sessions_per_customer);
		if (over.length > 0) await site.repos.sessions.revoke({ id: { $in: over } }, at, 'session_limit');
		const id = newId('ses');
		const secret = randomSecret(32);
		const window = sessionWindow({
			createdAt: now(),
			now: now(),
			refreshTtlDays: cfg.refresh_ttl_days,
			idleTimeoutDays: cfg.idle_timeout_days,
			sliding: true,
		});
		/** @type {Session & Record<string, unknown>} */
		const session = {
			id,
			customerId: customer.id,
			method,
			createdAt: at,
			lastUsedAt: at,
			...window,
			revokedAt: null,
			revokeReason: null,
			refreshHash: hash('rt', `${id}|${secret}`),
			previousHashes: [],
			device: deviceOf(rc.userAgent),
			deviceHash,
			purgeAt: new Date(Date.parse(window.expiresAt) + 30 * DAY_MS),
		};
		await site.repos.sessions.insert(session);
		const risk = site.settings.risk;
		const known = customer.knownDevices ?? [];
		const newDevice = Boolean(risk) && !isNew && known.length > 0 && isNewDevice(known, deviceHash);
		const updated = await site.repos.customers.update(
			customer.id,
			{
				lastSignInAt: at,
				knownDevices: rememberDevice(
					known,
					deviceHash,
					risk?.known_devices_max ?? SCHEMAS.risk.properties.known_devices_max.default,
				),
			},
			{ $inc: { signInCount: 1 } },
		);
		const current = updated && updated !== 'conflict' ? /** @type {Customer} */ (updated) : customer;
		if (newDevice && risk) {
			await riskEvent(site, 'new_device', { customerId: customer.id, sessionId: id });
			if (risk.new_device_notice) await notifyNewDevice(site, current, { channel, session, lang });
		}
		const tokens = await accessToken(site, current, session);
		return { session, refreshToken: formatToken('rt1', id, secret), ...tokens, newDevice, customer: current };
	};

	/**
	 * Tell the customer about a sign-in from a new device, on the channel they used (best effort).
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {{ channel: string, session: Session, lang?: string | null }} input
	 */
	const notifyNewDevice = async (site, customer, { channel, session, lang }) => {
		const to = channel === 'email' ? customer.email : customer.phone;
		if (!to) return;
		const variables = { brand: brandOf(site), device: session.device.label, time: session.createdAt };
		const message = renderMessage({
			purpose: 'new_device',
			channel,
			lang,
			defaultLanguage: site.settings.otp.default_language,
			templates: site.settings.risk?.templates ?? [],
			catalogs: app.strings,
			params: variables,
		});
		await messenger.send(site.websiteId, {
			channel,
			to,
			...(message.subject ? { subject: message.subject } : {}),
			text: message.text,
			purpose: 'new_device',
			lang: message.lang,
			reference: session.id,
			idempotencyKey: `signups:new_device:${session.id}`,
			variables,
		});
	};

	/**
	 * Rotate a refresh token (reuse detection).
	 * @param {Site} site
	 * @param {{ refreshToken: string }} body
	 * @returns {Promise<Outcome>}
	 */
	const refresh = async (site, body) => {
		const parsed = parseToken(body.refreshToken, 'rt1');
		if (!parsed || !parsed.id.startsWith('ses_')) return fail('refresh_invalid');
		const hash = await hasher(site);
		const presented = hash('rt', `${parsed.id}|${parsed.secret}`);
		const session = /** @type {(Session & Record<string, any>) | null} */ (await site.repos.sessions.get(parsed.id));
		if (!session) return fail('refresh_invalid');
		const cfg = site.settings.sessions;
		if (!safeEqual(String(session.refreshHash), presented)) {
			const previous = /** @type {string[]} */ (session.previousHashes ?? []);
			if (!previous.some((p) => safeEqual(p, presented)) || session.revokedAt) return fail('refresh_invalid');
			const decision = reuseDecision({
				rotatedAt: session.rotatedAt,
				now: now(),
				graceSeconds: cfg.reuse_grace_seconds,
				reuseDetection: cfg.reuse_detection,
			});
			if (decision === 'conflict') return fail('refresh_conflict');
			if (decision === 'invalid') return fail('refresh_invalid');
			await site.repos.sessions.revoke({ id: session.id }, iso(), 'reuse_detected');
			await riskEvent(site, 'refresh_reuse', { customerId: session.customerId, sessionId: session.id });
			return fail('refresh_reused');
		}
		if (sessionState(session, now()) !== 'active') return fail('session_ended');
		const customer = await settleDeletion(site, await site.repos.customers.get(session.customerId));
		if (!customer || customer.status !== 'active') {
			await site.repos.sessions.revoke({ id: session.id }, iso(), 'account_inactive');
			return fail('session_ended');
		}
		const secret = randomSecret(32);
		const at = iso();
		const window = sessionWindow({
			createdAt: Date.parse(session.createdAt),
			now: now(),
			refreshTtlDays: cfg.refresh_ttl_days,
			idleTimeoutDays: cfg.idle_timeout_days,
			sliding: cfg.sliding_renewal,
			previousIdle: session.idleExpiresAt,
		});
		const rotated = /** @type {Session | null} */ (
			await site.repos.sessions.rotate(
				session.id,
				presented,
				{
					refreshHash: hash('rt', `${session.id}|${secret}`),
					lastUsedAt: at,
					rotatedAt: at,
					idleExpiresAt: window.idleExpiresAt,
				},
				PREVIOUS_HASHES,
			)
		);
		if (!rotated) return fail('refresh_conflict');
		const tokens = await accessToken(site, customer, rotated);
		return ok(200, {
			customer: viewOf(site, customer),
			tokens: tokensView({ ...tokens, refreshToken: formatToken('rt1', session.id, secret), session: rotated }),
		});
	};

	/**
	 * Sign out with a refresh token (always 204: signing out twice is not an error).
	 * @param {Site} site
	 * @param {{ refreshToken: string }} body
	 * @returns {Promise<Outcome>}
	 */
	const logout = async (site, body) => {
		const parsed = parseToken(body.refreshToken, 'rt1');
		if (parsed) {
			const hash = await hasher(site);
			const session = await site.repos.sessions.get(parsed.id);
			if (session && safeEqual(String(session.refreshHash), hash('rt', `${parsed.id}|${parsed.secret}`)))
				await site.repos.sessions.revoke({ id: parsed.id }, iso(), 'logout');
		}
		return ok(204, undefined);
	};

	/**
	 * Verify a customer access token for this product's own routes: signature, issuer, audience, expiry — and, unlike
	 * offline verifiers, the session and session version, so revocation is immediate here.
	 * @param {Site} site
	 * @param {unknown} token
	 * @returns {Promise<{ ok: true, customer: Customer, session: Session } | { ok: false, code: 'identity_required' | 'identity_invalid' }>}
	 */
	const authenticate = async (site, token) => {
		if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'identity_required' };
		const verified = verifyJwt(token, (await jwks(site)).keys);
		if (!verified.ok) return { ok: false, code: 'identity_invalid' };
		const checked = checkAccessClaims(verified.claims, { issuer: issuerOf(site), audience: audienceOf(site), now: now() });
		if (!checked.ok) return { ok: false, code: 'identity_invalid' };
		const { claims } = checked;
		const session = /** @type {Session | null} */ (await site.repos.sessions.get(claims.sid));
		if (!session || session.customerId !== claims.sub || sessionState(session, now()) !== 'active')
			return { ok: false, code: 'identity_invalid' };
		const customer = await settleDeletion(site, /** @type {Customer | null} */ (await site.repos.customers.get(claims.sub)));
		if (!customer || customer.status !== 'active' || (customer.sessionVersion ?? 0) !== claims.sv)
			return { ok: false, code: 'identity_invalid' };
		return { ok: true, customer, session };
	};

	/**
	 * A customer's sessions (device list).
	 * @param {Site} site
	 * @param {string} customerId
	 * @param {string | null} currentId
	 */
	const sessions = async (site, customerId, currentId = null) =>
		(await site.repos.sessions.recent(customerId, site.settings.sessions.max_sessions_per_customer * 2))
			.map((/** @type {Session} */ s) => sessionView(s, { now: now(), currentId }))
			.filter((/** @type {{ state: string }} */ view) => view.state === 'active');

	/**
	 * End one session of a customer.
	 * @param {Site} site
	 * @param {string} customerId
	 * @param {string} sessionId
	 * @returns {Promise<Outcome>}
	 */
	const revokeSession = async (site, customerId, sessionId) =>
		(await site.repos.sessions.revoke({ id: sessionId, customerId }, iso(), 'revoked')) > 0
			? ok(204, undefined)
			: fail('not_found', { detail: 'No such active session.' });

	/**
	 * End every session of a customer and bump the session version (access tokens die at once on this product).
	 * @param {Site} site
	 * @param {string} customerId
	 * @param {string} reason
	 * @returns {Promise<Outcome>}
	 */
	const revokeAll = async (site, customerId, reason = 'revoke_all') => {
		const updated = await site.repos.customers.update(customerId, {}, { $inc: { sessionVersion: 1 } });
		if (!updated || updated === 'conflict') return fail('not_found', { detail: 'No such customer.' });
		const revoked = await site.repos.sessions.revoke({ customerId }, iso(), reason);
		return ok(200, { customerId, revoked, sessionVersion: /** @type {Customer} */ (updated).sessionVersion });
	};

	// ── customers and profiles ────────────────────────────────────────────────────────────────────────────

	/** @param {Site} site */
	const profileRules = (site) => ({
		fields: site.settings.profile.fields,
		maxAddresses: site.settings.profile.max_addresses,
		addressRequired: site.settings.profile.address_required,
		maxCustomKeys: site.settings.profile.max_custom_keys,
	});

	/**
	 * Create (import) a customer from the merchant's server.
	 * @param {Site} site
	 * @param {Record<string, any>} body validated shape
	 * @param {{ actor: { type: string, id?: string } }} context
	 * @returns {Promise<Outcome>}
	 */
	const createCustomer = async (site, body, { actor }) => {
		/** @type {Array<{ path: string, code: string, message: string }>} */
		const errors = [];
		const email = body.email === undefined ? null : normaliseEmail(body.email);
		const phone = body.phone === undefined ? null : normalisePhone(body.phone, phoneOptions(site));
		if (body.email !== undefined && !email) errors.push({ path: '/email', code: 'format', message: 'format' });
		if (body.phone !== undefined && !phone) errors.push({ path: '/phone', code: 'format', message: 'format' });
		for (const p of validateProfilePatch(
			Object.fromEntries(['profile', 'addresses', 'custom'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])),
			profileRules(site),
		))
			errors.push({ ...p, message: p.code });
		if (errors.length > 0) return fail('validation_failed', { errors });
		const id = newId('cus');
		const at = iso();
		const base = {
			id,
			customerId: id,
			email,
			phone,
			emailVerifiedAt: email && body.verified?.email ? at : null,
			phoneVerifiedAt: phone && body.verified?.phone ? at : null,
			externalId: body.externalId ?? null,
			status: 'active',
			sessionVersion: 0,
			profile: {},
			addresses: [],
			custom: {},
			consents: {},
			knownDevices: [],
			source: 'import',
			signInCount: 0,
			lastSignInAt: null,
		};
		const { customer } = applyProfilePatch(base, body, {
			newId: () => newId('adr'),
			maxCustomKeys: site.settings.profile.max_custom_keys,
		});
		const inserted = await site.repos.customers.insert(customer);
		if (!inserted) return fail('identifier_in_use', { detail: 'Another customer has this e-mail, phone or external id.' });
		await audit({ websiteId: site.websiteId, actor, action: 'customer.created', target: { type: 'customer', id } });
		await emit(site, 'customer.created@1', { customerId: id, source: 'signups.import' }, `customer.created:${id}`);
		// the answer carries no personal data: POST answers are kept in the replay cache (GET the customer for details)
		return ok(201, { id, status: 'active', createdAt: viewOf(site, /** @type {Customer} */ (inserted)).createdAt });
	};

	/**
	 * Patch a profile (customer or server).
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {Record<string, any>} body
	 * @param {{ admin?: boolean, actor?: { type: string, id?: string } }} [options] admin: `status` and `externalId` too
	 * @returns {Promise<Outcome>}
	 */
	const patchCustomer = async (site, customer, body, { admin = false, actor } = {}) => {
		const { status, externalId, ...rest } = body;
		const problems = validateProfilePatch(rest, profileRules(site));
		if (problems.length > 0) return fail('validation_failed', { errors: problems.map((p) => ({ ...p, message: p.code })) });
		const { customer: next, changed } = applyProfilePatch(customer, rest, {
			newId: () => newId('adr'),
			maxCustomKeys: site.settings.profile.max_custom_keys,
		});
		/** @type {Record<string, unknown>} */
		const set = {};
		if (rest.profile) set.profile = next.profile;
		if (rest.addresses) set.addresses = next.addresses;
		if (rest.custom) set.custom = next.custom;
		if (admin && status !== undefined && status !== customer.status) {
			set.status = status;
			changed.push('status');
		}
		if (admin && externalId !== undefined) {
			set.externalId = externalId;
			changed.push('externalId');
		}
		if (changed.length === 0) return ok(200, viewOf(site, customer));
		const updated = await site.repos.customers.update(customer.id, set);
		if (updated === 'conflict') return fail('identifier_in_use', { detail: 'Another customer has this external id.' });
		if (!updated) return fail('not_found');
		if (set.status === 'blocked') await revokeAll(site, customer.id, 'blocked');
		if (actor)
			await audit({
				websiteId: site.websiteId,
				actor,
				action: 'customer.updated',
				target: { type: 'customer', id: customer.id },
			});
		await emit(
			site,
			'customer.updated@1',
			{ customerId: customer.id, changed: [...new Set(changed)].slice(0, 20) },
			`customer.updated:${customer.id}:${iso()}`,
		);
		return ok(200, viewOf(site, /** @type {Customer} */ (updated)));
	};

	// ── consent ───────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Documents with the customer's acceptance status, and the acceptance history.
	 * @param {Site} site
	 * @param {Customer} customer
	 */
	const consents = async (site, customer) => {
		const documents = site.settings.consent?.documents ?? [];
		return {
			documents: documents.map((doc) => {
				const accepted = customer.consents?.[doc.key];
				return {
					...doc,
					required: doc.required === true,
					accepted: accepted
						? { version: accepted.version, acceptedAt: accepted.acceptedAt, current: accepted.version === doc.version }
						: null,
				};
			}),
			history: (await site.repos.consents.list(customer.id, 50)).map((/** @type {any} */ record) => ({
				key: record.key,
				version: record.version,
				acceptedAt: record.acceptedAt,
				method: record.method,
			})),
		};
	};

	/**
	 * Record acceptances.
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {unknown} input
	 * @returns {Promise<Outcome>}
	 */
	const acceptConsents = async (site, customer, input) => {
		const parsed = parseAcceptances(input, site.settings.consent?.documents ?? []);
		if (!parsed.ok) return fail('validation_failed', { errors: parsed.problems.map((p) => ({ ...p, message: p.code })) });
		const at = iso();
		const updated = await site.repos.customers.update(customer.id, {
			consents: mergeAcceptances(customer.consents, parsed.accepted, at),
		});
		await site.repos.consents.append(
			parsed.accepted.map((a) => ({
				id: newId('cns'),
				customerId: customer.id,
				key: a.key,
				version: a.version,
				acceptedAt: at,
				method: 'account',
			})),
		);
		return ok(200, await consents(site, /** @type {Customer} */ (updated && updated !== 'conflict' ? updated : customer)));
	};

	// ── data rights ───────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Everything this product holds about a customer.
	 * @param {Site} site
	 * @param {Customer} customer
	 */
	const exportCustomer = async (site, customer) => ({
		exportedAt: iso(),
		customer: viewOf(site, customer),
		sessions: (await site.repos.sessions.recent(customer.id, 100)).map((/** @type {Session} */ s) =>
			sessionView(s, { now: now() }),
		),
		consents: (await site.repos.consents.list(customer.id, 1000)).map((/** @type {any} */ r) => ({
			key: r.key,
			version: r.version,
			acceptedAt: r.acceptedAt,
		})),
		orders: (await site.repos.orders.forCustomer(customer.id, 1000)).map(orderView),
		dataRequests: (await site.repos.dataRequests.list(customer.id, 100)).map(requestView),
	});

	/** @param {Record<string, any>} r */
	const requestView = (r) => ({
		id: r.id,
		type: r.type,
		status: r.status,
		effectiveAt: r.effectiveAt ?? null,
		createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
		completedAt: r.completedAt ?? null,
	});

	/**
	 * Anonymise a customer now (deletion): sessions ended, pending codes removed, personal fields nulled.
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {string} reason
	 */
	const executeDeletion = async (site, customer, reason) => {
		const hash = await hasher(site);
		await revokeAll(site, customer.id, 'deleted');
		await site.repos.challenges.removeForIdentities(
			[customer.email ? `email:${customer.email}` : null, customer.phone ? `phone:${customer.phone}` : null]
				.filter((v) => v !== null)
				.map((v) => hash('id', /** @type {string} */ (v))),
		);
		await site.repos.customers.update(customer.id, anonymisedCustomer(iso()));
		await site.repos.consents.removeFor(customer.id);
		await site.repos.orders.removeFor(customer.id);
		await emit(
			site,
			'customer.updated@1',
			{ customerId: customer.id, changed: ['deleted'] },
			`customer.deleted:${customer.id}`,
		);
		return { customerId: customer.id, reason };
	};

	/**
	 * Delete (anonymise) a customer from the merchant's server.
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {{ actor: { type: string, id?: string } }} context
	 * @returns {Promise<Outcome>}
	 */
	const deleteCustomer = async (site, customer, { actor }) => {
		await executeDeletion(site, customer, 'api');
		await audit({
			websiteId: site.websiteId,
			actor,
			action: 'customer.deleted',
			target: { type: 'customer', id: customer.id },
		});
		return ok(200, { id: customer.id, deleted: true });
	};

	/**
	 * Create an export or deletion request.
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {'export' | 'delete'} type
	 * @returns {Promise<Outcome>}
	 */
	const createDataRequest = async (site, customer, type) => {
		const cfg = /** @type {Record<string, any>} */ (site.settings.dataRights);
		const at = iso();
		if (type === 'export') {
			if (!cfg.allow_export) return fail('not_allowed', { detail: 'Data export is not enabled.' });
			const id = newId('dsr');
			await site.repos.dataRequests.insert({
				id,
				customerId: customer.id,
				type,
				status: 'completed',
				effectiveAt: at,
				completedAt: at,
			});
			const request = await site.repos.dataRequests.get(id);
			// the data itself is fetched with GET (POST answers are kept in the replay cache, which must not hold PII)
			return ok(201, { ...requestView(/** @type {any} */ (request)), download: `/v1/data-requests/${id}/export` });
		}
		if (!cfg.allow_delete) return fail('not_allowed', { detail: 'Account deletion is not enabled.' });
		if (await site.repos.dataRequests.pendingDeletion(customer.id)) return fail('data_request_pending');
		const id = newId('dsr');
		const effectiveAt = deletionEffectiveAt(now(), cfg.cooling_off_days);
		await site.repos.dataRequests.insert({
			id,
			customerId: customer.id,
			type,
			status: 'pending',
			effectiveAt,
			completedAt: null,
		});
		if (cfg.cooling_off_days === 0) {
			await executeDeletion(site, customer, 'self_service');
			await site.repos.dataRequests.close(id, { status: 'completed', completedAt: at });
		}
		return ok(201, requestView(/** @type {any} */ (await site.repos.dataRequests.get(id))));
	};

	/**
	 * The data of a completed export request, while its download window is open.
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {string} id
	 * @returns {Promise<Outcome>}
	 */
	const downloadExport = async (site, customer, id) => {
		const cfg = /** @type {Record<string, any>} */ (site.settings.dataRights);
		const request = await site.repos.dataRequests.get(id);
		if (!request || request.customerId !== customer.id || request.type !== 'export') return fail('not_found');
		if (!cfg.allow_export) return fail('not_allowed', { detail: 'Data export is not enabled.' });
		const created = request.createdAt instanceof Date ? request.createdAt.getTime() : Date.parse(request.createdAt);
		if (now() - created > cfg.export_link_minutes * MINUTE_MS)
			return fail('gone', { detail: 'The export expired; request a new one.' });
		return ok(200, await exportCustomer(site, customer));
	};

	/**
	 * Cancel a pending deletion.
	 * @param {Site} site
	 * @param {string} customerId
	 * @param {string} id
	 * @returns {Promise<Outcome>}
	 */
	const cancelDataRequest = async (site, customerId, id) => {
		const request = await site.repos.dataRequests.get(id);
		if (!request || request.customerId !== customerId) return fail('not_found');
		if (!(await site.repos.dataRequests.close(id, { status: 'cancelled', completedAt: iso() })))
			return fail('conflict', { detail: 'Only pending requests can be cancelled.' });
		return ok(200, requestView(/** @type {any} */ (await site.repos.dataRequests.get(id))));
	};

	/**
	 * Expire-on-read: a customer whose deletion's cooling-off has ended is deleted on access (nothing runs on a timer).
	 * Returns the customer as it now is (anonymised when the deletion ran).
	 * @template {Customer | null} C
	 * @param {Site} site
	 * @param {C} customer
	 * @returns {Promise<C>}
	 */
	const settleDeletion = async (site, customer) => {
		if (!customer || customer.status === 'deleted' || !site.settings.dataRights) return customer;
		const pending = await site.repos.dataRequests.pendingDeletion(customer.id);
		if (!pending || !deletionDue(/** @type {any} */ (pending), now())) return customer;
		await executeDeletion(site, customer, 'self_service');
		await site.repos.dataRequests.close(pending.id, { status: 'completed', completedAt: iso() });
		return /** @type {C} */ (await site.repos.customers.get(customer.id));
	};

	/**
	 * Expire-on-read for a listing: the due deletions of the customers listed (one query) run before they are shown.
	 * @param {Site} site
	 * @param {Customer[]} customers
	 * @returns {Promise<Customer[]>}
	 */
	const settleDeletions = async (site, customers) => {
		const active = customers.filter((customer) => customer.status !== 'deleted').map((customer) => customer.id);
		if (!site.settings.dataRights || active.length === 0) return customers;
		const settled = new Set();
		for (const request of await site.repos.dataRequests.due(iso(), active.length, active))
			if ((await runDeletion(site, request)) && typeof request.customerId === 'string') settled.add(request.customerId);
		if (settled.size === 0) return customers;
		return Promise.all(
			customers.map(async (customer) =>
				settled.has(customer.id)
					? /** @type {Customer} */ ((await site.repos.customers.get(customer.id)) ?? customer)
					: customer,
			),
		);
	};

	/**
	 * Execute one due deletion request (idempotent: the request is closed compare-and-set).
	 * @param {Site} site
	 * @param {Record<string, any>} request
	 * @returns {Promise<boolean>} whether this call completed it
	 */
	const runDeletion = async (site, request) => {
		if (!deletionDue(/** @type {any} */ (request), now())) return false;
		const customer = await site.repos.customers.get(request.customerId);
		if (customer && customer.status !== 'deleted') await executeDeletion(site, customer, 'self_service');
		return site.repos.dataRequests.close(request.id, { status: 'completed', completedAt: iso() });
	};

	/**
	 * Execute the deletions whose cooling-off ended (at most 100 per call) — the dashboard's "Run due deletions" button.
	 * Customers due for deletion are also deleted whenever they are read (`settleDeletion`, `settleDeletions`).
	 * @param {Site} site
	 */
	const runDueDeletions = async (site) => {
		if (!site.settings.dataRights) return 0;
		let deleted = 0;
		for (const request of await site.repos.dataRequests.due(iso(), 100)) if (await runDeletion(site, request)) deleted += 1;
		return deleted;
	};
	// ── Portal-signed privacy operations ──────────────────────────────────────────────────────────────────

	/**
	 * Customer of a Portal privacy subject (`customerId`, `email` or `phone`).
	 * @param {Site} site
	 * @param {Record<string, string> | undefined} subject
	 * @returns {Promise<Customer | null>}
	 */
	const subjectCustomer = async (site, subject) => {
		if (!subject) return null;
		if (typeof subject.customerId === 'string') return site.repos.customers.get(subject.customerId);
		const email = normaliseEmail(subject.email);
		if (email) return site.repos.customers.findBy('email', email);
		const phone = normalisePhone(subject.phone);
		return phone ? site.repos.customers.findBy('phone', phone) : null;
	};

	/**
	 * `POST /v1/data:export` (Portal-signed).
	 * @param {Site} site
	 * @param {{ subject?: Record<string, string> }} input
	 */
	const privacyExport = async (site, { subject }) => {
		if (subject) {
			const customer = await subjectCustomer(site, subject);
			return {
				websiteId: site.websiteId,
				subject,
				exportedAt: iso(),
				data: customer ? await exportCustomer(site, customer) : null,
			};
		}
		const customers = await site.repos.customers.list({ fetchLimit: 10_000, includeDeleted: true });
		return {
			websiteId: site.websiteId,
			exportedAt: iso(),
			customers: customers.map((/** @type {Customer} */ c) => viewOf(site, c)),
		};
	};

	/**
	 * `POST /v1/data:anonymize` (Portal-signed).
	 * @param {Site} site
	 * @param {{ subject?: Record<string, string> }} input
	 */
	const privacyAnonymize = async (site, { subject }) => {
		const customer = await subjectCustomer(site, subject);
		if (!customer) return { websiteId: site.websiteId, anonymized: { customers: 0 } };
		await executeDeletion(site, customer, 'portal');
		return { websiteId: site.websiteId, anonymized: { customers: 1 } };
	};

	// ── account pages, orders, risk, dashboard, identity issuer ───────────────────────────────────────────

	/**
	 * The account view of a signed-in customer (sections the merchant enabled).
	 * @param {Site} site
	 * @param {Customer} customer
	 * @param {Session} session
	 */
	const account = async (site, customer, session) => {
		const cfg = site.settings.accountPages;
		/** @type {string[]} */
		const pages = cfg.pages.filter(
			(/** @type {string} */ page) =>
				(page !== 'consents' || site.settings.consent) && (page !== 'data' || site.settings.dataRights),
		);
		const pending = site.settings.dataRights ? await site.repos.dataRequests.pendingDeletion(customer.id) : null;
		return {
			layout: cfg.layout,
			pages,
			customer: viewOf(site, customer),
			fields: site.settings.profile.fields,
			...(pages.includes('sessions') ? { sessions: await sessions(site, customer.id, session.id) } : {}),
			...(pages.includes('orders')
				? { orders: (await site.repos.orders.forCustomer(customer.id, cfg.orders_limit)).map(orderView) }
				: {}),
			...(pages.includes('consents') ? { consents: (await consents(site, customer)).documents } : {}),
			...(pages.includes('data')
				? {
						data: {
							export: Boolean(site.settings.dataRights?.allow_export),
							delete: Boolean(site.settings.dataRights?.allow_delete),
							pendingDeletion: pending ? requestView(pending) : null,
						},
					}
				: {}),
		};
	};

	/**
	 * Apply an order event (account pages' orders).
	 * @param {Site} site
	 * @param {{ type: string, occurredAt: string, data: Record<string, any> }} event
	 */
	const applyOrderEvent = async (site, event) => {
		const update = orderUpdate(event);
		if (update) await site.repos.orders.upsert(update.orderId, update.set);
		return update !== null;
	};

	/**
	 * Dashboard KPIs.
	 * @param {Site} site
	 */
	const overview = async (site) => {
		const since = new Date(now() - 30 * DAY_MS);
		return {
			customers: await site.repos.customers.count({ status: 'active' }),
			newLast30Days: await site.repos.customers.count({ createdAt: { $gte: since } }),
			signedInLast30Days: await site.repos.customers.count({ lastSignInAt: { $gte: since.toISOString() } }),
			activeSessions: await site.repos.sessions.countActive(iso()),
			pendingDeletions: await site.repos.dataRequests.count({ type: 'delete', status: 'pending' }),
		};
	};

	/**
	 * What to register as the website's identity issuer (the body of the Portal's identity PUTs).
	 * @param {Site} site
	 */
	const registration = (site) => ({
		issuer: issuerOf(site),
		jwksUrl: jwksUrlFor(app.base, site.websiteId),
		audience: audienceOf(site),
		claimMap: { subject: 'sub', email: 'email', phone: 'phone_number' },
	});

	/**
	 * The last issuer request sent to the Portal, when it still matches what would be registered now.
	 * @param {Site} site
	 * @param {ReturnType<typeof registration>} body
	 * @returns {Promise<{ status: string, requestedAt: string } | null>}
	 */
	const lastRequest = async (site, body) => {
		const stored = /** @type {Record<string, any> | null} */ (await site.repos.issuerRequest.get());
		return stored && stored.issuer === body.issuer && stored.jwksUrl === body.jwksUrl && stored.audience === body.audience
			? { status: String(stored.status), requestedAt: String(stored.requestedAt) }
			: null;
	};

	/**
	 * The issuer of a website and how to register it in the Portal.
	 * @param {Site} site
	 */
	const issuer = async (site) => {
		const records = await keysOf(site);
		const published = publishedKeys(records, now(), RETAIN_MS);
		const current = signingKey(records, now());
		const body = registration(site);
		const { issuer: iss, jwksUrl, audience, claimMap } = body;
		return {
			issuer: iss,
			jwksUrl,
			discoveryUrl: `${iss}/.well-known/openid-configuration`,
			audience,
			claimMap,
			algorithm: 'EdDSA',
			keys: published.map((k) => ({ kid: k.kid, activatesAt: iso(k.activatesAt), signing: k === current })),
			registered: site.doc?.identity?.issuer === iss,
			request: await lastRequest(site, body),
			portal: {
				method: 'PUT',
				path: `/v1/merchants/${site.merchantId}/websites/${site.websiteId}/identity`,
				body,
			},
		};
	};

	/**
	 * Ask the Portal to make Signups the website's identity issuer (`PUT /v1/product/websites/:websiteId/identity`
	 * through app-kit). The Portal keeps it pending until the merchant approves (202 `pending`) and answers `active`
	 * once the same issuer is registered, so repeating is safe. The outcome is recorded for the dashboard.
	 * @param {Site} site
	 * @param {{ actor: { type: string, id?: string } }} context
	 * @returns {Promise<Outcome>}
	 */
	const registerIssuer = async (site, { actor }) => {
		if (!requestIssuer) return fail('unavailable', { detail: 'The Portal client is not configured.' });
		const body = registration(site);
		/** @type {{ status: 'pending' | 'active' }} */
		let answer;
		try {
			answer = await requestIssuer({ websiteId: site.websiteId, ...body });
		} catch (error) {
			const { code, details } = /** @type {{ code?: string, details?: { status?: number } }} */ (error);
			log?.warn?.('identity issuer request failed', { websiteId: site.websiteId, code, status: details?.status });
			if (details?.status === 403)
				return fail('forbidden', {
					detail: 'The Portal refused the request (no active subscription, or the manifest lacks identityIssuer).',
				});
			if (details?.status === 429) return fail('rate_limited', { detail: 'The Portal is rate limiting issuer requests.' });
			return fail(code === 'portal_timeout' || code === 'portal_unreachable' ? 'unavailable' : 'upstream_error', {
				detail: 'The Portal could not take the identity issuer request; try again later.',
			});
		}
		const requestedAt = iso();
		await site.repos.issuerRequest.save({
			issuer: body.issuer,
			jwksUrl: body.jwksUrl,
			audience: body.audience,
			status: answer.status,
			requestedAt,
		});
		await audit({
			websiteId: site.websiteId,
			actor,
			action: 'issuer.registration_requested',
			target: { type: 'website', id: site.websiteId },
			after: { issuer: body.issuer, status: answer.status },
		});
		return ok(answer.status === 'pending' ? 202 : 200, {
			status: answer.status,
			registered: answer.status === 'active',
			issuer: body.issuer,
			requestedAt,
		});
	};

	/**
	 * Start a signing-key rotation now (the new key is pre-published first).
	 * @param {Site} site
	 * @param {{ actor: { type: string, id?: string } }} context
	 */
	const rotateKeys = async (site, { actor }) => {
		const records = await site.repos.keys.list('signing');
		if (!records.some((/** @type {{ activatesAt: number }} */ record) => record.activatesAt > now()))
			await createKey(site, records);
		keyCache.delete(site.websiteId);
		await audit({ websiteId: site.websiteId, actor, action: 'issuer.key_rotation_started' });
		return issuer(site);
	};

	/**
	 * On `entitlement.changed@1` (the event that makes it relevant): ask the Portal once to make Signups the website's
	 * issuer, while it is not registered and no request was sent yet for the current issuer configuration (a rejected
	 * request is not repeated on its own; `POST /v1/issuer:register` or the dashboard asks again). Best effort: a
	 * failure is logged and retried on the next entitlement change or from the dashboard.
	 * @param {Site} site
	 * @returns {Promise<number>} 1 when a request was sent
	 */
	const autoRegisterIssuer = async (site) => {
		if (!requestIssuer || !site.settings.enabled('sessions') || site.doc?.identity?.issuer === issuerOf(site)) return 0;
		try {
			if (await lastRequest(site, registration(site))) return 0;
			const outcome = await registerIssuer(site, { actor: { type: 'system', id: 'entitlement_changed' } });
			return outcome.ok ? 1 : 0;
		} catch (error) {
			log?.warn?.('identity issuer request failed', {
				websiteId: site.websiteId,
				error: /** @type {Error} */ (error)?.message,
			});
			return 0;
		}
	};

	return Object.freeze({
		jwks,
		issuer,
		registerIssuer,
		rotateKeys,
		requestChallenge,
		verifyCode,
		consumeLink,
		refresh,
		logout,
		authenticate,
		sessions,
		revokeSession,
		revokeAll,
		createCustomer,
		patchCustomer,
		deleteCustomer,
		viewOf,
		phoneOptions,
		consents,
		acceptConsents,
		exportCustomer,
		createDataRequest,
		downloadExport,
		cancelDataRequest,
		requestView,
		runDueDeletions,
		settleDeletion,
		settleDeletions,
		autoRegisterIssuer,
		privacyExport,
		privacyAnonymize,
		account,
		applyOrderEvent,
		overview,
	});
};

/** @typedef {ReturnType<typeof createSignupsService>} SignupsService */
