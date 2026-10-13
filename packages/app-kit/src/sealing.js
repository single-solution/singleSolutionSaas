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
 * @module
 */
import { createSealer as createProtocolSealer, legacyV1 } from '@ss/protocol';

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
