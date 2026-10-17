/**
 * Fixed limits of Payments (settings-ownership step 1). Each of these was a merchant setting once, or is a rule the
 * gateways set; none is a business choice, so the product owns them and no form offers them. Pure; no I/O.
 * @module
 */

/** The largest proof (a photo or a PDF) a payer may upload for a manual payment, in MB. */
export const PROOF_MAX_MB = 5;

/**
 * The shortest time a gateway's checkout is asked to stay open, in minutes (Stripe takes no less than 30): a caller
 * that names an earlier end, for example an order's payment window, still gets this much on the gateway's page.
 */
export const MIN_CHECKOUT_MINUTES = 30;
