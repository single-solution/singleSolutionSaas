/**
 * The import routes (feature `import`, server token only; PLAN 0.8.10 K10): NDJSON upserts with given ids into the
 * collections `adapters/imports.js` names (staff, guests, conversations, messages), prune, finish (in batches: call
 * again with `?after=<next>` while `more`) and status, all the kit's handlers.
 * @module
 */
import { IMPORT_LIMITS, defineRoute } from '@ss/app-kit';

/** @typedef {import('../adapters/product.js').Product} Product */

/** Room for the request around the largest NDJSON body. */
const ENVELOPE = 64 * 1024;

/**
 * @param {Product} product
 */
export const importRoutes = (product) => [
	defineRoute({
		method: 'POST',
		path: '/v1/import/:collection',
		auth: 'server',
		feature: 'import',
		rawBody: true,
		maxBodyBytes: IMPORT_LIMITS.bytes + ENVELOPE,
		handler: (ctx) => product.imports.upsert(ctx),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/import/:collection/prune',
		auth: 'server',
		feature: 'import',
		rawBody: true,
		maxBodyBytes: IMPORT_LIMITS.bytes + ENVELOPE,
		handler: (ctx) => product.imports.upsert.prune(ctx),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/import/finish',
		auth: 'server',
		feature: 'import',
		handler: (ctx) => product.imports.finish(ctx),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/import/status',
		auth: 'server',
		feature: 'import',
		handler: (ctx) => product.imports.status(ctx),
	}),
];
