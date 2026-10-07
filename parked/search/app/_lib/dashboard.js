/**
 * Server-side dashboard context: the `ss_session` cookie set by `GET /sso?launch=` → session → website → data.
 */
import { cookies } from 'next/headers.js';
import { resolveDashboard } from '../../api/dashboard.js';
import { getSearch } from './product.js';

/** @param {string | null} [website] requested website (`?website=`) */
export const dashboardContext = async (website = null) =>
	resolveDashboard({ searchApp: await getSearch(), sessionId: (await cookies()).get('ss_session')?.value, website });
