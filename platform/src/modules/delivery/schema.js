/**
 * Collections of the `delivery` module — **metadata only** (PLAN §1a): which artefacts exist, their hashes, sizes and
 * element lists, and which version each website alias points at. The artefacts themselves (pack and widget assets,
 * compiled bundles) are our software and live in platform asset storage.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const ASSETS = 'delivery_assets';
export const ARTEFACTS = 'delivery_artefacts';
export const ALIASES = 'delivery_aliases';
export const WIDGETS = 'delivery_widgets';
export const STRINGS = 'delivery_strings';

export const collections = Object.freeze([
	defineCollection({
		module: 'delivery',
		name: ASSETS,
		description:
			'Uploaded assets (`_id` = `<appId>:<version>:<path>`; the catalog version of a pack or the widget bundle ' +
			'version of a service product): sha256 and size verified against the uploaded descriptor, content type, ' +
			'storage key, uploader.',
		indexes: [{ keys: { appId: 1, version: 1, path: 1 }, unique: true }],
	}),
	defineCollection({
		module: 'delivery',
		name: ARTEFACTS,
		description:
			'Compiled website bundles (`_id` = `<websiteId>:<env>:<version>`): sequence, integrity (sha384), sha256, size, ' +
			'element list (app, element key), CSP sources, warnings, storage keys. Immutable.',
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
		name: WIDGETS,
		description:
			'Widget bundles of service products (`_id` = `<appId>:<version>`), uploaded by staff with `ss pack build` ' +
			'output: descriptor hash, element modules (key → headless / renderer / strings), declared assets (path, ' +
			'sha256, size), status uploading | ready, readiness time. The newest ready bundle is compiled into websites.',
		indexes: [{ keys: { appId: 1, version: -1 } }, { keys: { appId: 1, descriptorHash: 1 }, unique: true }],
	}),
	defineCollection({
		module: 'delivery',
		name: STRINGS,
		description:
			'Per-website string overrides of delivered elements (F.18; `_id` = `<websiteId>:<appId>:<element key>`): ' +
			"merchant, product, element, `languages` (BCP 47 tag or `*` → { key: text }). Our copy of the merchant's " +
			'wording for our elements, applied on top of the product catalogs at compile time.',
		indexes: [{ keys: { merchantId: 1, websiteId: 1 } }, { keys: { websiteId: 1, appId: 1, element: 1 } }],
	}),
]);
