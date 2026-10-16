/**
 * Cryptography (node:crypto), the only module that touches key material:
 *
 * - **Sealing** (PLAN 0.4.8): secrets Accounts generates for a website and must read back (its sign-in signing key and
 *   two-step secrets) are kept in the merchant database sealed with the kit's sealer (`ss2.<keyId>.…`, AES-256-GCM
 *   under a key derived from `ENCRYPTION_KEY`, label `accounts`), bound to the website and purpose. While the owner
 *   changes the key, `ENCRYPTION_KEY_PREVIOUS` still opens them and the Owner's Re-seal (`resealWebsite`) moves them to
 *   the new key. Lost `ENCRYPTION_KEY`: the signing key is made again (everyone signs in again) and two-step users
 *   sign in with a recovery code and set two-step up again.
 * - **Hashes**: one-time codes, links and refresh tokens are kept as SHA-256 of high-entropy values (or of the code
 *   with its record id); passwords with scrypt (N=16384, r=8, p=1, 16-byte salt). Imported bcrypt and peppered PBKDF2
 *   hashes are checked too and replaced with scrypt after a good check (PLAN 0.8.10 A1).
 * - **Sign-ins** are compact JWS, `alg: EdDSA`, signed with the website's Ed25519 key.
 * - **TOTP** (RFC 6238) and recovery codes, ported from the Portal's two-step.
 * @module
 */
import { createSealer as createKitSealer, resealEach, sumCounts } from '@ss/app-kit';
import { constantTimeEqual, sha256Hex } from '@ss/protocol';
import bcrypt from 'bcryptjs';
import {
	createHash,
	createHmac,
	createPrivateKey,
	generateKeyPairSync,
	pbkdf2 as pbkdf2Callback,
	randomBytes as nodeRandomBytes,
	scrypt as scryptCallback,
	sign as cryptoSign,
	timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = /** @type {(password: string, salt: Buffer, length: number, options: object) => Promise<Buffer>} */ (
	promisify(scryptCallback)
);
const pbkdf2 = promisify(pbkdf2Callback);

/** @param {number} n */
export const randomBytes = (n) => new Uint8Array(nodeRandomBytes(n));

// ------------------------------------------------------------------------------------------------------- sealing

/**
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 * @param {string | null} [previousKey] `ENCRYPTION_KEY_PREVIOUS`, set only while the key changes
 */
export const createSealer = (encryptionKey, previousKey = null) =>
	createKitSealer({ encryptionKey, previousKey, label: 'accounts' });

/** @typedef {import('@ss/app-kit').Sealer} Sealer */

// ----------------------------------------------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** @param {string} password @returns {Promise<string>} `scrypt$<salt>$<hash>` */
export const hashPassword = async (password) => {
	const salt = nodeRandomBytes(16);
	const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
	return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
};

/** A bcrypt hash (`$2a$`, `$2b$`, `$2y$`, any cost; PLAN 0.8.10 A1). */
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
/** `pbkdf2$<iterations>$<salt>$<hash>`, salt and hash in base64 (PLAN 0.8.10 A1). */
const PBKDF2 = /^pbkdf2\$(\d{1,7})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;
/** Most PBKDF2 iterations a stored hash may ask for (code constant: one check stays under a second). */
const MAX_PBKDF2_ITERATIONS = 2_000_000;

/**
 * Check a password against a stored hash: Accounts' own `scrypt$…`, or a hash imported from another system (A1):
 * bcrypt, or PBKDF2-HMAC-SHA256 of `<pepper>:<password>` (no Unicode normalization on that path; needs the
 * `imported_password_pepper` connection). A hash that cannot be checked takes as long as the dummy check and fails.
 * @param {string} password
 * @param {string} stored
 * @param {{ pepper?: string | null }} [options]
 */
export const verifyPassword = async (password, stored, { pepper = null } = {}) => {
	const [kind, salt, hash] = stored.split('$');
	if (kind === 'scrypt' && salt && hash) {
		const candidate = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), 32, SCRYPT);
		return constantTimeEqual(candidate.toString('base64url'), hash);
	}
	if (BCRYPT.test(stored)) return bcrypt.compare(password, stored);
	const peppered = PBKDF2.exec(stored);
	const iterations = Number(peppered?.[1]);
	if (peppered && pepper && iterations >= 1 && iterations <= MAX_PBKDF2_ITERATIONS) {
		const expected = Buffer.from(String(peppered[3]), 'base64');
		if (expected.length >= 16 && expected.length <= 64) {
			const candidate = await pbkdf2(
				`${pepper}:${password}`,
				Buffer.from(String(peppered[2]), 'base64'),
				iterations,
				expected.length,
				'sha256',
			);
			return timingSafeEqual(candidate, expected);
		}
	}
	return dummyPasswordCheck();
};

/** Accounts' own hash: `scrypt$<16-byte salt>$<32-byte hash>`, base64url. */
const SCRYPT_HASH = /^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

/**
 * Whether `verifyPassword` reads a stored hash (the import check, PLAN 0.8.10 A1): Accounts' own scrypt, bcrypt, or
 * PBKDF2 with 1 to 2,000,000 iterations and a 16- to 64-byte hash. Any other format could never sign in.
 * @param {string} stored
 */
export const isPasswordHash = (stored) => {
	if (SCRYPT_HASH.test(stored) || BCRYPT.test(stored)) return true;
	const peppered = PBKDF2.exec(stored);
	const iterations = Number(peppered?.[1]);
	const length = peppered ? Buffer.from(String(peppered[3]), 'base64').length : 0;
	return iterations >= 1 && iterations <= MAX_PBKDF2_ITERATIONS && length >= 16 && length <= 64;
};

/** Whether a stored hash is not Accounts' own (it is replaced with scrypt after the next good check). @param {string} stored */
export const isImportedHash = (stored) => !stored.startsWith('scrypt$');

/** A password check that takes as long as a real one (unknown users). */
export const dummyPasswordCheck = async () => {
	await scrypt('dummy', Buffer.alloc(16), 32, SCRYPT);
	return false;
};

/** The SHA-1 of a password, upper-case hex (the breached-password range query sends its first 5 characters). @param {string} password */
export const sha1Upper = (password) => createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();

// ---------------------------------------------------------------------------------------------------- sign-ins

/** A new Ed25519 key pair as JWKs. @param {string} kid */
export const generateSigningKey = (kid) => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = /** @type {Record<string, string>} */ (publicKey.export({ format: 'jwk' }));
	const priv = /** @type {Record<string, string>} */ (privateKey.export({ format: 'jwk' }));
	return {
		publicJwk: { kty: 'OKP', crv: 'Ed25519', x: String(pub.x), kid, alg: 'EdDSA', use: 'sig' },
		privateJwk: { kty: 'OKP', crv: 'Ed25519', x: String(priv.x), d: String(priv.d), kid },
	};
};

/** @param {unknown} value */
const b64json = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Sign a JWT with an Ed25519 private JWK.
 * @param {Record<string, string>} privateJwk
 * @param {Record<string, unknown>} claims
 */
export const signJwt = (privateJwk, claims) => {
	const input = `${b64json({ alg: 'EdDSA', typ: 'JWT', kid: privateJwk.kid })}.${b64json(claims)}`;
	const key = createPrivateKey({ key: /** @type {import('node:crypto').JsonWebKey} */ ({ ...privateJwk }), format: 'jwk' });
	return `${input}.${cryptoSign(null, Buffer.from(input), key).toString('base64url')}`;
};

// --------------------------------------------------------------------------------------------------------- TOTP

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** @param {Uint8Array} bytes */
const base32Encode = (bytes) => {
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

/** @param {string} text */
const base32Decode = (text) => {
	/** @type {number[]} */
	const out = [];
	let buffer = 0;
	let bits = 0;
	for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
		const value = BASE32.indexOf(char);
		if (value === -1) return Buffer.alloc(0);
		buffer = ((buffer << 5) | value) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((buffer >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
};

/** @param {Uint8Array} key @param {number} counter */
const hotp = (key, counter) => {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const mac = createHmac('sha1', key).update(message).digest();
	const offset = /** @type {number} */ (mac[mac.length - 1]) & 0x0f;
	return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

/** A new TOTP secret (160 bits, base32). */
export const generateTotpSecret = () => base32Encode(nodeRandomBytes(20));

/** The TOTP code at a time (tests and the docs' example). @param {string} secret @param {number} atMs */
export const totpCode = (secret, atMs) => hotp(base32Decode(secret), Math.floor(atMs / 30_000));

/**
 * Verify a 6-digit code within ±1 step; steps at or before `lastStep` are refused (each code works once).
 * @param {string} secret
 * @param {unknown} code
 * @param {{ now: number, lastStep: number | null }} options
 * @returns {{ ok: true, step: number } | { ok: false }}
 */
export const verifyTotp = (secret, code, { now, lastStep }) => {
	if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return { ok: false };
	const key = base32Decode(secret);
	const current = Math.floor(now / 30_000);
	/** @type {number | null} */
	let matched = null;
	for (let delta = -1; delta <= 1; delta += 1)
		if (constantTimeEqual(hotp(key, current + delta), code.trim()) && matched === null) matched = current + delta;
	if (matched === null || (lastStep !== null && matched <= lastStep)) return { ok: false };
	return { ok: true, step: matched };
};

/** `otpauth://` URI for authenticator apps. @param {{ secret: string, issuer: string, account: string }} input */
export const totpUri = ({ secret, issuer, account }) =>
	`otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${new URLSearchParams({
		secret,
		issuer,
		algorithm: 'SHA1',
		digits: '6',
		period: '30',
	}).toString()}`;

/** @param {string} code */
const recoveryHash = (code) => sha256Hex(`ss-accounts-recovery.v1|${code.toLowerCase().replace(/[\s-]/g, '')}`);

/** 10 recovery codes `xxxxx-xxxxx` (50 bits each): the codes, shown once, and their hashes, stored. */
export const generateRecoveryCodes = () => {
	const codes = Array.from({ length: 10 }, () => {
		const raw = base32Encode(nodeRandomBytes(7)).slice(0, 10).toLowerCase();
		return `${raw.slice(0, 5)}-${raw.slice(5)}`;
	});
	return { codes, hashes: codes.map(recoveryHash) };
};

/**
 * The hash of a recovery code imported from another system (PLAN 0.8.10 A8): SHA-256 hex of `recovery:` and the code
 * without spaces or dashes, in capitals.
 * @param {string} code
 */
const importedRecoveryHash = (code) => sha256Hex(`recovery:${code.replace(/[\s-]/g, '').toUpperCase()}`);

/**
 * A stored recovery code: its hash and format (`v1`, Accounts' own; `sha256_prefixed`, imported, A8).
 * @typedef {{ hash: string, format: 'v1' | 'sha256_prefixed' }} RecoveryItem
 */

/**
 * Index of the stored recovery code matching a code, or -1: Accounts' own format first, then the imported one.
 * @param {unknown} code
 * @param {ReadonlyArray<RecoveryItem>} items
 */
export const matchRecoveryCode = (code, items) => {
	if (typeof code !== 'string' || code.length > 32) return -1;
	const hashes = { v1: recoveryHash(code), sha256_prefixed: importedRecoveryHash(code) };
	let found = -1;
	items.forEach(({ hash, format }, index) => {
		if (found === -1 && format in hashes && constantTimeEqual(hash, hashes[format])) found = index;
	});
	return found;
};

/** What a user's sealed TOTP secret is bound to. @param {string} websiteId @param {string} userId */
export const totpAadOf = (websiteId, userId) => `accounts-totp|${websiteId}|${userId}`;

/** What a website's sealed signing key is bound to. @param {string} websiteId @param {string} kid */
export const keyAadOf = (websiteId, kid) => `accounts-key|${websiteId}|${kid}`;

/** What the sealed values of a kept message are bound to. @param {string} websiteId @param {string} key */
export const outboxAadOf = (websiteId, key) => `accounts-outbox|${websiteId}|${key}`;

/**
 * The Owner's Re-seal (PLAN 0.4.8; RT-14) of one website's merchant database: its sign-in signing key, two-step
 * secrets and kept Forgot-password messages, sealed again with the current key (a user keeps their `updatedAt`). Not
 * re-sealed: two-step setup steps (10 minutes) and a session's last refresh secret (read only within seconds of a
 * renewal, sealed again at the next one); both are gone long before the previous key is removed.
 * @param {Sealer} sealer
 * @param {import('@ss/app-kit').WebsiteData} data
 * @returns {Promise<import('@ss/app-kit').ResealCounts>}
 */
export const resealWebsite = async (sealer, data) => {
	const { websiteId } = data;
	const keys = data.collection('keys');
	const users = data.collection('users');
	const outbox = data.collection('outbox');
	const twoStep = { websiteId, 'twoStep.sealed': { $type: 'string' } };
	return sumCounts([
		await resealEach(
			sealer,
			(await keys.find({ websiteId }, { projection: { _id: 0, kid: 1, sealed: 1 } }).toArray()).map((key) => ({
				sealed: key.sealed,
				aad: keyAadOf(websiteId, key.kid),
				save: (/** @type {string} */ next) =>
					keys.updateOne({ websiteId, kid: key.kid, sealed: key.sealed }, { $set: { sealed: next } }),
			})),
		),
		await resealEach(
			sealer,
			(await users.find(twoStep, { projection: { _id: 0, id: 1, twoStep: 1, updatedAt: 1 } }).toArray()).map((user) => ({
				sealed: user.twoStep.sealed,
				aad: totpAadOf(websiteId, user.id),
				save: (/** @type {string} */ next) =>
					users.updateOne(
						{ websiteId, id: user.id, 'twoStep.sealed': user.twoStep.sealed },
						{ $set: { 'twoStep.sealed': next, updatedAt: user.updatedAt } },
					),
			})),
		),
		await resealEach(
			sealer,
			(await outbox.find({ websiteId }, { projection: { _id: 0, id: 1, key: 1, sealed: 1 } }).toArray()).map((entry) => ({
				sealed: entry.sealed,
				aad: outboxAadOf(websiteId, entry.key),
				save: (/** @type {string} */ next) =>
					outbox.updateOne({ websiteId, id: entry.id, sealed: entry.sealed }, { $set: { sealed: next } }),
			})),
		),
	]);
};

/**
 * Two-step sign-in imported from another system (A8; the importer, Migration): the plain TOTP secret sealed at once,
 * and the source system's recovery-code hashes, each working once.
 * @param {Sealer} sealer
 * @param {{ secret: string, recoveryHashes: ReadonlyArray<string>, aad: string, now: number }} input
 */
export const importedTwoStep = (sealer, { secret, recoveryHashes, aad, now }) => ({
	sealed: sealer.seal(secret.toUpperCase().replace(/[\s=-]/g, ''), aad),
	lastStep: null,
	recovery: recoveryHashes.map((hash) => ({ hash: hash.toLowerCase(), format: /** @type {const} */ ('sha256_prefixed') })),
	enabledAt: new Date(now),
});
