/**
 * HTTP adapters of the `delivery` module. Public serving lives outside `/v1` (`/w/*`, `/p/*`, mounted by thin
 * `app/w` and `app/p` route files over the same handler); console and staff routes are `/v1/...`.
 *
 * | Route                                                                       | Auth             |
 * | --------------------------------------------------------------------------- | ---------------- |
 * | `PUT  /v1/admin/packs/:appId/versions/:version/assets/<path>`               | staff            |
 * | `POST /v1/product/ui-bundles` · `GET /v1/product/ui-bundles`                 | product          |
 * | `PUT  /v1/product/ui-bundles/:version/assets/<path>`                        | product          |
 * | `GET  /v1/merchants/:merchantId/websites/:websiteId/delivery`               | merchant, staff  |
 * | `GET  /v1/merchants/:merchantId/websites/:websiteId/delivery/snippet`       | merchant, staff  |
 * | `POST /v1/merchants/:merchantId/websites/:websiteId/delivery/compile`       | merchant, staff  |
 * | `POST /v1/merchants/:merchantId/websites/:websiteId/delivery/rollback`      | merchant, staff  |
 * | `POST /v1/merchants/:merchantId/websites/:websiteId/preview`                | merchant, staff  |
 * | `GET  /w/:websiteId/loader.js` · `/w/:websiteId/:version/{loader.js,manifest.json}` | public   |
 * | `GET  /w/packs/:appId/:version/<path>` · `/w/ui/:appId/:version/<path>`     | public           |
 * | `GET  /p/:token[/<path>]`                                                   | public           |
 *
 * `<path>` spans up to {@link MAX_PATH_SEGMENTS} segments (one route per depth; the router matches whole segments).
 * @module
 */
import { defineRoute } from '../../infra/http.js';
import { MAX_PATH_SEGMENTS, MAX_UPLOAD_BYTES } from './core/assets.js';

/** @typedef {import('./service.js').DeliveryService} DeliveryService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */

const CONSOLE = /** @type {import('../../infra/http.js').AuthMode[]} */ (['merchant', 'staff']);
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
	// ---- developers / staff: pack assets ----------------------------------------------------------------------
	...Array.from({ length: MAX_PATH_SEGMENTS }, (_, i) =>
		defineRoute({
			method: 'PUT',
			path: `/v1/admin/packs/:appId/versions/:version/assets/${segments(i + 1)}`,
			auth: 'staff',
			permission: 'platform.apps.manage',
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

	// ---- service products: their own signed UI bundle (F.16) ------------------------------------------------------
	defineRoute({
		method: 'POST',
		path: '/v1/product/ui-bundles',
		auth: 'product',
		idempotent: 'optional',
		maxBodyBytes: 256 * 1024,
		rateLimit: { limit: 30, windowMs: 60 * 60_000 },
		handler: (ctx) =>
			delivery.submitUiBundle({
				appId: /** @type {{ appId: string }} */ (ctx.app).appId,
				body: ctx.body,
				requestId: ctx.requestId,
				ip: ctx.ip,
			}),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/product/ui-bundles',
		auth: 'product',
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: (ctx) => delivery.listUiBundles({ appId: /** @type {{ appId: string }} */ (ctx.app).appId }),
	}),
	...Array.from({ length: MAX_PATH_SEGMENTS }, (_, i) =>
		defineRoute({
			method: 'PUT',
			path: `/v1/product/ui-bundles/:version/assets/${segments(i + 1)}`,
			auth: 'product',
			rawBody: true,
			maxBodyBytes: MAX_UPLOAD_BYTES,
			rateLimit: { limit: 600, windowMs: 60 * 60_000 },
			handler: (ctx) =>
				delivery.uploadUiAsset({
					appId: /** @type {{ appId: string }} */ (ctx.app).appId,
					version: ctx.params.version ?? '',
					path: joined(ctx, i + 1),
					bytes: ctx.rawBytes,
					contentType: ctx.headers.get('content-type'),
					requestId: ctx.requestId,
					ip: ctx.ip,
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
		permission: 'websites.write',
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
		method: 'POST',
		path: `${SITE}/delivery/rollback`,
		auth: CONSOLE,
		permission: 'websites.write',
		handler: (ctx) =>
			delivery.rollback({
				websiteId: ctx.params.websiteId ?? '',
				merchantId: ctx.params.merchantId ?? '',
				version: /** @type {Record<string, unknown> | undefined} */ (ctx.body)?.version,
				...caller(ctx),
			}),
	}),
	defineRoute({
		method: 'POST',
		path: `${SITE}/preview`,
		auth: CONSOLE,
		permission: 'websites.read',
		rateLimit: { limit: 20, windowMs: 10 * 60_000, key: (ctx) => `merchant:${ctx.params.merchantId}` },
		handler: async (ctx) => ({
			...(await delivery.createPreview({
				websiteId: ctx.params.websiteId ?? '',
				merchantId: ctx.params.merchantId ?? '',
				body: ctx.body,
				...caller(ctx),
			})),
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
	.../** @type {const} */ (['packs', 'ui']).flatMap((dir) =>
		Array.from({ length: MAX_PATH_SEGMENTS }, (_, i) =>
			defineRoute({
				method: 'GET',
				path: `/w/${dir}/:appId/:version/${segments(i + 1)}`,
				auth: 'public',
				handler: (ctx) =>
					delivery.serveAsset({
						appId: ctx.params.appId ?? '',
						version: ctx.params.version ?? '',
						path: joined(ctx, i + 1),
						ifNoneMatch: ctx.headers.get('if-none-match'),
						bundle: dir === 'ui' ? 'ui' : 'pack',
					}),
			}),
		),
	),
	...Array.from({ length: MAX_PATH_SEGMENTS + 1 }, (_, depth) =>
		defineRoute({
			method: 'GET',
			path: depth === 0 ? '/p/:token' : `/p/:token/${segments(depth)}`,
			auth: 'public',
			rateLimit: {
				limit: 120,
				windowMs: 60_000,
				key: (ctx) => delivery.previewSubject(ctx.params.token ?? '', ctx.ip),
			},
			handler: (ctx) =>
				delivery.servePreview({
					token: ctx.params.token ?? '',
					path: `/${Array.from({ length: depth }, (_, i) => encodeURIComponent(ctx.params[`p${i}`] ?? '')).join('/')}`,
					search: new URL(ctx.request.url).search,
					host: new URL(ctx.request.url).host,
				}),
		}),
	),
];
