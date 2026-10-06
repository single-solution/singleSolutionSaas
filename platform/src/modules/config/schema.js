/**
 * Collections of the `config` module. Merchant-owned layers (merchant, website, admin) live in merchant-scoped
 * collections; platform policies (an app across all merchants) in their own unscoped collections. Version records
 * are append-only; the current state of every target is a materialised document updated with compare-and-set.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const LAYERS = 'config_layers';
export const VERSIONS = 'config_versions';
export const PLATFORM_LAYERS = 'config_platform_layers';
export const PLATFORM_VERSIONS = 'config_platform_versions';
export const TEMPLATES = 'config_templates';
export const SCHEDULES = 'config_schedules';
export const EXPERIMENTS = 'config_experiments';

/** @type {import('../../infra/db.js').IndexSpec[]} */
const versionIndexes = [
	{ keys: { targetKey: 1, version: -1 }, name: 'target_version', unique: true },
	{
		keys: { targetKey: 1, changeKey: 1 },
		name: 'target_change_key',
		unique: true,
		partialFilterExpression: { changeKey: { $type: 'string' } },
	},
];

export const collections = Object.freeze([
	defineCollection({
		module: 'config',
		name: LAYERS,
		tenant: 'merchant',
		description: 'Current (materialised) merchant / website / admin layer per target; `version` = latest version record.',
		indexes: [{ keys: { merchantId: 1, appId: 1, level: 1 }, name: 'merchant_app_level' }],
	}),
	defineCollection({
		module: 'config',
		name: VERSIONS,
		tenant: 'merchant',
		appendOnly: true,
		description: 'Immutable version records (state snapshot, diff, actor, reason) of merchant-owned layers.',
		indexes: versionIndexes,
	}),
	defineCollection({
		module: 'config',
		name: PLATFORM_LAYERS,
		description: 'Current platform policy layer per app (staff policy across all merchants).',
	}),
	defineCollection({
		module: 'config',
		name: PLATFORM_VERSIONS,
		appendOnly: true,
		description: 'Immutable version records of platform policies.',
		indexes: versionIndexes,
	}),
	defineCollection({
		module: 'config',
		name: TEMPLATES,
		tenant: 'merchant',
		description: 'Merchant-saved profiles of website-level settings for an app, with where they were applied.',
		indexes: [{ keys: { merchantId: 1, appId: 1, createdAt: -1 }, name: 'merchant_app' }],
	}),
	defineCollection({
		module: 'config',
		name: SCHEDULES,
		tenant: 'merchant',
		description: 'Scheduled configuration changes (applied on the first read of the configuration at or after `at`).',
		indexes: [
			{ keys: { merchantId: 1, targetKey: 1, at: 1 }, name: 'merchant_target_at' },
			{ keys: { merchantId: 1, status: 1, at: 1 }, name: 'merchant_status_at' },
		],
	}),
	defineCollection({
		module: 'config',
		name: EXPERIMENTS,
		tenant: 'merchant',
		description: 'Experiment definitions per subscription element (variants, weights, metric, status).',
		indexes: [
			{ keys: { merchantId: 1, subscriptionId: 1, createdAt: -1 }, name: 'merchant_subscription' },
			{
				keys: { subscriptionId: 1, element: 1 },
				name: 'one_running_per_element',
				unique: true,
				partialFilterExpression: { status: 'running' },
			},
		],
	}),
]);
