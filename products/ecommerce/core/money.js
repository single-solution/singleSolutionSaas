/**
 * Money (PLAN 0.4.13): amounts are integer minor units plus an ISO 4217 currency code. The shop's currency is the
 * `catalog` setting `currency`; no currency, language or country is assumed in code. These are the decimal helpers of
 * gateways, inputs, CSV and sums; text for people is made with the kit's `formatMoney` and the website's Format
 * (PLAN 0.8.10 K7). No I/O.
 * @module
 */

/** Currencies with no minor unit (ISO 4217 exponent 0). */
const ZERO_DECIMAL = new Set([
	'BIF',
	'CLP',
	'DJF',
	'GNF',
	'ISK',
	'JPY',
	'KMF',
	'KRW',
	'PYG',
	'RWF',
	'UGX',
	'UYI',
	'VND',
	'VUV',
	'XAF',
	'XOF',
	'XPF',
]);
/** Currencies with three decimals (ISO 4217 exponent 3). */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** The largest amount (a price, a line or an order total), in minor units (keeps every sum an exact integer). */
export const MAX_AMOUNT = 1_000_000_000_000;

/**
 * True for an ISO 4217-shaped code (three capital letters).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

/**
 * True for an amount in minor units: a whole number from 1 to {@link MAX_AMOUNT}.
 * @param {unknown} value
 * @returns {value is number}
 */
export const isAmount = (value) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_AMOUNT;

/**
 * Decimals of a currency (ISO 4217 exponent; 2 unless listed).
 * @param {string} currency
 */
export const exponentOf = (currency) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

/**
 * Minor units as the decimal text gateways take (`1050`, `PKR` → `10.50`).
 * @param {number} amount
 * @param {string} currency
 */
export const toDecimal = (amount, currency) => {
	const exponent = exponentOf(currency);
	if (exponent === 0) return String(amount);
	const text = String(amount).padStart(exponent + 1, '0');
	return `${text.slice(0, -exponent)}.${text.slice(-exponent)}`;
};

/**
 * A decimal text (`10.5`, `10.50`, `10`) as minor units, or null when it is not a plain positive amount with at most the
 * currency's decimals.
 * @param {unknown} text
 * @param {string} currency
 * @returns {number | null}
 */
export const fromDecimal = (text, currency) => {
	const exponent = exponentOf(currency);
	const value = typeof text === 'number' ? String(text) : typeof text === 'string' ? text.trim() : '';
	const match = /^(\d{1,13})(?:\.(\d+))?$/.exec(value);
	if (!match) return null;
	const fraction = match[2] ?? '';
	if (fraction.length > exponent && !/^0*$/.test(fraction.slice(exponent))) return null;
	const minor = Number(`${match[1]}${fraction.slice(0, exponent).padEnd(exponent, '0')}`);
	return isAmount(minor) ? minor : null;
};

/**
 * True for a price in minor units: a whole number from 0 to {@link MAX_AMOUNT} (0 = free).
 * @param {unknown} value
 * @returns {value is number}
 */
export const isPrice = (value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_AMOUNT;

/**
 * `percent` % of an amount, not rounded (deals rounded once per order, `deals.rounding: total_half_up`).
 * @param {number} amount minor units
 * @param {number} percent 0–100, may have decimals
 */
export const exactPercentOf = (amount, percent) => (amount * Math.min(100, Math.max(0, percent))) / 100;

/**
 * `percent` % of an amount, rounded half up to whole minor units (`percent` may have decimals, 0–100).
 * @param {number} amount minor units
 * @param {number} percent
 */
export const percentOf = (amount, percent) => Math.round(exactPercentOf(amount, percent));

/**
 * Split `total` minor units over parts in proportion to `weights` (largest remainder; the parts add up to `total`).
 * Used to spread an order-level discount over its lines.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export const allocate = (total, weights) => {
	const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
	if (sum <= 0 || total <= 0) return weights.map(() => 0);
	const exact = weights.map((w) => (total * Math.max(0, w)) / sum);
	const parts = exact.map(Math.floor);
	let left = total - parts.reduce((a, b) => a + b, 0);
	const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest);
	for (const { index } of order) {
		if (left <= 0) break;
		parts[index] = /** @type {number} */ (parts[index]) + 1;
		left -= 1;
	}
	return parts;
};

/**
 * The smallest amount Ecommerce computes (PLAN 0.8.10 E25): one whole unit of the currency (100 minor units of PKR)
 * while the website's Format shows whole units, else one minor unit.
 * @param {string} currency
 * @param {boolean} wholeUnits the Format's `wholeUnits`
 */
export const unitOf = (currency, wholeUnits) => (wholeUnits ? 10 ** exponentOf(currency) : 1);

/**
 * An amount rounded down to whole `unit`s (deal discounts and the points' value, E25).
 * @param {number} amount minor units
 * @param {number} [unit]
 */
export const roundDown = (amount, unit = 1) => (unit > 1 ? Math.floor(amount / unit) * unit : Math.floor(amount));

/**
 * An amount rounded half up to whole `unit`s (percentage fees, role discounts and tax, E25).
 * @param {number} amount minor units (may have a fraction)
 * @param {number} [unit]
 */
export const roundHalfUp = (amount, unit = 1) => Math.round(amount / unit + 1e-9) * unit;

/**
 * `allocate` in whole `unit`s: the parts are whole units when `total` is, and add up to `total` (a total that is not a
 * multiple of `unit` leaves its remainder on the largest part).
 * @param {number} total minor units
 * @param {number[]} weights
 * @param {number} [unit]
 * @returns {number[]}
 */
export const allocateUnits = (total, weights, unit = 1) => {
	if (unit <= 1) return allocate(total, weights);
	const whole = Math.floor(total / unit);
	const parts = allocate(whole, weights).map((part) => part * unit);
	const rest = total - whole * unit;
	if (rest > 0 && parts.length > 0) {
		const largest = weights.reduce((best, weight, index) => (weight > (weights[best] ?? 0) ? index : best), 0);
		parts[largest] = /** @type {number} */ (parts[largest]) + rest;
	}
	return parts;
};
