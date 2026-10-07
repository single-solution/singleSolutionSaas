/**
 * Tickets for admin widgets (PLAN 0.4.5). The product signs them with its own ticket key, generated on first use and
 * kept in the product database (`state/ticketKey`); the key is published nowhere, because only this product verifies
 * its tickets.
 * @module
 */
import { createKeyResolver, createSigner, generateSigningKey, issueTicket, toPublicJwk, verifyTicket } from '@ss/protocol';

/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('@ss/protocol').TicketClaims} TicketClaims */

/**
 * @param {{ store: Store, productId: string, now: () => number, randomBytes: (length: number) => Uint8Array }} options
 */
export const createTickets = ({ store, productId, now, randomBytes }) => {
	/** @type {Promise<{ signer: import('@ss/protocol').Signer, resolver: import('@ss/protocol').KeyResolver }> | null} */
	let loaded = null;

	const load = () => {
		loaded ??= (async () => {
			let doc = await store.get('state', 'ticketKey');
			if (!doc) {
				const { privateJwk } = await generateSigningKey({ kid: `${productId}-ticket` });
				await store.insert('state', 'ticketKey', { privateJwk });
				doc = /** @type {Record<string, any>} */ (await store.get('state', 'ticketKey'));
			}
			return {
				signer: createSigner(doc.privateJwk),
				resolver: createKeyResolver({ jwks: { keys: [toPublicJwk(doc.privateJwk)] }, now }),
			};
		})().catch((error) => {
			loaded = null;
			throw error;
		});
		return loaded;
	};

	return Object.freeze({
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
