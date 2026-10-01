/** GET /healthz — liveness (no auth, cheap). */
import { forward } from '../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
