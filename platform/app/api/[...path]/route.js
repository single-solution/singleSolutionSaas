// Portal API catch-all: every module route, mounted through the framework-agnostic handler.
import { after } from 'next/server.js';
import { toNextRoute } from '../../../src/infra/http.js';
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';
// a staff "Retry now" gets up to 50 s, and work after a response finishes inside the same invocation
export const maxDuration = 60;

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute(
	async (request) => (await getPortal()).handle(request),
	{
		after,
	},
);
