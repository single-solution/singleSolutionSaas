// The Portal's only route handler. next.config.js rewrites /v1/*, /w/* (delivery), /p/* (preview proxy) and
// /.well-known/jwks.json here (public paths unchanged); the module router serves /v1, /w and /p.
import { after } from 'next/server.js';
import { isPlatformError } from '../../../src/infra/errors.js';
import { toNextRoute } from '../../../src/infra/http.js';
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';

/** Endpoints outside the module router (GET/HEAD only): the published JWKS. */
const SYSTEM = /** @type {Record<string, (portal: import('../../../src/portal.js').Portal) => Response>} */ ({
	'/.well-known/jwks.json': (portal) => portal.jwks(),
});

/**
 * An invalid configuration answers every route 503 with the problems (variable names, never values).
 * @param {unknown} error
 */
const misconfigured = (error) => {
	if (!isPlatformError(error, 'config_invalid')) throw error;
	const problems = /** @type {{ problems?: string[] } | undefined} */ (error.details)?.problems ?? [error.message];
	return new Response(JSON.stringify({ status: 'misconfigured', problems }), {
		status: 503,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
};

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute(
	async (request) => {
		const portal = await getPortal().catch((error) => error);
		if (portal instanceof Error) return misconfigured(portal);
		const path = new URL(request.url).pathname.replace(/^\/api(?=\/)/, '');
		const system = Object.hasOwn(SYSTEM, path) ? SYSTEM[path] : undefined;
		if (system && (request.method === 'GET' || request.method === 'HEAD')) return system(portal);
		return portal.handle(request);
	},
	{ after },
);
