/**
 * Collections of the `website` module: the website-settings document of each website (`ss.website-settings/1`, the
 * facts every product of the website shares). No secrets and no image bytes: pictures are https addresses.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const SETTINGS = 'website_settings';

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
]);
