// Delivery plane: compiled website bundles and pack modules (/w/*), served by the delivery module's public routes.
import { after } from 'next/server.js';
import { toNextRoute } from '../../../src/infra/http.js';
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';

export const { GET, HEAD, OPTIONS } = toNextRoute(async (request) => (await getPortal()).handle(request), {
	after,
});
