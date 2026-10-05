// Portal API catch-all: every module route, mounted through the framework-agnostic handler.
import { toNextRoute } from '../../../src/infra/http.js';
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute((request) => getPortal().handle(request));
