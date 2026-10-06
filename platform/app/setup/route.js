// First-run setup: records the Portal URL and creates the first admin; gone once a staff user exists (src/setup.js).
import { getPortal, resetPortal } from '../../src/runtime.js';
import { createSetupHandler } from '../../src/setup.js';

export const dynamic = 'force-dynamic';

const handle = createSetupHandler({ getPortal: () => getPortal(), resetPortal });
export const GET = (/** @type {Request} */ request) => handle(request);
export const POST = (/** @type {Request} */ request) => handle(request);
