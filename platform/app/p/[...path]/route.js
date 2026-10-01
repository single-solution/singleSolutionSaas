// Delivery plane: the "try it on your site" preview proxy (/p/<token>/<path>), served by the delivery module.
import { toNextRoute } from '../../../src/infra/http.js';
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';

export const { GET, HEAD, OPTIONS } = toNextRoute((request) => getPortal().handle(request));
