/**
 * Collections of the `commerce` module (control-plane records only: ids, amounts, hashes, states — no client data).
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const SUBSCRIPTIONS = 'commerce_subscriptions';
export const DOCUMENTS = 'commerce_documents';
export const USAGE = 'commerce_usage';
export const COUNTERS = 'commerce_usage_counters';
export const LEDGER = 'commerce_ledger';
export const ACCOUNTS = 'commerce_accounts';
export const PRICE_LISTS = 'commerce_price_lists';
export const HISTORY = 'commerce_history';
export const BILLING = 'commerce_billing';

const DAY_S = 86_400;

export const collections = Object.freeze([
	defineCollection({
		module: 'commerce',
		name: SUBSCRIPTIONS,
		tenant: 'merchant',
		description:
			'Subscriptions (website × app): plan, price-book pins, holds/status, element switches. `live` is set while not cancelled.',
		indexes: [
			{
				keys: { websiteId: 1, appId: 1 },
				name: 'one_live_per_website_app',
				unique: true,
				partialFilterExpression: { live: true },
			},
			{ keys: { websiteId: 1, createdAt: 1 }, name: 'by_website' },
			{ keys: { appId: 1, live: 1 }, name: 'by_app' },
			{ keys: { merchantId: 1, status: 1 }, name: 'by_merchant_status' },
		],
	}),
	defineCollection({
		module: 'commerce',
		name: DOCUMENTS,
		tenant: 'merchant',
		description:
			'Signed entitlement document cache per subscription (_id = subscriptionId): version, content hash, JWS, validity.',
	}),
	defineCollection({
		module: 'commerce',
		name: USAGE,
		tenant: 'merchant',
		appendOnly: true,
		description: 'Accepted usage records (exactly once by subscription × idempotencyKey), bucketed by UTC hour of receipt.',
		indexes: [
			{ keys: { subscriptionId: 1, idempotencyKey: 1 }, name: 'dedupe', unique: true },
			{ keys: { merchantId: 1, subscriptionId: 1, bucket: 1 }, name: 'by_bucket' },
		],
		ttl: { field: 'receivedAt', afterSeconds: 180 * DAY_S },
	}),
	defineCollection({
		module: 'commerce',
		name: COUNTERS,
		tenant: 'merchant',
		description: 'Hourly usage counters per subscription × unit (_id = sub:unit:hour), for quotas.',
		indexes: [{ keys: { merchantId: 1, subscriptionId: 1, unit: 1, hour: 1 }, name: 'by_subscription_unit_hour' }],
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
		description: 'Price lists per product, stamped with Portal time: { appId, at, features: [{ key, name, price }] }.',
		indexes: [{ keys: { appId: 1, at: 1 }, name: 'by_app_at' }],
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
