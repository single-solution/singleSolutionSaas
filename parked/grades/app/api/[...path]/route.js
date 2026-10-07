/**
 * The product's only route handler. next.config.js rewrites every public path here — /v1/*,
 * /.well-known/* (ss-app.json, ss-connect, ss-events, …), /sso — and the app-kit router
 * (which strips the `/api` prefix) applies auth, gating, CORS preflight, idempotency, limits and RFC 9457 problems.
 */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const POST = forward('POST');
export const PATCH = forward('PATCH');
export const DELETE = forward('DELETE');
export const OPTIONS = forward('OPTIONS');
