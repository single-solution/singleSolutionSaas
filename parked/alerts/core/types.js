/**
 * Alert types and the decision "does this change fire this subscription?" (pure). Ported and generalised from
 * ibrahimMobiles `shouldSendStockAlert` (packages/shared/src/stockAlerts.ts):
 *
 * - `back_in_stock` — the target went from not available to available (quantity above the in-stock threshold);
 * - `price_drop` — the target is (or became) cheaper and is now at or below the shopper's reference price: their target
 *   price, else the price when they subscribed minus the minimum drop (percent and/or amount, at least one minor unit);
 *   with `requiresStock` only while available;
 * - `availability` — a slot / capacity waitlist: like back-in-stock, but only as many waiters as there are free units
 *   (× notify-per-unit) are notified, in waitlist order;
 * - `custom:<key>` — a merchant-defined type fired by a `custom.*` event (and an optional rules@1 condition).
 *
 * Money is integer minor units with an ISO-4217 currency; a price in another currency never fires a price alert.
 * @module
 */

export const BUILT_IN_TYPES = Object.freeze(/** @type {const} */ (['back_in_stock', 'price_drop', 'availability']));
const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** @typedef {{ amount: number, currency: string }} Money */
/** @typedef {{ itemId: string, variantId?: string | null }} Target */
/**
 * State of a target as the product knows it (`undefined` fields are unknown).
 * @typedef {{ quantity?: number, available?: boolean, price?: Money }} TargetState
 */
/**
 * @typedef {object} Threshold shopper-chosen price-drop condition
 * @property {number | null} [targetAmount] notify at or below this amount (minor units)
 * @property {number | null} [percent] minimum drop in percent of the reference price
 * @property {number | null} [amount] minimum drop in minor units
 */
/**
 * @typedef {object} TypeSettings
 * @property {boolean} backInStock
 * @property {boolean} priceDrop
 * @property {boolean} availability
 * @property {number} minDropPercent
 * @property {number} minDropAmount
 * @property {boolean} allowTarget
 * @property {boolean} requiresStock
 * @property {Array<{ key: string, name?: string, event: string, target_field?: string, when?: string,
 *   allow_customer_actor?: boolean, notify?: 'all' | 'capacity', capacity_field?: string }>} customTypes
 */

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export const isId = (value) => typeof value === 'string' && ID.test(value);

/**
 * Key of a custom type: `custom:<key>`.
 * @param {string} key
 */
export const customType = (key) => `custom:${key}`;

/**
 * The custom key of a type (`custom:restock_vip` → `restock_vip`), else null.
 * @param {string} type
 * @returns {string | null}
 */
export const customKeyOf = (type) => (type.startsWith('custom:') && CUSTOM_KEY.test(type.slice(7)) ? type.slice(7) : null);

/**
 * Types enabled for a website, in display order.
 * @param {TypeSettings} settings
 * @returns {string[]}
 */
export const enabledTypes = (settings) => [
	...(settings.backInStock ? ['back_in_stock'] : []),
	...(settings.priceDrop ? ['price_drop'] : []),
	...(settings.availability ? ['availability'] : []),
	...settings.customTypes.filter((type) => CUSTOM_KEY.test(type.key)).map((type) => customType(type.key)),
];

/**
 * @param {string} type
 * @param {TypeSettings} settings
 */
export const isTypeEnabled = (type, settings) => enabledTypes(settings).includes(type);

/**
 * Matching key of a target: `<itemId>|<variantId>` (`<itemId>|` = the item as a whole, any variant).
 * @param {Target} target
 */
export const targetKeyOf = ({ itemId, variantId }) => `${itemId}|${variantId ?? ''}`;

/**
 * Keys of the subscriptions a change of `target` concerns: the exact target and, for a variant, its item as a whole.
 * @param {Target} target
 * @returns {string[]}
 */
export const matchingKeys = (target) =>
	target.variantId ? [targetKeyOf(target), targetKeyOf({ itemId: target.itemId })] : [targetKeyOf(target)];

/**
 * @param {unknown} value
 * @returns {value is Money}
 */
export const isMoney = (value) =>
	typeof value === 'object' &&
	value !== null &&
	Number.isSafeInteger(/** @type {Money} */ (value).amount) &&
	/** @type {Money} */ (value).amount >= 0 &&
	typeof (/** @type {Money} */ (value).currency) === 'string' &&
	/^[A-Z]{3}$/.test(/** @type {Money} */ (value).currency);

/**
 * Availability from a quantity and the in-stock threshold (strictly above the threshold).
 * @param {number | undefined} quantity
 * @param {number} threshold
 * @returns {boolean | undefined}
 */
export const availableFrom = (quantity, threshold) => (typeof quantity === 'number' ? quantity > threshold : undefined);

/**
 * Units free for an availability waitlist (null when unknown).
 * @param {TargetState} state
 * @param {number} threshold
 * @returns {number | null}
 */
export const freeUnits = (state, threshold) =>
	typeof state.quantity === 'number' ? Math.max(0, Math.floor(state.quantity - threshold)) : null;

/**
 * The amount at or below which a price-drop subscription fires (null when no reference is known).
 * @param {{ threshold?: Threshold | null, priceAtSubscribe?: Money | null }} subscription
 * @param {TargetState} before
 * @param {{ minDropPercent: number, minDropAmount: number, allowTarget: boolean }} settings
 * @returns {{ amount: number, currency: string } | null}
 */
export const priceReference = (subscription, before, settings) => {
	const base = subscription.priceAtSubscribe ?? before.price ?? null;
	const threshold = subscription.threshold ?? {};
	if (settings.allowTarget && typeof threshold.targetAmount === 'number' && threshold.targetAmount > 0) {
		const currency = base?.currency ?? null;
		return currency ? { amount: threshold.targetAmount, currency } : null;
	}
	if (!base || !(base.amount > 0)) return null;
	const percent = Math.max(settings.minDropPercent, typeof threshold.percent === 'number' ? threshold.percent : 0);
	const amount = Math.max(settings.minDropAmount, typeof threshold.amount === 'number' ? threshold.amount : 0);
	const drop = Math.max(1, Math.ceil((base.amount * percent) / 100), amount);
	return { amount: base.amount - drop, currency: base.currency };
};

/**
 * Whether a change (before → after) fires a subscription.
 * @param {{ type: string, threshold?: Threshold | null, priceAtSubscribe?: Money | null }} subscription
 * @param {TargetState} before
 * @param {TargetState} after
 * @param {TypeSettings} settings
 * @returns {boolean}
 */
export const shouldFire = (subscription, before, after, settings) => {
	if (subscription.type === 'back_in_stock' || subscription.type === 'availability')
		return after.available === true && before.available !== true;
	if (subscription.type !== 'price_drop') return false;
	if (!after.price || !(after.price.amount > 0)) return false;
	if (settings.requiresStock && after.available === false) return false;
	const reference = priceReference(subscription, before, settings);
	if (!reference || reference.currency !== after.price.currency) return false;
	const cheaper =
		(before.price !== undefined &&
			before.price.currency === after.price.currency &&
			after.price.amount < before.price.amount) ||
		(before.price === undefined && subscription.priceAtSubscribe !== undefined && subscription.priceAtSubscribe !== null) ||
		(settings.requiresStock && before.available === false && after.available === true);
	return cheaper && after.price.amount <= reference.amount;
};

/**
 * Drop of a price in percent of a reference (rounded down; 0 when not a drop).
 * @param {Money | null | undefined} from
 * @param {Money | null | undefined} to
 */
export const dropPercent = (from, to) =>
	from && to && from.currency === to.currency && from.amount > 0 && to.amount < from.amount
		? Math.floor(((from.amount - to.amount) * 100) / from.amount)
		: 0;
