/**
 * Encryption of stored secrets (PLAN 0.4.8): the one sealing format of `@ss/protocol`, `ss2.<keyId>.<iv>.<tag>.<data>`
 * (AES-256-GCM under a key derived from `ENCRYPTION_KEY` and the unit's label; the key id names the key that sealed a
 * value, never the key itself). Each value is bound to where it is stored (`aad`), so a sealed value copied to another
 * website or connection does not open. `ENCRYPTION_KEY` is never stored, logged or sent.
 *
 * While the owner changes the key, the old one is `ENCRYPTION_KEY_PREVIOUS`: values open with the key that sealed them,
 * and the Owner's Re-seal (`reseal.js`) moves them to the new key. Values sealed in the first format (`v1.…`, no key
 * id) still open, with either key.
 *
 * Products use the same sealer for their own secrets, under their own label (`createSealer({ label: 'accounts', … })`).
 * The product's own key and its ticket key are kept sealed too (`sealKey`, `openKey`; K-21), their public keys readable.
 * @module
 */
import { createSealer as createProtocolSealer, legacyV1, toPublicJwk } from '@ss/protocol';
import { resealEach } from './reseal.js';

/**
 * @param {{ encryptionKey: string, previousKey?: string | null, label?: string, legacyInfo?: string,
 *   randomBytes?: (length: number) => Uint8Array }} options `encryptionKey`: `ENCRYPTION_KEY`; `previousKey`:
 *   `ENCRYPTION_KEY_PREVIOUS` (null when not set); `label` and `legacyInfo`: the unit (default the kit's own,
 *   `app-kit` and `ss-app-kit.seal.v1`); a product passes its own, for example `accounts` and `ss-accounts.seal.v1`
 * @returns {Sealer}
 */
export const createSealer = ({
	encryptionKey,
	previousKey = null,
	label = 'app-kit',
	legacyInfo = 'ss-app-kit.seal.v1',
	randomBytes,
}) =>
	createProtocolSealer({
		key: encryptionKey,
		previousKey,
		label,
		legacy: legacyV1(legacyInfo),
		...(randomBytes ? { randomBytes } : {}),
	});

/** @typedef {import('@ss/protocol').Sealer} Sealer */

/**
 * A private signing key as the product database keeps it (PLAN 0.4.8, K-21): the private JWK sealed, with its public
 * JWK readable. Before K-21 the private JWK was kept in clear (`privateJwk`); such a key is still read.
 * @typedef {{ sealed?: string, publicJwk?: Record<string, any>, privateJwk?: Record<string, any> }} StoredKey
 */

/**
 * @param {Sealer} sealer
 * @param {Record<string, any>} privateJwk
 * @param {string} aad where it is kept
 * @returns {StoredKey}
 */
export const sealKey = (sealer, privateJwk, aad) => ({
	sealed: sealer.seal(JSON.stringify(privateJwk), aad),
	publicJwk: toPublicJwk(/** @type {any} */ (privateJwk)),
});

/**
 * The private JWK of a stored key, or null when it does not open (`ENCRYPTION_KEY` lost).
 * @param {Sealer} sealer
 * @param {StoredKey} doc
 * @param {string} aad
 * @returns {Record<string, any> | null}
 */
export const openKey = (sealer, doc, aad) => {
	if (doc.privateJwk) return doc.privateJwk;
	const opened = sealer.open(doc.sealed, aad);
	return opened === null ? null : JSON.parse(opened);
};

/**
 * The Owner's Re-seal of one stored key in the product database's `state` (a key kept in clear is sealed; one replaced
 * meanwhile is left as it is).
 * @param {import('./stores/types.js').Store} store
 * @param {Sealer} sealer
 * @param {string} id
 * @param {string} aad
 * @returns {Promise<import('./reseal.js').ResealCounts>}
 */
export const resealKey = async (store, sealer, id, aad) => {
	const doc = /** @type {StoredKey | null} */ (await store.get('state', id));
	if (!doc) return { resealed: 0, current: 0, unreadable: 0 };
	const unchanged = async () => JSON.stringify(await store.get('state', id)) === JSON.stringify(doc);
	if (doc.privateJwk) {
		if (await unchanged()) await store.put('state', id, sealKey(sealer, doc.privateJwk, aad));
		return { resealed: 1, current: 0, unreadable: 0 };
	}
	return resealEach(sealer, [
		{
			sealed: doc.sealed,
			aad,
			save: async (next) => {
				if (await unchanged()) await store.put('state', id, { ...doc, sealed: next });
			},
		},
	]);
};
