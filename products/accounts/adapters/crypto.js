/**
 * Cryptography (node:crypto), the only module that touches key material:
 *
 * - **Sealing** (PLAN 0.4.8): secrets Accounts generates for a website and must read back (its sign-in signing key and
 *   two-step secrets) are kept in the merchant database encrypted with AES-256-GCM under a key derived (HKDF-SHA256)
 *   from `ENCRYPTION_KEY`, bound to the website and purpose. Lost or changed `ENCRYPTION_KEY`: the signing key is made
 *   again (everyone signs in again) and two-step users use a recovery code.
 * - **Hashes**: one-time codes, links and refresh tokens are kept as SHA-256 of high-entropy values (or of the code
 *   with its record id); passwords with scrypt (N=16384, r=8, p=1, 16-byte salt).
 * - **Sign-ins** are compact JWS, `alg: EdDSA`, signed with the website's Ed25519 key.
 * - **TOTP** (RFC 6238) and recovery codes, ported from the Portal's two-step.
 * @module
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	hkdfSync,
	randomBytes as nodeRandomBytes,
	scrypt as scryptCallback,
	sign as cryptoSign,
	timingSafeEqual,
	verify as cryptoVerify,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = /** @type {(password: string, salt: Buffer, length: number, options: object) => Promise<Buffer>} */ (
	promisify(scryptCallback)
);

/** @param {number} n */
export const randomBytes = (n) => new Uint8Array(nodeRandomBytes(n));

/** A URL-safe random secret of `bytes` bytes. @param {number} [bytes] */
export const randomSecret = (bytes = 32) => nodeRandomBytes(bytes).toString('base64url');

/** SHA-256 hex. @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** @param {string} a @param {string} b */
export const safeEqual = (a, b) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

// ------------------------------------------------------------------------------------------------------- sealing

/**
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 */
export const createSealer = (encryptionKey) => {
	const key = Buffer.from(hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), 'ss-accounts.seal.v1', 32));
	return Object.freeze({
		/** @param {string} plaintext @param {string} aad */
		seal: (plaintext, aad) => {
			const iv = nodeRandomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			cipher.setAAD(Buffer.from(aad, 'utf8'));
			const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
		},
		/**
		 * @param {unknown} sealed
		 * @param {string} aad
		 * @returns {string | null} null when it cannot be opened (another key, tampered)
		 */
		open: (sealed, aad) => {
			if (typeof sealed !== 'string') return null;
			const [version, iv, tag, data, extra] = sealed.split('.');
			if (version !== 'v1' || !iv || !tag || data === undefined || extra !== undefined) return null;
			try {
				const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
				decipher.setAAD(Buffer.from(aad, 'utf8'));
				decipher.setAuthTag(Buffer.from(tag, 'base64url'));
				return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createSealer>} Sealer */

// ----------------------------------------------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** @param {string} password @returns {Promise<string>} `scrypt$<salt>$<hash>` */
export const hashPassword = async (password) => {
	const salt = nodeRandomBytes(16);
	const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
	return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
};

/** @param {string} password @param {string} stored */
export const verifyPassword = async (password, stored) => {
	const [kind, salt, hash] = stored.split('$');
	if (kind !== 'scrypt' || !salt || !hash) return false;
	const candidate = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), 32, SCRYPT);
	return safeEqual(candidate.toString('base64url'), hash);
};

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
		if (safeEqual(hotp(key, current + delta), code.trim()) && matched === null) matched = current + delta;
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
const recoveryHash = (code) => sha256(`ss-accounts-recovery.v1|${code.toLowerCase().replace(/[\s-]/g, '')}`);

/** 10 recovery codes `xxxxx-xxxxx` (50 bits each): the codes, shown once, and their hashes, stored. */
export const generateRecoveryCodes = () => {
	const codes = Array.from({ length: 10 }, () => {
		const raw = base32Encode(nodeRandomBytes(7)).slice(0, 10).toLowerCase();
		return `${raw.slice(0, 5)}-${raw.slice(5)}`;
	});
	return { codes, hashes: codes.map(recoveryHash) };
};

/**
 * Index of the stored hash matching a recovery code, or -1.
 * @param {unknown} code
 * @param {ReadonlyArray<string>} hashes
 */
export const matchRecoveryCode = (code, hashes) => {
	if (typeof code !== 'string' || code.length > 32) return -1;
	const hash = recoveryHash(code);
	let found = -1;
	hashes.forEach((stored, index) => {
		if (safeEqual(stored, hash) && found === -1) found = index;
	});
	return found;
};

/**
 * Verify a compact EdDSA JWS against public JWKs (by `kid`) and return its claims, or null. Header-borne keys and
 * `crit` are refused.
 * @param {unknown} token
 * @param {ReadonlyArray<Record<string, string>>} keys
 * @returns {Record<string, unknown> | null}
 */
export const verifyJwt = (token, keys) => {
	if (typeof token !== 'string' || token.length > 8192) return null;
	const parts = token.split('.');
	if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
	const [h, p, s] = /** @type {[string, string, string]} */ (parts);
	try {
		const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
		const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
		if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
		if (header.alg !== 'EdDSA' || ['jwk', 'jku', 'x5u', 'x5c', 'crit'].some((name) => Object.hasOwn(header, name))) return null;
		const jwk = keys.find((key) => key.kid === header.kid);
		if (!jwk) return null;
		const key = createPublicKey({
			key: /** @type {import('node:crypto').JsonWebKey} */ ({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }),
			format: 'jwk',
		});
		return cryptoVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')) ? claims : null;
	} catch {
		return null;
	}
};
