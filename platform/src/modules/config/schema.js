/**
 * Collections of the `config` module. Merchant-owned layers (website, admin) live in merchant-scoped collections;
 * platform policies (an app across all merchants) in their own unscoped collections. Version records are append-only; the current state of every target is a materialised document updated with compare-and-set.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const LAYERS = 'config_layers';
export const VERSIONS = 'config_versions';
export const GLOBAL_LAYERS = 'config_platform_layers';
export const GLOBAL_VERSIONS = 'config_platform_versions';

/** @type {import('../../infra/db.js').IndexSpec[]} */
const versionIndexes = [{ keys: { targetKey: 1, version: -1 }, name: 'target_version', unique: true }];

export const collections = Object.freeze([
	defineCollection({
		module: 'config',
		name: LAYERS,
		tenant: 'merchant',
		description: 'Current (materialised) website / admin layer per target; `version` = latest version record.',
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
		name: GLOBAL_LAYERS,
		description: 'Current platform policy layer per app (staff policy across all merchants).',
	}),
	defineCollection({
		module: 'config',
		name: GLOBAL_VERSIONS,
		appendOnly: true,
		description: 'Immutable version records of platform policies.',
		indexes: versionIndexes,
	}),
]);
