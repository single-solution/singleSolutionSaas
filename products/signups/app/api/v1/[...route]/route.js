/** All /v1/* routes (next.config.js rewrites /v1/:path* here); app-kit applies auth, gating, idempotency, limits, RFC 9457. */
import { forward } from '../../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const POST = forward('POST');
export const PATCH = forward('PATCH');
export const DELETE = forward('DELETE');
