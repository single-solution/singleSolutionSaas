/**
 * HTTP adapters of the `delivery` module. Public serving lives outside `/v1` (`/w/*`); console and staff routes are
 * `/v1/...`.
 *
 * | Route                                                                       | Auth             |
 * | --------------------------------------------------------------------------- | ---------------- |
 * | `PUT  /v1/admin/packs/:appId/versions/:version/assets/<path>` (packs and service widgets) | staff |
 * | `GET  /v1/merchants/:merchantId/websites/:websiteId/delivery`               | merchant, staff  |
 * | `GET  /v1/merchants/:merchantId/websites/:websiteId/delivery/snippet`       | merchant, staff  |
 * | `POST /v1/merchants/:merchantId/websites/:websiteId/delivery/compile`       | merchant, staff  |
 * | `GET  /v1/merchants/:merchantId/websites/:websiteId/delivery/strings`       | merchant, staff  |
 * | `PUT  …/delivery/strings/:appId/:element/:language` (string overrides)      | merchant, staff  |
 * | `GET  /w/:websiteId/loader.js` · `/w/:websiteId/:version/{loader.js,manifest.json}` | public   |
 * | `GET  /w/packs/:appId/:version/<path>`                                      | public           |
 *
 * `<path>` spans up to {@link MAX_PATH_SEGMENTS} segments (one route per depth; the router matches whole segments).
 * @module
 */
import { defineRoute } from '../../infra/http.js';
import { MAX_PATH_SEGMENTS, MAX_UPLOAD_BYTES } from './core/assets.js';

/** @typedef {import('./service.js').DeliveryService} DeliveryService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */

const CONSOLE = /** @type {import('../../infra/http.js').AuthMode[]} */ (['merchant', 'admin']);
const SITE = '/v1/merchants/:merchantId/websites/:websiteId';

/**
 * Parameter names `p0..p<n-1>` and the joined path of a multi-segment route.
 * @param {number} depth
 */
const segments = (depth) => Array.from({ length: depth }, (_, i) => `:p${i}`).join('/');
/** @param {RequestContext} ctx @param {number} depth */
const joined = (ctx, depth) => Array.from({ length: depth }, (_, i) => ctx.params[`p${i}`]).join('/');

/** @param {RequestContext} ctx */
const caller = (ctx) => ({ actor: /** @type {any} */ (ctx.actor), requestId: ctx.requestId, ip: ctx.ip });

/**
 * @param {DeliveryService} delivery
 */
export const deliveryRoutes = (delivery) => [
	// ---- staff: pack and widget assets ----------------------------------------------------------------------------
	...Array.from({ length: MAX_PATH_SEGMENTS }, (_, i) =>
		defineRoute({
			method: 'PUT',
			path: `/v1/admin/packs/:appId/versions/:version/assets/${segments(i + 1)}`,
			auth: 'admin',
			permission: 'products.manage',
			rawBody: true,
			maxBodyBytes: MAX_UPLOAD_BYTES,
			handler: (ctx) =>
				delivery.uploadAsset({
					appId: ctx.params.appId ?? '',
					version: ctx.params.version ?? '',
					path: joined(ctx, i + 1),
					bytes: ctx.rawBytes,
					contentType: ctx.headers.get('content-type'),
					...caller(ctx),
				}),
		}),
	),

	// ---- merchant console ----------------------------------------------------------------------------------------
	defineRoute({
		method: 'GET',
		path: `${SITE}/delivery`,
		auth: CONSOLE,
		permission: 'websites.read',
		handler: (ctx) => delivery.status({ websiteId: ctx.params.websiteId ?? '', merchantId: ctx.params.merchantId ?? '' }),
	}),
	defineRoute({
		method: 'GET',
		path: `${SITE}/delivery/snippet`,
		auth: CONSOLE,
		permission: 'websites.read',
		handler: (ctx) => delivery.snippet({ websiteId: ctx.params.websiteId ?? '', merchantId: ctx.params.merchantId ?? '' }),
	}),
	defineRoute({
		method: 'POST',
		path: `${SITE}/delivery/compile`,
		auth: CONSOLE,
		permission: 'settings.write',
		rateLimit: { limit: 30, windowMs: 10 * 60_000, key: (ctx) => `merchant:${ctx.params.merchantId}` },
		handler: (ctx) =>
			delivery.compile({
				websiteId: ctx.params.websiteId ?? '',
				merchantId: ctx.params.merchantId ?? '',
				reason: 'manual',
				...caller(ctx),
			}),
	}),
	defineRoute({
		method: 'GET',
		path: `${SITE}/delivery/strings`,
		auth: CONSOLE,
		permission: 'settings.read',
		handler: (ctx) =>
			delivery.listStringOverrides({ websiteId: ctx.params.websiteId ?? '', merchantId: ctx.params.merchantId ?? '' }),
	}),
	defineRoute({
		method: 'PUT',
		path: `${SITE}/delivery/strings/:appId/:element/:language`,
		auth: CONSOLE,
		permission: 'settings.write',
		rateLimit: { limit: 60, windowMs: 10 * 60_000, key: (ctx) => `merchant:${ctx.params.merchantId}` },
		handler: (ctx) =>
			delivery.setStringOverride({
				websiteId: ctx.params.websiteId ?? '',
				merchantId: ctx.params.merchantId ?? '',
				appId: ctx.params.appId ?? '',
				element: ctx.params.element ?? '',
				language: ctx.params.language ?? '',
				body: ctx.body,
				...caller(ctx),
			}),
	}),
	// ---- public serving ------------------------------------------------------------------------------------------
	defineRoute({
		method: 'GET',
		path: '/w/:websiteId/loader.js',
		auth: 'public',
		handler: (ctx) =>
			delivery.serveBundle({ websiteId: ctx.params.websiteId ?? '', ifNoneMatch: ctx.headers.get('if-none-match') }),
	}),
	...['loader.js', 'manifest.json'].map((file) =>
		defineRoute({
			method: 'GET',
			path: `/w/:websiteId/:version/${file}`,
			auth: 'public',
			handler: (ctx) =>
				delivery.serveBundle({
					websiteId: ctx.params.websiteId ?? '',
					version: ctx.params.version ?? '',
					file: /** @type {'loader.js' | 'manifest.json'} */ (file),
					ifNoneMatch: ctx.headers.get('if-none-match'),
				}),
		}),
	),
	...Array.from({ length: MAX_PATH_SEGMENTS }, (_, i) =>
		defineRoute({
			method: 'GET',
			path: `/w/packs/:appId/:version/${segments(i + 1)}`,
			auth: 'public',
			handler: (ctx) =>
				delivery.serveAsset({
					appId: ctx.params.appId ?? '',
					version: ctx.params.version ?? '',
					path: joined(ctx, i + 1),
					ifNoneMatch: ctx.headers.get('if-none-match'),
				}),
		}),
	),
];
