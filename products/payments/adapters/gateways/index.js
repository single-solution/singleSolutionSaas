/**
 * The gateway adapters by id (PLAN 0.8.7), behind the common interface of `./types.js`. Bank transfer has no adapter:
 * its page shows the merchant's bank details and the merchant confirms receipt.
 * @module
 */
import { easypaisa } from './easypaisa.js';
import { createGeneric } from './generic.js';
import { jazzcash } from './jazzcash.js';
import { payfast } from './payfast.js';
import { paypal } from './paypal.js';
import { stripe } from './stripe.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */

/**
 * @param {import('@ss/net').OutboundPolicy} [policy] the outbound policy for addresses the merchant enters (generic)
 * @returns {Readonly<Record<'stripe' | 'paypal' | 'payfast' | 'jazzcash' | 'easypaisa' | 'generic', GatewayAdapter>>}
 */
export const createAdapters = (policy) =>
	Object.freeze({ stripe, paypal, payfast, jazzcash, easypaisa, generic: createGeneric(policy) });

export { genericCurrencies } from './generic.js';
