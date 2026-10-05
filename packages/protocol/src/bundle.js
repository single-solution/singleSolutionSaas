/**
 * Element-pack bundle signatures (Ed25519, detached). The developer signs the domain-separated input
 * `ss-pack-bundle.v1.<sha256hex(canonicalJson(descriptor))>`, so a bundle signature can never be confused with any other
 * signed object. The signature travels next to the descriptor as `{ kid, alg: 'EdDSA', sig: <base64url> }`.
 *
 * Byte-compatible with the Portal catalog's former `signatures.js`.
 * @module
 */
import { createProtocolError } from './errors.js';
import { b64url, fromB64url, utf8 } from './encoding.js';
import { importPublicKey, toPublicJwk } from './keys.js';
import { hashManifest } from './registration.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {{ kid: string, alg: 'EdDSA', sig: string }} BundleSignature */

/** Domain-separation prefix of bundle signatures. */
export const BUNDLE_SIGNING_PREFIX = 'ss-pack-bundle.v1.';

/**
 * Bytes (as text) the developer signs: the prefix + SHA-256 (hex) of the canonical JSON descriptor.
 * @param {unknown} descriptor
 * @returns {string}
 */
export const bundleSigningInput = (descriptor) => `${BUNDLE_SIGNING_PREFIX}${hashManifest(descriptor)}`;

/**
 * Sign a bundle descriptor.
 * @param {{ signer: Signer, descriptor: unknown }} params
 * @returns {Promise<BundleSignature>}
 */
export const signBundle = async ({ signer, descriptor }) => {
	if (!signer || typeof signer.sign !== 'function' || typeof signer.kid !== 'string') {
		throw createProtocolError('invalid_argument', 'signer must be { kid, sign }');
	}
	const sig = await signer.sign(utf8(bundleSigningInput(descriptor)));
	return { kid: signer.kid, alg: 'EdDSA', sig: b64url(sig) };
};

/**
 * @param {unknown} value
 * @returns {value is BundleSignature}
 */
const isSignature = (value) => {
	if (typeof value !== 'object' || value === null) return false;
	const { kid, sig, alg } = /** @type {Record<string, unknown>} */ (value);
	return typeof kid === 'string' && typeof sig === 'string' && (alg === undefined || alg === 'EdDSA');
};

/**
 * Verify a descriptor signature. The key is the pinned `publicJwk` (its `kid` must match), one of `keys` (matched by
 * `kid`), or whatever `keyResolver` resolves for the signature's `kid`. Never throws: any problem means `false`.
 * @param {{ descriptor: unknown, signature: unknown, publicJwk?: unknown, keys?: ReadonlyArray<unknown>,
 *   keyResolver?: KeyResolver }} params
 * @returns {Promise<boolean>}
 */
export const verifyBundle = async ({ descriptor, signature, publicJwk, keys, keyResolver }) => {
	try {
		if (!isSignature(signature)) return false;
		const sig = fromB64url(signature.sig);
		if (sig.length !== 64) return false;
		/** @type {CryptoKey | null} */
		let key = null;
		if (publicJwk !== undefined) {
			const jwk = toPublicJwk(publicJwk);
			if (jwk.kid === signature.kid) key = await importPublicKey(jwk);
		} else if (keys !== undefined) {
			const jwk = keys.map((candidate) => toPublicJwk(candidate)).find((candidate) => candidate.kid === signature.kid);
			if (jwk) key = await importPublicKey(jwk);
		} else if (keyResolver) {
			key = await keyResolver.resolve(signature.kid);
		}
		if (!key) return false;
		return await globalThis.crypto.subtle.verify(
			{ name: 'Ed25519' },
			key,
			/** @type {BufferSource} */ (sig),
			/** @type {BufferSource} */ (utf8(bundleSigningInput(descriptor))),
		);
	} catch {
		return false;
	}
};
