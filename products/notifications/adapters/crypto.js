/**
 * Sealing (PLAN 0.4.8, 0.8.10 D11): the real words of a sensitive message (its codes and links) are kept, only while
 * the message still has attempts to make, sealed with the kit's sealer (`ss2.<keyId>.…`, AES-256-GCM under a key
 * derived from `ENCRYPTION_KEY`, label `notifications`) and bound to the website and the recipient. While the owner
 * changes the key, `ENCRYPTION_KEY_PREVIOUS` still opens them and the Owner's Re-seal (`resealWebsite`) moves them to
 * the new key. Lost `ENCRYPTION_KEY`: a waiting sensitive message no longer opens and fails.
 * @module
 */
import { createSealer as createKitSealer, resealEach } from '@ss/app-kit';

/**
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 * @param {string | null} [previousKey] `ENCRYPTION_KEY_PREVIOUS`, set only while the key changes
 */
export const createSealer = (encryptionKey, previousKey = null) =>
	createKitSealer({ encryptionKey, previousKey, label: 'notifications' });

/** @typedef {import('@ss/app-kit').Sealer} Sealer */

/**
 * What the sealed words of a message are bound to: the website, the channel and the address.
 * @param {string} websiteId @param {string} channel @param {string} address
 */
export const messageAadOf = (websiteId, channel, address) => `message|${websiteId}|${channel}|${address}`;

/**
 * The Owner's Re-seal (RT-14) of one website's merchant database: the sealed words of every message still waiting,
 * sealed again with the current key.
 * @param {Sealer} sealer
 * @param {import('@ss/app-kit').WebsiteData} data
 * @returns {Promise<import('@ss/app-kit').ResealCounts>}
 */
export const resealWebsite = async (sealer, data) => {
	const { websiteId } = data;
	const messages = data.collection('messages');
	const waiting = { websiteId, sealed: { $type: 'string' } };
	const projection = { _id: 0, id: 1, channel: 1, address: 1, sealed: 1, updatedAt: 1 };
	return resealEach(
		sealer,
		(await messages.find(waiting, { projection }).toArray()).map((message) => ({
			sealed: message.sealed,
			aad: messageAadOf(websiteId, message.channel, message.address),
			save: (/** @type {string} */ next) =>
				messages.updateOne(
					{ websiteId, id: message.id, sealed: message.sealed },
					{ $set: { sealed: next, updatedAt: message.updatedAt } },
				),
		})),
	);
};
