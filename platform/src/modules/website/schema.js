/**
 * Collections of the `website` module: the website-settings document of each website (`ss.website-settings/1`, the
 * facts every product of the website shares). No secrets and no image bytes: pictures are https addresses.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const SETTINGS = 'website_settings';
export const CONNECTIONS = 'website_connections';
export const LINKS = 'website_links';

export const collections = Object.freeze([
	defineCollection({
		module: 'website',
		name: SETTINGS,
		description:
			'The website settings of a website (`_id` = websiteId): the save counter `version` (raised by one on every save; a save must name the version it read), when and by whom it was last saved, and the five sections `settings` { business, brand, region, pages, team } of `@ss/contracts` `ss.website-settings/1` (at most 64 kB, validated). Delivered to every product on the website through `GET /v1/product/websites/:websiteId/settings`. Nothing is stored for a website nobody saved settings for.',
		tenant: 'merchant',
		timestamps: false,
		indexes: [{ keys: { merchantId: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'website',
		name: CONNECTIONS,
		description:
			"The website's connections, entered once in the Portal (`_id` = websiteId): the change counter `version` (raised by every change of a connection and of a link, and the `connectionsVersion` of the status answer), the database connection string, the storage connection and the AI provider key (provider, key, model), each SEALED with `ENCRYPTION_KEY` (AAD: website, name and the value's own counter) and write-only (nothing returns them to a person; a product fetches them over its signed channel), the Owner's per-product database names, the health each product reported for each value, when each product last fetched and the secret fetches in the current hour. Removed with the website.",
		tenant: 'merchant',
		timestamps: false,
		indexes: [{ keys: { merchantId: 1, _id: 1 } }],
	}),
	defineCollection({
		module: 'website',
		name: LINKS,
		description:
			'The links between two products of a website (`_id` = `<websiteId>:<callee>:<caller>`): caller, callee, the scopes the Portal grants (from the manifests and the features that are on), status on | off, and the link token (a Portal-signed token of kind `link`, SEALED with `ENCRYPTION_KEY`, delivered only to the caller over its signed channel). Removed, and the token revoked, when either product leaves the website.',
		tenant: 'merchant',
		timestamps: false,
		indexes: [
			{ keys: { merchantId: 1, websiteId: 1, _id: 1 } },
			{ keys: { websiteId: 1, callee: 1 } },
			{ keys: { websiteId: 1, caller: 1 } },
		],
	}),
]);
