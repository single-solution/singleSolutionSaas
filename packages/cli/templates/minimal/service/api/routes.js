/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, the .well-known endpoints
 * and /sso) plus the product's own routes. Every product route is website-key authenticated and gated by its element:
 * a disabled element answers 403 element_disabled.
 */
import { defineRoute, ok, standardRoutes } from '@ss/app-kit';
import { statusOf } from '../core/status.js';
import { sessionView } from './session.js';

/**
 * @param {any} product the app-kit product
 */
export const buildRoutes = (product) => [
	...standardRoutes(product),
	defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),
	defineRoute({
		method: 'GET',
		path: '/v1/status',
		auth: 'website',
		element: 'status',
		handler: (ctx) =>
			ok(statusOf({ websiteId: ctx.websiteId, config: product.entitlements.config(ctx.entitlement.doc, 'status') ?? {} })),
	}),
];

/**
 * Register event consumers (app-kit dedupes deliveries on the event id). List consumed types in the manifest's
 * `events.consumes` with an `events.subscribe:` scope.
 * @param {any} product
 */
export const wireEvents = (product) => product;
