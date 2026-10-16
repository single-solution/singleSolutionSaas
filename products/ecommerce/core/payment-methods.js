/**
 * Payment methods (fixed-choices E2, E8; owner answer 2, 2026-10-15): the merchant's own list of the ways shoppers pay,
 * like Shopify's manual payment methods, the one place a merchant chooses them (the `payment_methods` list of the
 * Checkout feature). Each method has a key (stored on its orders), the name shoppers, staff, invoices, reports and Chat
 * read, and a kind. Only the kind is fixed, with the same names Payments uses for its manual methods:
 *
 * - `gateway`: paid online through Payments (offered while Payments is connected);
 * - `pay_first`: paid before the order goes on, for example a bank transfer: through Payments (`via: payments`: Payments'
 *   manual method of the same key holds its accounts, instructions and proof upload, and Payments confirms the
 *   payment) or by hand (`via: manual`: the method holds its own accounts and instructions, the shopper may send a
 *   proof and staff record the payment). Each bank account so lives in one place only: Payments' method, or this one;
 * - `on_delivery`: paid when the order is delivered (cash or card at the door), with an optional advance and the
 *   returned-packages rule;
 * - `at_pickup`: paid when the shopper collects the order, with the same options.
 *
 * Every method may have a note shown when it is chosen, a fee (a percent of the order total or of the goods), a
 * largest order, and whether it is offered for delivered and for picked-up orders; `active` off keeps a method but
 * offers it no more. An account is label/value rows (any country's bank details, a wallet number …) with an optional
 * currency: shoppers see the accounts of the shop's currency, else those without one. The list starts with today's four
 * methods. Money staff record and refunds name a method of the list, `other` (with a reference), or `payments` (taken
 * or given back through Payments). Pure functions, no I/O.
 * @module
 */
import { isObject } from '@ss/contracts/util';

/** The kinds of payment methods (Payments' manual methods use the same names). */
export const PAYMENT_KINDS = Object.freeze(/** @type {const} */ (['gateway', 'pay_first', 'on_delivery', 'at_pickup']));
/** @typedef {typeof PAYMENT_KINDS[number]} PaymentKind */
/** Kinds paid after the order is placed: when it is delivered or collected (never with digital items). */
export const PAY_LATER_KINDS = Object.freeze(/** @type {PaymentKind[]} */ (['on_delivery', 'at_pickup']));
/** The way of a payment or refund entry made through Payments (never a method key). */
export const VIA_PAYMENTS = 'payments';
/** The way of money staff record that is none of the merchant's methods (with a reference). */
export const OTHER_WAY = 'other';

/** Engine caps of the list (code constants). */
const METHOD_LIMITS = Object.freeze({
	methods: 20,
	accounts: 10,
	rows: 12,
	name: 60,
	note: 500,
	instructions: 1000,
	label: 60,
	value: 120,
});

/** A method key: lowercase letters, digits and `_`, starting with a letter (it is stored on orders). */
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * True for a text shaped like a method key (not `payments` or `other`, which money entries use).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isMethodKey = (value) =>
	typeof value === 'string' && KEY.test(value) && value !== VIA_PAYMENTS && value !== OTHER_WAY;

/** The rows a new bank account starts with: what bank transfers in most countries ask for (the merchant renames them). */
export const BANK_ROW_LABELS = Object.freeze([
	'Account holder',
	'Bank',
	'Account number',
	'Routing number',
	'Sort code',
	'Branch code',
	'IBAN',
	'SWIFT/BIC',
]);

/** @typedef {{ label: string, value: string }} AccountRow */
/** @typedef {{ label: string, currency: string, rows: AccountRow[] }} Account */
/**
 * One payment method of the list (every field present once checked).
 * @typedef {object} PaymentMethodRecord
 * @property {string} key
 * @property {string} name
 * @property {PaymentKind} kind
 * @property {boolean} active offered for new orders
 * @property {string} note shown when the shopper chooses it
 * @property {string} instructions paid by hand ({@link paidByHand}): how to pay, shown with its accounts
 * @property {boolean} delivery offered for delivered orders
 * @property {boolean} pickup offered for picked-up orders
 * @property {number} maxOrderValue the largest order it pays, minor units (0 = no limit)
 * @property {number} feePercent added to the order (0–20)
 * @property {'order_total' | 'goods_after_discounts'} feeBase what the fee is a percent of
 * @property {number} advanceAmount pay later: an advance paid first, minor units (wins over the percent)
 * @property {number} advancePercent pay later: the advance as a percent of the total, rounded up
 * @property {'payments' | 'manual'} advanceVia pay later: the advance is paid through Payments or recorded by staff
 * @property {number} rtoThreshold pay later: a customer with this many packages returned to the shop is flagged (0 = never)
 * @property {boolean} rtoRequireAdvance pay later: flagged customers use it only with the advance
 * @property {'payments' | 'manual'} via `pay_first`: through Payments' manual method of the same key, or by hand
 * @property {boolean} proof shoppers may send a proof of what they pay by hand (a transfer, an advance)
 * @property {Account[]} accounts paid by hand: where to pay
 */

/** Every field's value when a method leaves it out, by kind. @param {PaymentKind} kind @returns {Omit<PaymentMethodRecord, 'key' | 'name' | 'kind'>} */
const defaultsOf = (kind) => ({
	active: true,
	note: '',
	instructions: '',
	delivery: kind !== 'at_pickup',
	pickup: kind !== 'on_delivery',
	maxOrderValue: 0,
	feePercent: 0,
	feeBase: 'order_total',
	advanceAmount: 0,
	advancePercent: 0,
	advanceVia: 'payments',
	rtoThreshold: kind === 'on_delivery' ? 2 : 0,
	rtoRequireAdvance: true,
	via: 'payments',
	proof: true,
	accounts: [],
});

/** The fields only some kinds use (others keep their defaults). */
const PAY_LATER_FIELDS = Object.freeze(['advanceAmount', 'advancePercent', 'advanceVia', 'rtoThreshold', 'rtoRequireAdvance']);
const HAND_FIELDS = Object.freeze(['instructions', 'accounts']);

/**
 * True when shoppers pay something of a method by hand, so it shows its own instructions and accounts: a method paid
 * first by hand, or a method paid later whose advance staff record.
 * @param {Pick<PaymentMethodRecord, 'kind' | 'via' | 'advanceVia'>} method
 */
export const paidByHand = (method) =>
	method.kind === 'pay_first'
		? method.via === 'manual'
		: PAY_LATER_KINDS.includes(method.kind) && method.advanceVia === 'manual';

/**
 * A new account of a method paid first by hand: the usual bank rows, empty (the merchant renames, fills and removes them).
 * @returns {Account}
 */
export const newAccount = () => ({ label: '', currency: '', rows: BANK_ROW_LABELS.map((label) => ({ label, value: '' })) });

/**
 * The list before the merchant saves one: today's four methods — paid online through Payments, a bank transfer through
 * Payments (its accounts are Payments' own `bank_transfer` method's), cash on delivery (customers with 2 returned
 * packages pay the advance) and paid at pickup.
 * @returns {PaymentMethodRecord[]}
 */
export const defaultPaymentMethods = () => [
	{ key: 'online', name: 'Online payment', kind: 'gateway', ...defaultsOf('gateway') },
	{ key: 'bank_transfer', name: 'Bank transfer', kind: 'pay_first', ...defaultsOf('pay_first') },
	{ key: 'cod', name: 'Cash on delivery', kind: 'on_delivery', ...defaultsOf('on_delivery') },
	{ key: 'pickup', name: 'Pay at pickup', kind: 'at_pickup', ...defaultsOf('at_pickup') },
];

/** @param {unknown} value @param {number} max */
const isWhole = (value, max) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

/**
 * Check the whole list (a dashboard or `PUT /v1/lists/payment_methods` save) and fill what each method leaves out with
 * its kind's defaults; the fields a kind does not use are set to their defaults. Every error with its path.
 * @param {unknown} value
 * @returns {{ ok: true, value: PaymentMethodRecord[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkPaymentMethods = (value) => {
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	/** @param {string} path @param {string} message */
	const fail = (path, message) => errors.push({ path, message });
	if (!Array.isArray(value)) return { ok: false, errors: [{ path: '', message: 'Send a list of payment methods.' }] };
	if (value.length > METHOD_LIMITS.methods) fail('', `At most ${METHOD_LIMITS.methods} payment methods.`);
	/** @param {unknown} given @param {number} max @param {string} path @param {string} what @param {boolean} [required] */
	const text = (given, max, path, what, required = false) => {
		if ((given === undefined || given === null) && !required) return '';
		if (typeof given !== 'string') return (fail(path, `${what} is text.`), '');
		const trimmed = given.trim();
		if (required && trimmed === '') fail(path, `${what} is needed.`);
		if (trimmed.length > max) fail(path, `${what} has at most ${max} characters.`);
		return trimmed;
	};
	/** @type {Set<string>} */
	const keys = new Set();
	const methods = value.map((item, index) => {
		const at = `/${index}`;
		if (!isObject(item)) return (fail(at, 'A payment method is an object.'), null);
		const method = /** @type {Record<string, unknown>} */ (item);
		const key = typeof method.key === 'string' ? method.key.trim() : '';
		if (!isMethodKey(key))
			fail(
				`${at}/key`,
				'The key is lowercase letters, digits and _ (starting with a letter, at most 40), and not payments or other.',
			);
		else if (keys.has(key)) fail(`${at}/key`, `The key ${key} is used twice.`);
		keys.add(key);
		const kind = /** @type {readonly unknown[]} */ (PAYMENT_KINDS).includes(method.kind)
			? /** @type {PaymentKind} */ (method.kind)
			: (fail(`${at}/kind`, `The kind is ${PAYMENT_KINDS.join(', ')}.`), 'gateway');
		const base = defaultsOf(kind);
		/** @template T @param {string} field @param {(given: unknown) => boolean} ok @param {string} message @returns {T} */
		const read = (field, ok, message) => {
			const given = method[field];
			if (given === undefined) return /** @type {any} */ (base)[field];
			if (!ok(given)) fail(`${at}/${field}`, message);
			return /** @type {any} */ (given);
		};
		const bool = (/** @type {unknown} */ given) => typeof given === 'boolean';
		/** @param {ReadonlyArray<string>} values */
		const oneOf = (values) => (/** @type {unknown} */ given) => values.includes(/** @type {string} */ (given));
		const accounts = method.accounts ?? [];
		if (!Array.isArray(accounts)) fail(`${at}/accounts`, 'accounts is a list.');
		else if (accounts.length > METHOD_LIMITS.accounts) fail(`${at}/accounts`, `At most ${METHOD_LIMITS.accounts} accounts.`);
		/** @type {PaymentMethodRecord} */
		const record = {
			key,
			name: text(method.name, METHOD_LIMITS.name, `${at}/name`, 'The name', true),
			kind,
			active: read('active', bool, 'active is true or false.'),
			note: text(method.note, METHOD_LIMITS.note, `${at}/note`, 'The note'),
			instructions: text(method.instructions, METHOD_LIMITS.instructions, `${at}/instructions`, 'The instructions'),
			delivery: read('delivery', bool, 'delivery is true or false.'),
			pickup: read('pickup', bool, 'pickup is true or false.'),
			maxOrderValue: read('maxOrderValue', (v) => isWhole(v, 1e12), 'The largest order is a whole amount in minor units.'),
			feePercent: read(
				'feePercent',
				(v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20,
				'The fee is a percent from 0 to 20.',
			),
			feeBase: read(
				'feeBase',
				oneOf(['order_total', 'goods_after_discounts']),
				'feeBase is order_total or goods_after_discounts.',
			),
			advanceAmount: read('advanceAmount', (v) => isWhole(v, 1e12), 'The advance is a whole amount in minor units.'),
			advancePercent: read('advancePercent', (v) => isWhole(v, 100), 'The advance percent is a whole number from 0 to 100.'),
			advanceVia: read('advanceVia', oneOf(['payments', 'manual']), 'advanceVia is payments or manual.'),
			rtoThreshold: read('rtoThreshold', (v) => isWhole(v, 100), 'The returned packages are a whole number from 0 to 100.'),
			rtoRequireAdvance: read('rtoRequireAdvance', bool, 'rtoRequireAdvance is true or false.'),
			via: read('via', oneOf(['payments', 'manual']), 'via is payments or manual.'),
			proof: read('proof', bool, 'proof is true or false.'),
			accounts: (Array.isArray(accounts) ? accounts : []).map((entry, a) => {
				const where = `${at}/accounts/${a}`;
				if (!isObject(entry)) return (fail(where, 'An account is an object.'), { label: '', currency: '', rows: [] });
				const account = /** @type {Record<string, unknown>} */ (entry);
				const currency = account.currency === undefined || account.currency === null ? '' : account.currency;
				if (currency !== '' && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)))
					fail(`${where}/currency`, 'The currency is a 3-letter ISO 4217 code, or empty for any currency.');
				const rows = account.rows ?? [];
				if (!Array.isArray(rows)) fail(`${where}/rows`, 'rows is a list.');
				else if (rows.length > METHOD_LIMITS.rows) fail(`${where}/rows`, `At most ${METHOD_LIMITS.rows} rows.`);
				return {
					label: text(account.label, METHOD_LIMITS.label, `${where}/label`, 'The account name'),
					currency: typeof currency === 'string' ? currency : '',
					rows: (Array.isArray(rows) ? rows : []).map((row, r) => {
						const path = `${where}/rows/${r}`;
						if (!isObject(row)) return (fail(path, 'A row is { label, value }.'), { label: '', value: '' });
						const { label, value: rowValue } = /** @type {Record<string, unknown>} */ (row);
						return {
							label: text(label, METHOD_LIMITS.label, `${path}/label`, 'The row label', true),
							value: text(rowValue, METHOD_LIMITS.value, `${path}/value`, 'The row value'),
						};
					}),
				};
			}),
		};
		// what the kind does not use keeps its default
		const unused = [
			...(PAY_LATER_KINDS.includes(kind) ? [] : PAY_LATER_FIELDS),
			...(kind === 'pay_first' ? [] : ['via']),
			// only what is paid by hand has its own accounts and instructions; through Payments they are Payments' manual
			// method's (one place for each account)
			...(paidByHand(record) ? [] : HAND_FIELDS),
		];
		for (const field of unused) /** @type {any} */ (record)[field] = /** @type {any} */ (base)[field];
		if (PAY_LATER_KINDS.includes(kind) && !record.delivery && !record.pickup)
			fail(`${at}/delivery`, 'A method paid later is offered for delivered orders, picked-up orders or both.');
		return record;
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: /** @type {PaymentMethodRecord[]} */ (methods) };
};

/**
 * The accounts shoppers see for a currency: those in that currency, else those for any currency; only the rows with a
 * value, and only accounts with at least one.
 * @param {PaymentMethodRecord} method @param {string} currency
 * @returns {Account[]}
 */
export const accountsFor = (method, currency) => {
	const filled = method.accounts
		.map((account) => ({ ...account, rows: account.rows.filter((row) => row.value !== '') }))
		.filter((account) => account.rows.length > 0);
	const own = filled.filter((account) => account.currency === currency);
	return own.length > 0 ? own : filled.filter((account) => account.currency === '');
};

/**
 * What a shopper reads to pay a `pay_first` method by hand: its instructions and the accounts for the currency; `ready`
 * once either tells them how to pay.
 * @param {PaymentMethodRecord} method @param {string} currency
 * @returns {{ ready: boolean, name: string, instructions: string, accounts: Account[] }}
 */
export const payFirstDetails = (method, currency) => {
	const accounts = accountsFor(method, currency);
	return {
		ready: method.instructions !== '' || accounts.length > 0,
		name: method.name,
		instructions: method.instructions,
		accounts,
	};
};

// ------------------------------------------------------------------------------------------------ paid later

/** @param {unknown} value */
const whole = (value) => (Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0);

/**
 * The advance a method paid later takes first: the flat amount wins, else the percent rounded up; at most the total.
 * @param {number} total minor units
 * @param {Pick<PaymentMethodRecord, 'advanceAmount' | 'advancePercent'>} method
 * @param {number} [unit] whole units: the percent rounds up to them (E25)
 */
export const advanceOf = (total, method, unit = 1) => {
	if (total <= 0) return 0;
	const flat = whole(method.advanceAmount);
	if (flat > 0) return Math.min(flat, total);
	const percent = Math.min(100, whole(method.advancePercent));
	return percent > 0 ? Math.min(total, Math.ceil((total * percent) / 100 / unit - 1e-9) * unit) : 0;
};

/**
 * A method's fee: `feePercent` (0–20) of the amount it is taken on, rounded half up.
 * @param {number} total minor units, before the fee
 * @param {Pick<PaymentMethodRecord, 'feePercent'>} method
 * @param {number} [unit] whole units (E25)
 */
export const methodFee = (total, method, unit = 1) => {
	const percent = Math.min(20, Math.max(0, Number(method.feePercent ?? 0)));
	return percent > 0 && total > 0 ? Math.round((total * percent) / 100 / unit + 1e-9) * unit : 0;
};

/**
 * True when a customer's returned packages reach the threshold (0 = never).
 * @param {number} rtoCount @param {number} threshold
 */
export const isRtoFlagged = (rtoCount, threshold) => whole(threshold) > 0 && whole(rtoCount) >= whole(threshold);

/**
 * Whether an order may be paid later with a method, and the advance it pays first.
 * @param {{ total: number, rtoCount: number, canCollectAdvance: boolean, unit?: number }} input `canCollectAdvance`:
 *   Payments is connected (or the method's advances are recorded by staff), so an advance can be paid
 * @param {Pick<PaymentMethodRecord, 'maxOrderValue' | 'advanceAmount' | 'advancePercent' | 'rtoThreshold' | 'rtoRequireAdvance'>} method
 * @returns {{ ok: true, advance: number, flagged: boolean } | { ok: false, reason: 'over_max' | 'advance_unavailable', flagged: boolean }}
 */
export const payLaterDecision = ({ total, rtoCount, canCollectAdvance, unit = 1 }, method) => {
	const flagged = isRtoFlagged(rtoCount, method.rtoThreshold);
	const max = whole(method.maxOrderValue);
	if (max > 0 && total > max) return { ok: false, reason: 'over_max', flagged };
	const advance = advanceOf(total, method, unit);
	if (flagged && method.rtoRequireAdvance && (advance <= 0 || !canCollectAdvance))
		return { ok: false, reason: 'advance_unavailable', flagged };
	// without a way to take the advance the order is paid in full later
	return { ok: true, advance: canCollectAdvance ? advance : 0, flagged };
};

// --------------------------------------------------------------------------------------------- at checkout

/**
 * @typedef {{ method: string, name: string, kind: PaymentKind, available: boolean, reason: string | null,
 *   advance: number, fee: number }} PaymentOption `reason` when not available: `needs_delivery`, `needs_pickup`,
 *   `digital_items`, `over_max`, `advance_unavailable`, `not_ready`; `fee`: what choosing it adds
 */

/**
 * The payment methods a cart may use, in the list's order: the active ones a shop can take — online and through
 * Payments while Payments is connected, at pickup while there is a pickup point — each available or with why not: not
 * for this way of getting the order (delivered, picked up, or neither for digital items and services), digital items
 * with a method paid later, over its largest order, a flagged customer without an advance, or a method paid first
 * whose details are not given yet (`ready`).
 * @param {object} input
 * @param {ReadonlyArray<PaymentMethodRecord>} input.methods the `payment_methods` list
 * @param {boolean} input.paymentsConnected
 * @param {boolean} input.pickupPossible store pickup is offered (pickup locations)
 * @param {'delivery' | 'pickup' | 'none'} input.deliveryMethod
 * @param {boolean} input.digital the cart has digital items
 * @param {number} input.total before any fee
 * @param {(base: PaymentMethodRecord['feeBase']) => number} [input.feeBase] the amount a fee is a percent of (default `total`)
 * @param {number} input.rtoCount the shopper's returned packages
 * @param {(method: PaymentMethodRecord) => boolean} [input.ready] a method paid first can tell shoppers how to pay
 * @param {number} [input.unit] whole units (E25)
 * @returns {PaymentOption[]}
 */
export const paymentOptions = ({
	methods,
	paymentsConnected,
	pickupPossible,
	deliveryMethod,
	digital,
	total,
	feeBase = () => total,
	rtoCount,
	ready = () => true,
	unit = 1,
}) =>
	methods
		.filter(
			(method) =>
				method.active &&
				(method.kind === 'gateway' || (method.kind === 'pay_first' && method.via === 'payments')
					? paymentsConnected
					: true) &&
				(method.kind === 'at_pickup' ? pickupPossible : true),
		)
		.map((method) => {
			const later = PAY_LATER_KINDS.includes(method.kind);
			const option = { method: method.key, name: method.name, kind: method.kind };
			/** @param {string} reason @param {number} [fee] @returns {PaymentOption} */
			const no = (reason, fee = 0) => ({ ...option, available: false, reason, advance: 0, fee });
			const elsewhere = method.delivery ? 'needs_delivery' : 'needs_pickup';
			if (deliveryMethod === 'none' && later) return no(elsewhere);
			if (deliveryMethod === 'delivery' && !method.delivery) return no('needs_pickup');
			if (deliveryMethod === 'pickup' && !method.pickup) return no('needs_delivery');
			if (digital && later) return no('digital_items');
			const fee = methodFee(feeBase(method.feeBase), method, unit);
			if (later) {
				const decision = payLaterDecision(
					{
						total: total + fee,
						rtoCount,
						canCollectAdvance: paymentsConnected || method.advanceVia === 'manual',
						unit,
					},
					method,
				);
				return decision.ok
					? { ...option, available: true, reason: null, advance: decision.advance, fee }
					: no(decision.reason, fee);
			}
			const max = whole(method.maxOrderValue);
			if (max > 0 && total + fee > max) return no('over_max', fee);
			if (method.kind === 'pay_first' && !ready(method)) return no('not_ready', fee);
			return { ...option, available: true, reason: null, advance: 0, fee };
		});
