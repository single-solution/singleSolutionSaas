/**
 * The website's payment methods as checkout, orders and the health checks read them (fixed-choices E2, E8): the
 * `payment_methods` list, and what a method paid first tells shoppers. One paid through Payments shows Payments' manual
 * method of the same key (`GET /v1/manual-methods?currency=`, read at most every 5 minutes per website): its
 * instructions and the accounts for the shop's currency, offered once Payments says it is ready; one paid by hand
 * shows its own. A bank account so lives in one place only.
 * @module
 */
import { paidByHand, payFirstDetails } from '../core/payment-methods.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/payment-methods.js').PaymentMethodRecord} PaymentMethodRecord */
/** @typedef {import('../core/payment-methods.js').Account} Account */
/**
 * What a shopper reads to pay a method first: its name, instructions and accounts; `ready` once they tell how to pay.
 * @typedef {{ ready: boolean, name: string, instructions: string, accounts: Account[] }} PayDetails
 */

/** Payments' manual methods are read at most this often per website. */
const PAYMENTS_METHODS_MS = 5 * 60_000;

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : '');
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * Payments' answer as details by method key.
 * @param {unknown} body
 * @returns {Map<string, PayDetails>}
 */
const detailsByKey = (body) =>
	new Map(
		list(typeof body === 'object' && body !== null ? /** @type {{ methods?: unknown }} */ (body).methods : null)
			.filter((method) => typeof method?.key === 'string')
			.map((method) => [
				method.key,
				{
					ready: method.ready === true,
					name: text(method.name),
					instructions: text(method.instructions),
					accounts: list(method.accounts).map((account) => ({
						label: text(account?.label),
						currency: text(account?.currency),
						rows: list(account?.rows).map((row) => ({ label: text(row?.label), value: text(row?.value) })),
					})),
				},
			]),
	);

/**
 * @param {Product} product
 * @param {{ now: () => number }} clock
 */
export const createPaymentMethods = (product, clock) => {
	/** Payments' manual methods per website (null: Payments did not answer). @type {Map<string, { at: number, value: Map<string, PayDetails> | null }>} */
	const cache = new Map();

	/**
	 * Payments' manual methods for the shop's currency by key; null when Payments does not answer.
	 * @param {Site} s
	 */
	const fromPayments = async (s) => {
		const now = clock.now();
		const cached = cache.get(s.websiteId);
		if (cached && now - cached.at < PAYMENTS_METHODS_MS) return cached.value;
		const answer = await product
			.callProduct(s.websiteId, 'payments', `/v1/manual-methods?currency=${encodeURIComponent(s.currency)}`, {
				method: 'GET',
			})
			.catch(() => /** @type {const} */ ({ ok: false }));
		// a Payments without manual methods (switched off) has none ready
		const value = answer.ok ? (answer.status === 200 ? detailsByKey(answer.body) : new Map()) : null;
		cache.set(s.websiteId, { at: now, value });
		return value;
	};

	/**
	 * The website's payment methods (the list, or today's four before it is saved).
	 * @param {Site} s
	 * @returns {Promise<PaymentMethodRecord[]>}
	 */
	const methodsOf = async (s) => /** @type {PaymentMethodRecord[]} */ (await s.list('payment_methods'));

	/**
	 * What each active method paid first tells shoppers, by key: through Payments, Payments' method of the same key (not
	 * ready while Payments has none; left out while Payments does not answer, so the method stays offered as before); by
	 * hand, its own instructions and accounts for the shop's currency, also for a method paid later whose advance is paid
	 * by hand.
	 * @param {Site} s @param {ReadonlyArray<PaymentMethodRecord>} methods
	 * @param {boolean} paymentsConnected
	 * @returns {Promise<Map<string, PayDetails>>}
	 */
	const payDetails = async (s, methods, paymentsConnected) => {
		const first = methods.filter((method) => method.active && (method.kind === 'pay_first' || paidByHand(method)));
		/** @type {Map<string, PayDetails>} */
		const out = new Map();
		const viaPayments = first.some((method) => method.via === 'payments');
		const payments = viaPayments && paymentsConnected ? await fromPayments(s) : null;
		for (const method of first) {
			if (paidByHand(method)) out.set(method.key, payFirstDetails(method, s.currency));
			else if (payments) {
				const found = payments.get(method.key);
				out.set(
					method.key,
					found ? { ...found, name: method.name } : { ready: false, name: method.name, instructions: '', accounts: [] },
				);
			}
		}
		return out;
	};

	return Object.freeze({ methodsOf, payDetails });
};

/** @typedef {ReturnType<typeof createPaymentMethods>} PaymentMethods */
