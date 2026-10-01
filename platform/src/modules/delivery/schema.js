/**
 * Collections of the `delivery` module — **metadata only** (PLAN §1a): which artefacts exist, their hashes, sizes,
 * budgets and element lists, which version each website alias points at, and short-lived preview sessions. The
 * artefacts themselves (pack assets, compiled bundles) are our software and live in platform asset storage; fetched
 * merchant pages are never stored anywhere.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const ASSETS = 'delivery_assets';
export const ARTEFACTS = 'delivery_artefacts';
export const ALIASES = 'delivery_aliases';
export const PREVIEWS = 'delivery_previews';
export const UI_BUNDLES = 'delivery_ui_bundles';

export const collections = Object.freeze([
	defineCollection({
		module: 'delivery',
		name: ASSETS,
		description:
			'Uploaded pack assets (`_id` = `<appId>:<catalog version>:<path>`) and service UI-bundle assets (`_id` = ' +
			'`ui:<appId>:<UI bundle version>:<path>`, `bundle: ui`): sha256 and size verified against the signed bundle ' +
			'descriptor, content type, storage key, uploader.',
		indexes: [{ keys: { appId: 1, version: 1, path: 1 }, unique: true }],
	}),
	defineCollection({
		module: 'delivery',
		name: ARTEFACTS,
		description:
			'Compiled website bundles (`_id` = `<websiteId>:<env>:<version>`): sequence, integrity (sha384), sha256, sizes, ' +
			'budget report, element list (app, element key, budget), CSP sources, warnings, storage keys. Immutable.',
		indexes: [
			{ keys: { websiteId: 1, env: 1, seq: -1 }, name: 'by_website_seq' },
			{ keys: { websiteId: 1, version: 1 }, name: 'by_website_version' },
		],
	}),
	defineCollection({
		module: 'delivery',
		name: ALIASES,
		description:
			'Website aliases (`_id` = `<websiteId>:<env>`): the version `/w/<websiteId>/loader.js` serves, flip history, ' +
			'compile request counter, and the public `pk_` key embedded in bundles (browser-safe by design).',
		indexes: [{ keys: { websiteId: 1 }, unique: true }],
	}),
	defineCollection({
		module: 'delivery',
		name: UI_BUNDLES,
		description:
			'Signed UI bundles of service products (F.16; `_id` = `<appId>:<version>`): descriptor hash, element modules ' +
			'(key → headless / renderer / strings), declared assets (path, sha256, size), signature kid, status ' +
			'pending | ready, readiness time. The newest ready bundle replaces the element stub in compiled bundles.',
		indexes: [{ keys: { appId: 1, version: -1 } }, { keys: { appId: 1, descriptorHash: 1 }, unique: true }],
	}),
	defineCollection({
		module: 'delivery',
		name: PREVIEWS,
		description:
			'Preview sessions (`_id` = previewId): website, merchant, page origin, candidate element set and the compiled ' +
			'candidate bundle (our code). Expire after 10 minutes. Fetched pages are never stored.',
		indexes: [{ keys: { merchantId: 1, createdAt: -1 } }],
		ttl: { field: 'expireAt', afterSeconds: 0 },
	}),
]);
