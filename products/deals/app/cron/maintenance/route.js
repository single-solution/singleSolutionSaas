/** GET /cron/maintenance — daily catch-up: usage flush and heartbeat (Vercel cron with `Authorization: Bearer $CRON_SECRET`). */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const OPTIONS = forward('OPTIONS');
