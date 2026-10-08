/**
 * Loyalty rules (owner: promotions; stub until built): how many points an order earns, what points are worth at
 * checkout, how many may be redeemed and when earned points expire, from the `loyalty` settings. Checkout and orders
 * call these; the ledger moves the points. No I/O.
 * @module
 */

/**
 * Points an order earns when it is delivered.
 * @param {{ total: number, delivery: number, tax: number }} totals minor units
 * @param {Record<string, any>} settings the `loyalty` settings
 * @returns {number}
 */
export const pointsToEarn = (totals, settings) => (settings && totals ? 0 : 0);

/**
 * What `points` take off at checkout, in minor units.
 * @param {number} points
 * @param {Record<string, any>} settings
 * @returns {number}
 */
export const pointsValue = (points, settings) => (settings ? 0 * points : 0);

/**
 * The most points a shopper may redeem on an order.
 * @param {{ balance: number, payable: number }} input `payable`: the order total before points, minor units
 * @param {Record<string, any>} settings
 * @returns {number}
 */
export const maxRedeemable = ({ balance }, settings) => (settings ? 0 * balance : 0);

/**
 * When points earned now expire (null = never).
 * @param {number} now epoch ms
 * @param {Record<string, any>} settings
 * @returns {Date | null}
 */
export const expiryFor = (now, settings) => (settings && now ? null : null);
