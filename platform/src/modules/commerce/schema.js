/**
 * Collections of the `commerce` module (control-plane records only: ids, amounts, hashes, states — no client data).
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const SUBSCRIPTIONS = 'commerce_subscriptions';
export const TIMELINE = 'commerce_timeline';
export const PAUSES = 'commerce_pauses';
export const DOCUMENTS = 'commerce_documents';
export const USAGE = 'commerce_usage';
export const COUNTERS = 'commerce_usage_counters';
export const LEDGER = 'commerce_ledger';
export const ACCOUNTS = 'commerce_accounts';
export const SPEND_CAPS = 'commerce_spend_caps';
export const ALERTS = 'commerce_alerts';

const DAY_S = 86_400;

export const collections = Object.freeze([
	defineCollection({
		module: 'commerce',
		name: SUBSCRIPTIONS,
		tenant: 'merchant',
		description:
			'Subscriptions (website × app): plan, price-book pins, holds/status, element switches, settlement cursor. `live` is set while not cancelled.',
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
			{ keys: { settlementDone: 1, settledThrough: 1, merchantId: 1, _id: 1 }, name: 'settlement_due' },
		],
	}),
	defineCollection({
		module: 'commerce',
		name: TIMELINE,
		tenant: 'merchant',
		appendOnly: true,
		description: 'Billable element snapshots { subscriptionId, at, elements[] } written whenever the effective set changes.',
		indexes: [{ keys: { merchantId: 1, subscriptionId: 1, at: 1 }, name: 'by_subscription_at' }],
	}),
	defineCollection({
		module: 'commerce',
		name: PAUSES,
		tenant: 'merchant',
		description: 'Pause intervals per hold { subscriptionId, reason, from, to|null } (paused time is never billed).',
		indexes: [{ keys: { merchantId: 1, subscriptionId: 1, from: 1 }, name: 'by_subscription_from' }],
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
		description: 'Hourly usage counters per subscription × unit (_id = sub:unit:hour); repaired from records at settlement.',
		indexes: [{ keys: { merchantId: 1, subscriptionId: 1, unit: 1, hour: 1 }, name: 'by_subscription_unit_hour' }],
	}),
	defineCollection({
		module: 'commerce',
		name: LEDGER,
		tenant: 'merchant',
		appendOnly: true,
		description: 'Append-only, hash-chained merchant ledger in integer millicredits.',
		indexes: [
			{ keys: { merchantId: 1, seq: 1 }, name: 'chain', unique: true },
			{ keys: { merchantId: 1, entryKey: 1 }, name: 'entry_key', unique: true },
			{
				keys: { periodKey: 1 },
				name: 'period_key',
				unique: true,
				partialFilterExpression: { periodKey: { $type: 'string' } },
			},
			{ keys: { merchantId: 1, at: 1 }, name: 'by_at' },
			{ keys: { merchantId: 1, subscriptionId: 1, periodStart: 1 }, name: 'by_subscription_period' },
			{ keys: { merchantId: 1, type: 1, periodStart: 1 }, name: 'by_type_period' },
		],
	}),
	defineCollection({
		module: 'commerce',
		name: ACCOUNTS,
		tenant: 'merchant',
		description: 'Merchant credit account (_id = merchantId): cached balance, chain head (seq, headHash).',
	}),
	defineCollection({
		module: 'commerce',
		name: SPEND_CAPS,
		tenant: 'merchant',
		description: 'Optional monthly spend cap per merchant (_id = merchantId): limit in millicredits per UTC month.',
	}),
	defineCollection({
		module: 'commerce',
		name: ALERTS,
		appendOnly: true,
		description: 'Money alerts (chain breaks, unpriced hours) for staff review.',
		indexes: [
			{ keys: { at: -1 }, name: 'by_at' },
			{ keys: { merchantId: 1, at: -1 }, name: 'by_merchant_at' },
		],
	}),
]);
