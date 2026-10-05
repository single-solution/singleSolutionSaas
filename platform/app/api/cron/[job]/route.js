// Cron trigger: `Authorization: Bearer <CRON_SECRET>` → job runner (lease lock, recorded run, time budget).
import { getPortal } from '../../../../src/runtime.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // keep CRON_DEADLINE_MS below this

/** @param {Request} request */
const run = (request) => getPortal().handle(request);

export const GET = run;
export const POST = run;
