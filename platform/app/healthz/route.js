// Liveness: cheap, no dependencies, no configuration.
import { healthz } from '../../src/portal.js';

export const dynamic = 'force-dynamic';

export const GET = () => healthz({ version: process.env.PORTAL_VERSION ?? 'dev' });
