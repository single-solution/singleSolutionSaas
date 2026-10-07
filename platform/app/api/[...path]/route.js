// The Portal's only route handler. next.config.js rewrites /v1/*, /w/* (delivery), /p/* (preview proxy), /healthz,
// /readyz and /.well-known/jwks.json here (public paths unchanged); the module router serves /v1, /w and /p.
import { after } from 'next/server.js';
import { toNextRoute } from '../../../src/infra/http.js';
import { PORTAL_VERSION } from '../../../src/infra/config.js';
import { healthz } from '../../../src/portal.js';
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';

/** Readiness: configuration valid and the control-plane database reachable. */
const readyz = async () => {
	try {
		return await (await getPortal()).readyz();
	} catch {
		return new Response(JSON.stringify({ status: 'unavailable', checks: { config: 'invalid' } }), {
			status: 503,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	}
};

/** Endpoints outside the module router (GET/HEAD only): liveness (no dependencies), readiness, the published JWKS. */
const SYSTEM = /** @type {Record<string, () => Response | Promise<Response>>} */ ({
	'/healthz': () => healthz({ version: PORTAL_VERSION }),
	'/readyz': readyz,
	'/.well-known/jwks.json': async () => (await getPortal()).jwks(),
});

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute(
	async (request) => {
		const path = new URL(request.url).pathname.replace(/^\/api(?=\/)/, '');
		const system = Object.hasOwn(SYSTEM, path) ? SYSTEM[path] : undefined;
		if (system && (request.method === 'GET' || request.method === 'HEAD')) return system();
		return (await getPortal()).handle(request);
	},
	{ after },
);
