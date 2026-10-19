/**
 * Store details (the `store_details` feature): the public read for a website's header, footer and contact page
 * (`GET /v1/shop/store`) and the business.json a headless website serves at `/.well-known/business.json`
 * (`GET /v1/shop/store/business-json`). Both are made from the website's settings in the Portal (Website settings ›
 * Business, Brand and look, Region and format), which are set once for every product: Ecommerce keeps no record of its
 * own, takes no picture and has no save here. The pictures are the https addresses of Brand and look.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { businessJsonOf, publicStoreDetails, storeDetailsFromWebsite } from '../core/store-details.js';
import { conditional } from './http-cache.js';
import { VISITOR_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createStoreDetails = (product, service) => {
	/** GET /v1/shop/store: the public record. @param {any} ctx */
	const read = async (ctx) => {
		const s = await service.site(ctx);
		const [website, business] = await Promise.all([s.website(), s.business()]);
		const details = storeDetailsFromWebsite(website);
		return publicStoreDetails(details, {
			logoUrl: details.logo?.url ?? null,
			logoDarkUrl: details.logoDark?.url ?? null,
			iconUrl: details.icon?.url ?? null,
			faviconUrl: details.favicon?.url ?? null,
			faviconDarkUrl: details.faviconDark?.url ?? null,
			businessName: String(business.name ?? ''),
			siteUrl: s.domain ? `https://${s.domain}` : '',
		});
	};

	/** GET /v1/shop/store/business-json: the website's business.json made from the Portal's settings. @param {any} ctx */
	const businessJson = async (ctx) => {
		const s = await service.site(ctx);
		const [website, business] = await Promise.all([s.website(), s.business()]);
		const details = storeDetailsFromWebsite(website);
		const made = businessJsonOf(details, {
			logoUrl: details.logo?.url ?? null,
			currency: s.currency,
			currencies: Array.isArray(business.currencies) && business.currencies.length > 0 ? business.currencies : [s.currency],
			businessName: String(business.name ?? ''),
			timeZone: String(business.timeZone ?? ''),
			language: String(business.language ?? ''),
			country: String(business.country ?? ''),
		});
		if (!made.ok)
			throw problem(
				'conflict',
				'Give the business a name (Portal › Website settings › Business) before its business.json can be made.',
			);
		return made.value;
	};

	return {
		routes: [
			defineRoute({
				method: 'GET',
				path: '/v1/shop/store',
				auth: 'browser',
				feature: 'store_details',
				rateLimit: VISITOR_LIMITS,
				handler: conditional(read, service.now),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/store/business-json',
				auth: 'browser',
				feature: 'store_details',
				rateLimit: VISITOR_LIMITS,
				handler: conditional(businessJson, service.now),
			}),
		],
	};
};
