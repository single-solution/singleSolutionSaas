// Liveness: cheap, no dependencies, no configuration.
import { PORTAL_VERSION } from '../../src/infra/config.js';
import { healthz } from '../../src/portal.js';

export const dynamic = 'force-dynamic';

export const GET = () => healthz({ version: PORTAL_VERSION });
