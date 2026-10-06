/**
 * GET /cron/sweep — daily catch-up (Vercel cron with `Authorization: Bearer $CRON_SECRET`): expire reservations of every
 * website, flush usage, heartbeat. Between runs, reservations expire when touched and a throttled sweep runs after requests.
 */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const OPTIONS = forward('OPTIONS');
