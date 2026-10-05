// Published JWKS: Portal signing keys (current + previous) and the website-key signing keys (distinct kids).
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';

export const GET = () => getPortal().jwks();
