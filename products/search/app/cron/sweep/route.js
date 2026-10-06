/** GET /cron/sweep — crawl steps, Atlas index state, vocabulary cleanup (daily Vercel cron catch-up with `Authorization: Bearer $CRON_SECRET`). */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const OPTIONS = forward('OPTIONS');
