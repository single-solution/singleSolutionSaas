// Readiness: configuration valid and the control-plane database reachable.
import { getPortal } from '../../src/runtime.js';

export const dynamic = 'force-dynamic';

export const GET = async () => {
	try {
		return await getPortal().readyz();
	} catch {
		return new Response(JSON.stringify({ status: 'unavailable', checks: { config: 'invalid' } }), {
			status: 503,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	}
};
