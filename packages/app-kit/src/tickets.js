/**
 * Tickets for admin widgets (PLAN 0.4.5). The product signs them with its own ticket key, generated on first use and
 * kept in the product database (`state/ticketKey`), its private part sealed with `ENCRYPTION_KEY` (PLAN 0.4.8, K-21).
 * The key is published nowhere, because only this product verifies its tickets. A key that no longer opens
 * (`ENCRYPTION_KEY` lost) is replaced: tickets last 15 minutes and the admin widgets ask for new ones.
 * @module
 */
import { createKeyResolver, createSigner, generateSigningKey, issueTicket, toPublicJwk, verifyTicket } from '@ss/protocol';
import { openKey, resealKey, sealKey } from './sealing.js';

/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('@ss/protocol').TicketClaims} TicketClaims */

/** What the sealed ticket key is bound to. */
const KEY_AAD = 'state|ticketKey';

/**
 * @param {{ store: Store, productId: string, sealer: import('./sealing.js').Sealer, now: () => number,
 *   randomBytes: (length: number) => Uint8Array }} options
 */
export const createTickets = ({ store, productId, sealer, now, randomBytes }) => {
	/** @type {Promise<{ signer: import('@ss/protocol').Signer, resolver: import('@ss/protocol').KeyResolver }> | null} */
	let loaded = null;

	const load = () => {
		loaded ??= (async () => {
			const doc = await store.get('state', 'ticketKey');
			let privateJwk = doc ? openKey(sealer, doc, KEY_AAD) : null;
			if (!privateJwk) {
				// none yet, or it does not open: one new key (the first writer wins, so instances agree)
				if (doc) await store.deleteWhere('state', { sealed: doc.sealed });
				const made = await generateSigningKey({ kid: `${productId}-ticket` });
				await store.insert('state', 'ticketKey', sealKey(sealer, made.privateJwk, KEY_AAD));
				privateJwk = openKey(sealer, /** @type {Record<string, any>} */ (await store.get('state', 'ticketKey')), KEY_AAD);
				if (!privateJwk) throw new Error('the ticket key could not be stored');
			}
			return {
				signer: createSigner(/** @type {any} */ (privateJwk)),
				resolver: createKeyResolver({ jwks: { keys: [toPublicJwk(/** @type {any} */ (privateJwk))] }, now }),
			};
		})().catch((error) => {
			loaded = null;
			throw error;
		});
		return loaded;
	};

	return Object.freeze({
		/** The Owner's Re-seal of the ticket key (RT-14). */
		resealKey: () => resealKey(store, sealer, 'ticketKey', KEY_AAD),
		/**
		 * @param {{ websiteId: string, user: { id: string, name: string, email: string }, origin: string,
		 *   permissions: string[], tokenId: string }} input
		 * @returns {Promise<{ ticket: string, expiresAt: string }>}
		 */
		issue: async (input) => {
			const { signer } = await load();
			const { ticket, expiresAt } = await issueTicket({ signer, productId, ...input, now, randomBytes });
			return { ticket, expiresAt };
		},
		/**
		 * @param {{ ticket: string, origin: string | null, isRevoked: (tid: string) => Promise<boolean> }} input
		 * @returns {Promise<TicketClaims>} throws `invalid_token`
		 */
		verify: async ({ ticket, origin, isRevoked }) => {
			const { resolver } = await load();
			return verifyTicket({ ticket, keyResolver: resolver, productId, origin, isRevoked, now });
		},
	});
};
