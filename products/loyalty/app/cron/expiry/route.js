/** GET /cron/expiry — daily catch-up: expiry, notices and tier reviews (Vercel cron with `Authorization: Bearer $CRON_SECRET`). */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const OPTIONS = forward('OPTIONS');
