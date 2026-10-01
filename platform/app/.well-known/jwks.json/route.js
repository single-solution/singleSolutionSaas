// Portal JWKS (current + previous signing keys).
import { getPortal } from '../../../src/runtime.js';

export const dynamic = 'force-dynamic';

export const GET = () => getPortal().jwks();
