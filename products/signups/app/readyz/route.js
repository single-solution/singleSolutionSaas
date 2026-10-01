/** GET /readyz — readiness (own control DB; an unreachable Portal reports degraded). */
import { forward } from '../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const OPTIONS = forward('OPTIONS');
