/** GET /cron/sweep — expire reservations, flush usage, heartbeat (Vercel cron with `Authorization: Bearer $CRON_SECRET`). */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
