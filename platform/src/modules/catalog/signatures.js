/**
 * Bundle-descriptor signatures (Ed25519). Keys are imported and validated with `@ss/protocol` (`toPublicJwk`,
 * `importPublicKey`); the signature itself is a plain WebCrypto Ed25519 verify over the domain-separated signing input
 * of `core/bundle.js`. `signBundle` mirrors it for tests and the developer CLI.
 *
 * TODO(protocol): move `signBundle` / `verifyBundle` into `@ss/protocol` next to the other signed objects.
 * @module
 */
import { importPublicKey, toPublicJwk } from '@ss/protocol';
import { bundleSigningInput } from './core/bundle.js';

/** @typedef {import('@ss/protocol').Signer} Signer */
/** @typedef {import('./core/bundle.js').Descriptor} Descriptor */
/** @typedef {import('./core/bundle.js').BundleSignature} BundleSignature */

/**
 * @param {Signer} signer
 * @param {Descriptor} descriptor
 * @returns {Promise<BundleSignature>}
 */
export const signBundle = async (signer, descriptor) => {
	const sig = await signer.sign(new TextEncoder().encode(bundleSigningInput(descriptor)));
	return { kid: signer.kid, alg: 'EdDSA', sig: Buffer.from(sig).toString('base64url') };
};

/**
 * Verify a descriptor signature under one of `keys` (matched by `kid`).
 * @param {{ descriptor: Descriptor, signature: BundleSignature, keys: ReadonlyArray<unknown> }} input
 * @returns {Promise<boolean>}
 */
export const verifyBundle = async ({ descriptor, signature, keys }) => {
	try {
		const jwk = keys.map((key) => toPublicJwk(key)).find((key) => key.kid === signature.kid);
		if (!jwk) return false;
		const key = await importPublicKey(jwk);
		const sig = Buffer.from(signature.sig, 'base64url');
		if (sig.length !== 64) return false;
		return await globalThis.crypto.subtle.verify(
			{ name: 'Ed25519' },
			key,
			sig,
			new TextEncoder().encode(bundleSigningInput(descriptor)),
		);
	} catch {
		return false;
	}
};
