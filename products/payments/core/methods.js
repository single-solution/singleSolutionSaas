/**
 * Manual payment methods (fixed-choices P1, P2): the merchant's own list of ways to pay outside a gateway, like Shopify's
 * manual payment methods. Each method has a key, a name, a kind, details shown when payers choose it, instructions shown
 * after, whether payers may upload a proof, and the accounts to pay into. Only the kind is fixed, and the same kind
 * names are used by every unit: `gateway` (an online gateway, not a manual method), `pay_first` (the payer pays first,
 * for example a bank transfer, and may send a proof), `on_delivery` (paid when the order is delivered) and `at_pickup`
 * (paid when the order is picked up). An account is label/value rows (any country's bank details, a wallet number, a
 * payment ID …) with an optional currency: payers see the accounts of the payment's currency, else those without one.
 * The list is seeded with today's bank transfer and its eight bank rows, proof upload off (it needs the merchant's
 * storage; the merchant turns it on per method). No I/O.
 * @module
 */
import { GATEWAYS } from './gateways.js';

/** The kinds of manual methods. */
export const METHOD_KINDS = Object.freeze(/** @type {const} */ (['pay_first', 'on_delivery', 'at_pickup']));

/** Every kind of payment method: an online gateway, or a manual method's kind. */
export const PAYMENT_KINDS = Object.freeze(/** @type {const} */ (['gateway', ...METHOD_KINDS]));

/** @typedef {typeof METHOD_KINDS[number]} MethodKind */
/** @typedef {typeof PAYMENT_KINDS[number]} PaymentKind */
/** @typedef {{ label: string, value: string }} AccountRow */
/** @typedef {{ label: string, currency: string, rows: AccountRow[] }} Account */
/**
 * @typedef {{ key: string, name: string, kind: MethodKind, details: string, instructions: string, proof: boolean,
 *   accounts: Account[] }} ManualMethod
 */

/** Engine caps of the list (code constants). */
export const METHOD_LIMITS = Object.freeze({
	methods: 20,
	accounts: 10,
	rows: 12,
	name: 60,
	details: 500,
	instructions: 1000,
	label: 60,
	value: 120,
});

/** A method key: lowercase letters, digits and `_`, starting with a letter (it is stored on payments). */
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

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

/**
 * The list before the merchant saves one: today's bank transfer (pay first, proof upload off until the merchant turns it
 * on with storage connected) with one account of the eight bank rows, empty, so it is offered once the merchant fills
 * them in or writes instructions.
 * @returns {ManualMethod[]}
 */
export const defaultMethods = () => [
	{
		key: 'bank_transfer',
		name: 'Bank transfer',
		kind: 'pay_first',
		details: '',
		instructions: '',
		proof: false,
		accounts: [{ label: '', currency: '', rows: BANK_ROW_LABELS.map((label) => ({ label, value: '' })) }],
	},
];

/**
 * True when a payment's `gateway` may name a manual method (its key shape, and not a gateway id).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isMethodKey = (value) =>
	typeof value === 'string' && KEY.test(value) && !(/** @type {readonly string[]} */ (GATEWAYS).includes(value));

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the whole list (a dashboard or `PUT /v1/lists/manual_methods` save): every error with its path.
 * @param {unknown} value
 * @returns {{ ok: true, value: ManualMethod[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkMethods = (value) => {
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	/** @param {string} path @param {string} message */
	const fail = (path, message) => errors.push({ path, message });
	if (!Array.isArray(value)) return { ok: false, errors: [{ path: '/value', message: 'Send a list of methods.' }] };
	if (value.length > METHOD_LIMITS.methods) fail('/value', `At most ${METHOD_LIMITS.methods} methods.`);
	/**
	 * @param {unknown} text @param {number} max @param {string} path @param {string} what
	 * @param {boolean} [required]
	 */
	const text = (text, max, path, what, required = false) => {
		if (text === undefined && !required) return '';
		if (typeof text !== 'string') return (fail(path, `${what} is text.`), '');
		const trimmed = text.trim();
		if (required && trimmed === '') fail(path, `${what} is needed.`);
		if (trimmed.length > max) fail(path, `${what} has at most ${max} characters.`);
		return trimmed;
	};
	/** @type {Set<string>} */
	const keys = new Set();
	const methods = value.map((item, index) => {
		const at = `/value/${index}`;
		if (!isObject(item)) return (fail(at, 'A method is an object.'), null);
		const method = /** @type {Record<string, unknown>} */ (item);
		const key = typeof method.key === 'string' ? method.key.trim() : '';
		if (!isMethodKey(key))
			fail(
				`${at}/key`,
				'The key is lowercase letters, digits and _ (starting with a letter, at most 40), and not a gateway id.',
			);
		else if (keys.has(key)) fail(`${at}/key`, `The key ${key} is used twice.`);
		keys.add(key);
		const kind = /** @type {readonly unknown[]} */ (METHOD_KINDS).includes(method.kind)
			? /** @type {MethodKind} */ (method.kind)
			: (fail(`${at}/kind`, `The kind is ${METHOD_KINDS.join(', ')}.`), 'pay_first');
		if (method.proof !== undefined && typeof method.proof !== 'boolean') fail(`${at}/proof`, 'proof is true or false.');
		const accounts = method.accounts ?? [];
		if (!Array.isArray(accounts)) fail(`${at}/accounts`, 'accounts is a list.');
		else if (accounts.length > METHOD_LIMITS.accounts) fail(`${at}/accounts`, `At most ${METHOD_LIMITS.accounts} accounts.`);
		return {
			key,
			name: text(method.name, METHOD_LIMITS.name, `${at}/name`, 'The name', true),
			kind,
			details: text(method.details, METHOD_LIMITS.details, `${at}/details`, 'The details'),
			instructions: text(method.instructions, METHOD_LIMITS.instructions, `${at}/instructions`, 'The instructions'),
			proof: method.proof === true,
			accounts: (Array.isArray(accounts) ? accounts : []).map((entry, a) => {
				const where = `${at}/accounts/${a}`;
				if (!isObject(entry)) return (fail(where, 'An account is an object.'), { label: '', currency: '', rows: [] });
				const account = /** @type {Record<string, unknown>} */ (entry);
				const currency = account.currency === undefined || account.currency === '' ? '' : account.currency;
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
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: /** @type {ManualMethod[]} */ (methods) };
};

/**
 * The accounts payers see for a currency: those in that currency, else those for any currency; only the rows with a
 * value, and only accounts with at least one.
 * @param {ManualMethod} method
 * @param {string} currency
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
 * Whether a method is offered for a currency: one paid on delivery or at pickup always is; one paid first only when
 * payers are told how to pay (an account for the currency, or instructions). `missing` names what to add.
 * @param {ManualMethod} method
 * @param {string | null} currency null: any currency (an account in any currency counts)
 * @returns {{ ready: boolean, missing: Array<'account'> }}
 */
export const methodReady = (method, currency) => {
	if (method.kind !== 'pay_first' || method.instructions !== '') return { ready: true, missing: [] };
	const has =
		currency === null
			? method.accounts.some((account) => account.rows.some((row) => row.value !== ''))
			: accountsFor(method, currency).length > 0;
	return has ? { ready: true, missing: [] } : { ready: false, missing: ['account'] };
};

/**
 * A method as payers and the merchant's server see it for a currency: its words, whether it is ready, and the matching
 * accounts (rows with a value only).
 * @param {ManualMethod} method
 * @param {string | null} currency null: every account with a value
 */
export const methodView = (method, currency) => ({
	key: method.key,
	name: method.name,
	kind: method.kind,
	details: method.details,
	instructions: method.instructions,
	proof: method.proof,
	...methodReady(method, currency),
	accounts:
		currency === null
			? method.accounts
					.map((account) => ({ ...account, rows: account.rows.filter((row) => row.value !== '') }))
					.filter((account) => account.rows.length > 0)
			: accountsFor(method, currency),
});
