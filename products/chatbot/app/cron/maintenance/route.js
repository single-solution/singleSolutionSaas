/** GET /cron/maintenance — knowledge refresh, SLA breaches, snooze wake-ups, auto-close, purge, usage flush (Vercel cron). */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
