/**
 * Authentication primitives for Portal consoles (staff and merchant users). Identity modules own the user records;
 * this module owns the mechanisms:
 *
 * - **Passwords**: scrypt (N = 2^15, r = 8, p = 1, 64-byte key, 16-byte per-user salt), self-describing hashes
 *   `scrypt$N$r$p$salt$hash`, constant-time verification, a dummy verification for unknown accounts (no user
 *   enumeration by timing) and `needsRehash` for parameter upgrades.
 * - **TOTP** (RFC 6238 over RFC 4226 HOTP, `node:crypto`): base32 secrets, ±1 step window, replay refusal via the
 *   last accepted step; **recovery codes** shown once and stored as HMAC hashes.
 * - **Sessions**: opaque 256-bit tokens, stored only as HMAC-SHA-256(session secret, token); idle + absolute expiry
 *   (TTL index on `expireAt`); rotation on privilege change (new token, old one deleted); revoke one / revoke all.
 *   Cookies are `HttpOnly; Secure; SameSite=Lax; Path=/` with the `__Host-` prefix whenever Secure.
 * - **Login throttling** per account and per IP (Mongo documents with TTL), with progressive account lockouts.
 * - **CSRF** for cookie-authenticated mutations: strict `Sec-Fetch-Site` and `Origin` checks (see `checkCsrf`).
 * @module
 */
import { createHmac, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { platformError } from './errors.js';
import { defaultRandomBytes, hmacHex, randomToken, safeEqual } from './util.js';

/** @typedef {import('./db.js').MutableOps} MutableOps */
/** @typedef {import('./rbac.js').Actor} Actor */

const scrypt =
	/** @type {(password: string | Buffer, salt: Buffer, keylen: number, options: import('node:crypto').ScryptOptions) => Promise<Buffer>} */ (
		promisify(scryptCallback)
	);

// ---------------------------------------------------------------------------------------------------------------
// Passwords

export const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keyLength: 64, saltLength: 16 });
const MAX_PASSWORD_LENGTH = 1024;

/**
 * @param {{ N: number, r: number }} params
 */
const maxmem = ({ N, r }) => 256 * N * r;

/**
 * Hash a password.
 * @param {string} password
 * @param {{ randomBytes?: (n: number) => Uint8Array, params?: Partial<typeof SCRYPT_PARAMS> }} [options]
 * @returns {Promise<string>}
 */
export const hashPassword = async (password, { randomBytes = defaultRandomBytes, params = {} } = {}) => {
	if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
		throw platformError('invalid_argument', `password must be 1..${MAX_PASSWORD_LENGTH} characters`);
	}
	const { N, r, p, keyLength, saltLength } = { ...SCRYPT_PARAMS, ...params };
	const salt = Buffer.from(randomBytes(saltLength));
	const key = await scrypt(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem: maxmem({ N, r }) });
	return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
};

/**
 * @param {string} stored
 * @returns {{ N: number, r: number, p: number, salt: Buffer, key: Buffer } | null}
 */
const parsePasswordHash = (stored) => {
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
	const [N, r, p] = parts.slice(1, 4).map(Number);
	if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
	const n = /** @type {number} */ (N);
	if (n < 2 ** 14 || n > 2 ** 20 || (n & (n - 1)) !== 0 || /** @type {number} */ (r) < 1 || /** @type {number} */ (r) > 32)
		return null;
	if (/** @type {number} */ (p) < 1 || /** @type {number} */ (p) > 16) return null;
	const salt = Buffer.from(/** @type {string} */ (parts[4]), 'base64url');
	const key = Buffer.from(/** @type {string} */ (parts[5]), 'base64url');
	if (salt.length < 16 || key.length < 32) return null;
	return { N: n, r: /** @type {number} */ (r), p: /** @type {number} */ (p), salt, key };
};

/** A valid hash of a random string; used to burn the same time when the account does not exist. */
let dummyHash = /** @type {Promise<string> | undefined} */ (undefined);

/**
 * Verify a password in constant time. With `stored` null/invalid (unknown account), a dummy hash is checked so
 * the response time does not reveal whether the account exists; the result is always false then.
 * @param {string} password
 * @param {string | null | undefined} stored
 * @returns {Promise<boolean>}
 */
export const verifyPassword = async (password, stored) => {
	const parsed = typeof stored === 'string' ? parsePasswordHash(stored) : null;
	const usable = typeof password === 'string' && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
	const target = parsed ?? parsePasswordHash(await (dummyHash ??= hashPassword(randomToken(defaultRandomBytes, 24))));
	const { N, r, p, salt, key } = /** @type {NonNullable<ReturnType<typeof parsePasswordHash>>} */ (target);
	const candidate = await scrypt(usable ? password.normalize('NFKC') : 'x', salt, key.length, {
		N,
		r,
		p,
		maxmem: maxmem({ N, r }),
	});
	return timingSafeEqual(candidate, key) && parsed !== null && usable;
};

/**
 * True when a stored hash uses weaker parameters than the current ones (rehash after a successful login).
 * @param {string} stored
 * @returns {boolean}
 */
export const needsRehash = (stored) => {
	const parsed = parsePasswordHash(stored);
	if (!parsed) return true;
	return parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.key.length < SCRYPT_PARAMS.keyLength;
};

// ---------------------------------------------------------------------------------------------------------------
// TOTP

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32 (upper case, no padding).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const base32Encode = (bytes) => {
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
	return out;
};

/**
 * @param {string} text
 * @returns {Buffer}
 */
export const base32Decode = (text) => {
	const clean = text.toUpperCase().replace(/[\s=-]/g, '');
	/** @type {number[]} */
	const out = [];
	let buffer = 0;
	let bits = 0;
	for (const char of clean) {
		const value = BASE32.indexOf(char);
		if (value === -1) throw platformError('invalid_argument', 'invalid base32');
		buffer = ((buffer << 5) | value) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((buffer >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
};

/** @typedef {'sha1' | 'sha256' | 'sha512'} TotpAlgorithm */

/**
 * HOTP (RFC 4226).
 * @param {Uint8Array} key
 * @param {number} counter
 * @param {{ digits?: number, algorithm?: TotpAlgorithm }} [options]
 * @returns {string}
 */
export const hotp = (key, counter, { digits = 6, algorithm = 'sha1' } = {}) => {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const mac = createHmac(algorithm, key).update(message).digest();
	const offset = /** @type {number} */ (mac[mac.length - 1]) & 0x0f;
	const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
	return String(binary).padStart(digits, '0');
};

/**
 * @typedef {{ step?: number, digits?: number, algorithm?: TotpAlgorithm }} TotpOptions
 */

/**
 * New TOTP secret (160 bits, base32).
 * @param {{ randomBytes?: (n: number) => Uint8Array }} [options]
 */
export const generateTotpSecret = ({ randomBytes = defaultRandomBytes } = {}) => base32Encode(randomBytes(20));

/**
 * TOTP code at a time.
 * @param {string} secret base32
 * @param {number} atMs
 * @param {TotpOptions} [options]
 */
export const totpCode = (secret, atMs, { step = 30, digits = 6, algorithm = 'sha1' } = {}) =>
	hotp(base32Decode(secret), Math.floor(atMs / 1000 / step), { digits, algorithm });

/**
 * Verify a TOTP code within ±`window` steps. Steps at or before `lastStep` are refused (a code is single-use);
 * store the returned `step` as the new `lastStep`.
 * @param {string} secret base32
 * @param {unknown} code
 * @param {TotpOptions & { now?: () => number, window?: number, lastStep?: number | null }} [options]
 * @returns {{ ok: true, step: number } | { ok: false }}
 */
export const verifyTotp = (
	secret,
	code,
	{ now = Date.now, window = 1, lastStep = null, step = 30, digits = 6, algorithm = 'sha1' } = {},
) => {
	if (typeof code !== 'string' || !new RegExp(`^\\d{${digits}}$`).test(code.trim())) return { ok: false };
	const key = base32Decode(secret);
	const current = Math.floor(now() / 1000 / step);
	/** @type {number | null} */
	let matched = null;
	for (let delta = -window; delta <= window; delta += 1) {
		const counter = current + delta;
		// compare every candidate (no early exit) so timing does not reveal which step matched
		if (safeEqual(hotp(key, counter, { digits, algorithm }), code.trim()) && matched === null) matched = counter;
	}
	if (matched === null || (lastStep !== null && matched <= lastStep)) return { ok: false };
	return { ok: true, step: matched };
};

/**
 * `otpauth://` URI for authenticator apps.
 * @param {{ secret: string, issuer: string, account: string, digits?: number, step?: number }} params
 */
export const totpUri = ({ secret, issuer, account, digits = 6, step = 30 }) => {
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
	const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(step) });
	return `otpauth://totp/${label}?${query.toString()}`;
};

/**
 * @param {string} code
 * @param {Uint8Array} secret
 */
export const hashRecoveryCode = (code, secret) => hmacHex(secret, `ss-recovery.v1|${code.toLowerCase().replace(/[\s-]/g, '')}`);

/**
 * Recovery codes: `count` codes of 10 base32 characters (50 bits) formatted `xxxxx-xxxxx`; return the plaintext
 * once (show to the user) and the hashes (store).
 * @param {{ secret: Uint8Array, count?: number, randomBytes?: (n: number) => Uint8Array }} params
 * @returns {{ codes: string[], hashes: string[] }}
 */
export const generateRecoveryCodes = ({ secret, count = 10, randomBytes = defaultRandomBytes }) => {
	const codes = Array.from({ length: count }, () => {
		const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
		return `${raw.slice(0, 5)}-${raw.slice(5)}`;
	});
	return { codes, hashes: codes.map((code) => hashRecoveryCode(code, secret)) };
};

/**
 * Index of the stored hash matching `code`, or -1. Every hash is compared (constant work).
 * @param {unknown} code
 * @param {ReadonlyArray<string>} hashes
 * @param {Uint8Array} secret
 * @returns {number}
 */
export const findRecoveryCode = (code, hashes, secret) => {
	if (typeof code !== 'string' || code.length === 0 || code.length > 64) return -1;
	const candidate = hashRecoveryCode(code, secret);
	let found = -1;
	hashes.forEach((hash, index) => {
		if (safeEqual(candidate, hash) && found === -1) found = index;
	});
	return found;
};

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/** @typedef {'staff' | 'merchant'} SessionKind */

/**
 * @typedef {object} Session
 * @property {string} id stable non-secret identifier (the stored hash) — safe for audit logs and session lists
 * @property {SessionKind} kind
 * @property {string} subject user id
 * @property {string | null} merchantId
 * @property {string[]} roles
 * @property {Array<{ websiteId: string, roles: string[] }>} grants
 * @property {boolean} mfa second factor completed
 * @property {Date} createdAt
 * @property {Date} lastSeenAt
 * @property {Date} expiresAt min(idle expiry, absolute expiry)
 * @property {Date} absoluteExpiresAt
 */

/**
 * @typedef {object} SessionInput
 * @property {SessionKind} kind
 * @property {string} subject
 * @property {string | null} [merchantId]
 * @property {string[]} [roles]
 * @property {Array<{ websiteId: string, roles: string[] }>} [grants]
 * @property {boolean} [mfa]
 * @property {string | null} [ip]
 * @property {string | null} [userAgent]
 */

const TOUCH_INTERVAL_MS = 60_000;

/**
 * @param {Record<string, any>} doc
 * @returns {Session}
 */
const toSession = (doc) =>
	Object.freeze({
		id: String(doc._id),
		kind: doc.kind,
		subject: doc.subject,
		merchantId: doc.merchantId ?? null,
		roles: doc.roles ?? [],
		grants: doc.grants ?? [],
		mfa: doc.mfa === true,
		createdAt: doc.createdAt,
		lastSeenAt: doc.lastSeenAt,
		expiresAt: doc.expireAt,
		absoluteExpiresAt: doc.absoluteExpiresAt,
	});

/**
 * Session store over the `platform_sessions` collection.
 * @param {{ repo: MutableOps, secret: Uint8Array, policies: Record<SessionKind, { idleMs: number, absoluteMs: number }>,
 *   now?: () => number, randomBytes?: (n: number) => Uint8Array }} options
 */
export const createSessions = ({ repo, secret, policies, now = Date.now, randomBytes = defaultRandomBytes }) => {
	if (!secret || secret.length < 32) throw platformError('config_invalid', 'the session secret must be at least 32 bytes');
	/** @param {string} token */
	const idOf = (token) => hmacHex(secret, `ss-session.v1|${token}`);
	/** @param {unknown} token */
	const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

	/**
	 * @param {SessionInput & { createdAt?: Date, absoluteExpiresAt?: Date }} input
	 * @returns {Promise<{ token: string, session: Session }>}
	 */
	const insert = async (input) => {
		const policy = policies[input.kind];
		if (!policy) throw platformError('invalid_argument', `unknown session kind ${input.kind}`);
		if (typeof input.subject !== 'string' || input.subject.length === 0)
			throw platformError('invalid_argument', 'subject is required');
		const t = now();
		const absolute = input.absoluteExpiresAt ?? new Date(t + policy.absoluteMs);
		const token = randomToken(randomBytes, 32);
		const doc = {
			_id: idOf(token),
			kind: input.kind,
			subject: input.subject,
			merchantId: input.merchantId ?? null,
			roles: input.roles ?? [],
			grants: input.grants ?? [],
			mfa: input.mfa === true,
			ip: input.ip ?? null,
			userAgent: input.userAgent ? String(input.userAgent).slice(0, 256) : null,
			createdAt: input.createdAt ?? new Date(t),
			lastSeenAt: new Date(t),
			absoluteExpiresAt: absolute,
			expireAt: new Date(Math.min(t + policy.idleMs, absolute.getTime())),
		};
		await repo.insertOne(doc);
		return { token, session: toSession(doc) };
	};

	/**
	 * @param {unknown} token
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const load = async (token) => {
		if (!validToken(token)) return null;
		const doc = await repo.findOne({ _id: idOf(/** @type {string} */ (token)) });
		if (!doc) return null;
		const t = now();
		if (doc.expireAt.getTime() <= t || doc.absoluteExpiresAt.getTime() <= t) return null;
		return doc;
	};

	return Object.freeze({
		/** Create a session (login). Returns the token to put in the cookie — never stored. */
		create: (/** @type {SessionInput} */ input) => insert(input),
		/**
		 * Resolve a token; extends the idle expiry (at most once a minute).
		 * @param {unknown} token
		 * @returns {Promise<Session | null>}
		 */
		get: async (token) => {
			const doc = await load(token);
			if (!doc) return null;
			const t = now();
			if (t - doc.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
				const policy = /** @type {{ idleMs: number }} */ (policies[/** @type {SessionKind} */ (doc.kind)]);
				const expireAt = new Date(Math.min(t + policy.idleMs, doc.absoluteExpiresAt.getTime()));
				await repo.updateOne({ _id: doc._id }, { $set: { lastSeenAt: new Date(t), expireAt } });
				return toSession({ ...doc, lastSeenAt: new Date(t), expireAt });
			}
			return toSession(doc);
		},
		/**
		 * Replace the session with a new token (privilege change, MFA completion, role change). The absolute expiry
		 * is kept; the old token stops working immediately.
		 * @param {unknown} token
		 * @param {Partial<Pick<SessionInput, 'roles' | 'grants' | 'mfa' | 'merchantId'>>} [changes]
		 * @returns {Promise<{ token: string, session: Session } | null>}
		 */
		rotate: async (token, changes = {}) => {
			const doc = await load(token);
			if (!doc) return null;
			const deleted = await repo.deleteOne({ _id: doc._id });
			if (deleted.deletedCount !== 1) return null; // a concurrent rotation won
			return insert({
				kind: doc.kind,
				subject: doc.subject,
				merchantId: changes.merchantId === undefined ? doc.merchantId : changes.merchantId,
				roles: changes.roles ?? doc.roles,
				grants: changes.grants ?? doc.grants,
				mfa: changes.mfa ?? doc.mfa,
				ip: doc.ip,
				userAgent: doc.userAgent,
				createdAt: doc.createdAt,
				absoluteExpiresAt: doc.absoluteExpiresAt,
			});
		},
		/** @param {unknown} token */
		revoke: async (token) => {
			if (!validToken(token)) return false;
			return (await repo.deleteOne({ _id: idOf(/** @type {string} */ (token)) })).deletedCount === 1;
		},
		/**
		 * Revoke a session by its public id (session list "sign out this device").
		 * @param {string} id
		 * @param {{ kind: SessionKind, subject: string }} owner
		 */
		revokeById: async (id, owner) =>
			(await repo.deleteOne({ _id: id, kind: owner.kind, subject: owner.subject })).deletedCount === 1,
		/**
		 * Revoke every session of a user (password change, compromise, offboarding).
		 * @param {SessionKind} kind
		 * @param {string} subject
		 * @param {{ exceptToken?: string }} [options]
		 * @returns {Promise<number>}
		 */
		revokeAll: async (kind, subject, { exceptToken } = {}) => {
			const filter = { kind, subject, ...(exceptToken && validToken(exceptToken) ? { _id: { $ne: idOf(exceptToken) } } : {}) };
			return (await repo.deleteMany(filter)).deletedCount;
		},
		/**
		 * Active sessions of a user.
		 * @param {SessionKind} kind
		 * @param {string} subject
		 * @returns {Promise<Session[]>}
		 */
		list: async (kind, subject) =>
			(
				await repo
					.find({ kind, subject, expireAt: { $gt: new Date(now()) } })
					.sort({ lastSeenAt: -1 })
					.limit(100)
					.toArray()
			).map(toSession),
	});
};
/** @typedef {ReturnType<typeof createSessions>} Sessions */

/**
 * Cookie name for a session kind (`__Host-` prefix whenever the cookie is Secure).
 * @param {SessionKind} kind
 * @param {boolean} secure
 */
export const sessionCookieName = (kind, secure) => `${secure ? '__Host-' : ''}ss_${kind}`;

/**
 * Serialise a session cookie: `HttpOnly; SameSite=Lax; Path=/` (+ `Secure`).
 * @param {string} name
 * @param {string} value
 * @param {{ maxAgeSeconds?: number, secure: boolean }} options
 */
export const serializeCookie = (name, value, { maxAgeSeconds, secure }) => {
	if (!/^[A-Za-z0-9_-]+$/.test(name.replace(/^__Host-/, '')) || !/^[A-Za-z0-9_-]*$/.test(value)) {
		throw platformError('invalid_argument', 'cookie name/value contains invalid characters');
	}
	return [
		`${name}=${value}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		...(secure ? ['Secure'] : []),
		...(maxAgeSeconds === undefined ? [] : [`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`]),
	].join('; ');
};

/**
 * @param {string} name
 * @param {{ secure: boolean }} options
 */
export const clearCookie = (name, { secure }) => serializeCookie(name, '', { maxAgeSeconds: 0, secure });

/**
 * @param {string | null | undefined} header
 * @param {string} name
 * @returns {string | undefined}
 */
export const readCookie = (header, name) => {
	/** @type {string | undefined} */
	let found;
	for (const part of (header ?? '').split(';')) {
		const index = part.indexOf('=');
		if (index === -1) continue;
		if (part.slice(0, index).trim() === name) {
			if (found !== undefined) return undefined; // duplicates are ambiguous (cookie tossing)
			found = part.slice(index + 1).trim();
		}
	}
	return found;
};

/**
 * Build an RBAC actor from a session (the default `sessionActor` port; identity modules may override it to load
 * live roles).
 * @param {Session} session
 * @returns {Actor}
 */
export const actorFromSession = (session) =>
	session.kind === 'staff'
		? { type: 'staff', id: session.subject, roles: session.roles }
		: {
				type: 'merchant_user',
				id: session.subject,
				roles: session.roles,
				grants: session.grants,
				...(session.merchantId ? { merchantId: session.merchantId } : {}),
			};

// ---------------------------------------------------------------------------------------------------------------
// Login throttling

/**
 * @typedef {object} ThrottlePolicy
 * @property {number} accountMaxFailures failures within `accountWindowMs` that lock the account
 * @property {number} accountWindowMs
 * @property {number} lockMs first lockout; doubles with each consecutive lockout up to `maxLockMs`
 * @property {number} maxLockMs
 * @property {number} ipMaxFailures failures per IP per `ipWindowMs`
 * @property {number} ipWindowMs
 */

export const DEFAULT_THROTTLE = Object.freeze({
	accountMaxFailures: 5,
	accountWindowMs: 15 * 60_000,
	lockMs: 15 * 60_000,
	maxLockMs: 24 * 60 * 60_000,
	ipMaxFailures: 50,
	ipWindowMs: 15 * 60_000,
});

/**
 * Login throttle over `platform_login_throttle`. Accounts and IPs are stored as HMACs only.
 * @param {{ repo: MutableOps, secret: Uint8Array, policy?: Partial<ThrottlePolicy>, now?: () => number }} options
 */
export const createLoginThrottle = ({ repo, secret, policy = {}, now = Date.now }) => {
	const p = { ...DEFAULT_THROTTLE, ...policy };
	/** @param {string} account */
	const accountId = (account) => `a:${hmacHex(secret, `ss-throttle.v1|${account.trim().toLowerCase()}`)}`;
	/**
	 * @param {string} ip
	 * @param {number} t
	 */
	const ipId = (ip, t) => `i:${hmacHex(secret, `ss-throttle.v1|${ip}`)}|${Math.floor(t / p.ipWindowMs)}`;
	const retention = () => new Date(now() + p.maxLockMs + 24 * 60 * 60_000);

	return Object.freeze({
		/**
		 * @param {{ account?: string | null, ip?: string | null }} subject
		 * @returns {Promise<{ allowed: true } | { allowed: false, reason: 'account_locked' | 'ip_throttled', retryAfterSeconds: number }>}
		 */
		check: async ({ account, ip }) => {
			const t = now();
			if (ip) {
				const doc = await repo.findOne({ _id: ipId(ip, t) });
				if (doc && doc.count >= p.ipMaxFailures) {
					const reset = (Math.floor(t / p.ipWindowMs) + 1) * p.ipWindowMs;
					return { allowed: false, reason: 'ip_throttled', retryAfterSeconds: Math.max(1, Math.ceil((reset - t) / 1000)) };
				}
			}
			if (account) {
				const doc = await repo.findOne({ _id: accountId(account) });
				if (doc?.lockedUntil && doc.lockedUntil.getTime() > t) {
					return {
						allowed: false,
						reason: 'account_locked',
						retryAfterSeconds: Math.max(1, Math.ceil((doc.lockedUntil.getTime() - t) / 1000)),
					};
				}
			}
			return { allowed: true };
		},
		/**
		 * Record a failed attempt. Returns whether the account is now locked.
		 * @param {{ account?: string | null, ip?: string | null }} subject
		 * @returns {Promise<{ locked: boolean, retryAfterSeconds?: number }>}
		 */
		recordFailure: async ({ account, ip }) => {
			const t = now();
			if (ip) {
				await repo.updateOne(
					{ _id: ipId(ip, t) },
					{ $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(t + 2 * p.ipWindowMs) } },
					{ upsert: true },
				);
			}
			if (!account) return { locked: false };
			const cutoff = new Date(t - p.accountWindowMs);
			const fresh = { $lt: [{ $ifNull: ['$windowStart', new Date(0)] }, cutoff] };
			const doc = await repo.findOneAndUpdate(
				{ _id: accountId(account) },
				[
					{
						$set: {
							failures: { $cond: [fresh, 1, { $add: [{ $ifNull: ['$failures', 0] }, 1] }] },
							windowStart: { $cond: [fresh, new Date(t), '$windowStart'] },
							lockouts: { $ifNull: ['$lockouts', 0] },
							expireAt: retention(),
						},
					},
				],
				{ upsert: true, returnDocument: 'after' },
			);
			if (!doc || doc.failures < p.accountMaxFailures) return { locked: false };
			const lockMs = Math.min(p.lockMs * 2 ** Number(doc.lockouts ?? 0), p.maxLockMs);
			await repo.updateOne(
				{ _id: doc._id },
				{ $set: { lockedUntil: new Date(t + lockMs), failures: 0, windowStart: new Date(t) }, $inc: { lockouts: 1 } },
			);
			return { locked: true, retryAfterSeconds: Math.ceil(lockMs / 1000) };
		},
		/**
		 * Clear the account's failures and lockout history after a successful login.
		 * @param {{ account: string }} subject
		 */
		recordSuccess: async ({ account }) => {
			await repo.deleteOne({ _id: accountId(account) });
		},
	});
};
/** @typedef {ReturnType<typeof createLoginThrottle>} LoginThrottle */

// ---------------------------------------------------------------------------------------------------------------
// CSRF

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF check for cookie-authenticated requests. Safe methods pass. Mutations must come from the Portal's own
 * origin:
 * - `Sec-Fetch-Site`, when sent (every current browser), must be `same-origin`;
 * - `Origin`, when sent, must equal the canonical Portal origin exactly (`null` is refused);
 * - a mutation with neither header is refused (browsers always send at least one; scripts must send `Origin`).
 * Combined with `SameSite=Lax` cookies and JSON-only bodies, this needs no token.
 * @param {{ method: string, headers: Headers, allowedOrigin: string }} params
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export const checkCsrf = ({ method, headers, allowedOrigin }) => {
	if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };
	const site = headers.get('sec-fetch-site');
	const origin = headers.get('origin');
	if (site === null && origin === null) return { ok: false, reason: 'missing_origin' };
	if (site !== null && site.trim().toLowerCase() !== 'same-origin') return { ok: false, reason: 'cross_site' };
	if (origin !== null && origin.trim().toLowerCase() !== allowedOrigin.toLowerCase())
		return { ok: false, reason: 'origin_mismatch' };
	return { ok: true };
};
