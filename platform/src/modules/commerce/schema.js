/**
 * Collections of the `commerce` module (control-plane records only: ids, amounts, hashes, states — no client data).
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const PRODUCTS = 'commerce_products';
export const LEDGER = 'commerce_ledger';
export const ACCOUNTS = 'commerce_accounts';
export const PRICE_LISTS = 'commerce_price_lists';
export const HISTORY = 'commerce_history';
export const BILLING = 'commerce_billing';

export const collections = Object.freeze([
	defineCollection({
		module: 'commerce',
		name: PRODUCTS,
		tenant: 'merchant',
		description:
			'Products on websites (`_id` = `<websiteId>:<productId>`): status added | removed, the switched-on features and the version of the last accepted feature report, who reported it and when.',
		indexes: [
			{ keys: { merchantId: 1, websiteId: 1, productId: 1 }, name: 'by_merchant_website' },
			{ keys: { websiteId: 1, status: 1 }, name: 'by_website' },
			{ keys: { productId: 1, status: 1, _id: 1 }, name: 'by_product' },
		],
	}),
	defineCollection({
		module: 'commerce',
		name: LEDGER,
		tenant: 'merchant',
		appendOnly: true,
		description:
			'Append-only, hash-chained merchant ledger in integer millicredits: receipts and day charges only (PLAN 0.5.7 b).',
		indexes: [
			{ keys: { merchantId: 1, seq: 1 }, name: 'chain', unique: true },
			{ keys: { merchantId: 1, entryKey: 1 }, name: 'entry_key', unique: true },
			{ keys: { merchantId: 1, type: 1, at: 1 }, name: 'by_type_at' },
			{ keys: { merchantId: 1, type: 1, day: 1 }, name: 'by_type_day' },
			{ keys: { type: 1, at: -1 }, name: 'receipts_by_at' },
			{ keys: { type: 1, day: 1 }, name: 'charges_by_day' },
		],
	}),
	defineCollection({
		module: 'commerce',
		name: ACCOUNTS,
		tenant: 'merchant',
		description: 'Merchant ledger account (_id = merchantId): written balance, chain head (seq, headHash).',
	}),
	defineCollection({
		module: 'commerce',
		name: PRICE_LISTS,
		appendOnly: true,
		description:
			'Accepted price lists per product, stamped with Portal time: { productId, version, at, features: [{ key, name, description, dependsOn, price }] } (price in millicredits per hour).',
		indexes: [
			{ keys: { productId: 1, version: 1 }, name: 'one_per_version', unique: true },
			{ keys: { productId: 1, at: 1 }, name: 'by_product_at' },
		],
	}),
	defineCollection({
		module: 'commerce',
		name: HISTORY,
		tenant: 'merchant',
		appendOnly: true,
		description:
			'Money histories per merchant, stamped with Portal time: feature reports (switches) per website × product and status changes (added, removed, suspended, resumed, grace_started, stopped).',
		indexes: [
			{ keys: { merchantId: 1, at: 1, _id: 1 }, name: 'by_merchant_at' },
			{ keys: { key: 1 }, name: 'once', unique: true, partialFilterExpression: { key: { $type: 'string' } } },
		],
	}),
	defineCollection({
		module: 'commerce',
		name: BILLING,
		tenant: 'merchant',
		description:
			'Billing state per merchant (_id = merchantId): settled-through day, grace/stop phase there, cached balance, daily spend and state (e-mails are sent once per state).',
		indexes: [{ keys: { state: 1, merchantId: 1 }, name: 'by_state' }],
	}),
]);
