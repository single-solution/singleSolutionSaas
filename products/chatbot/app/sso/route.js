/** GET /sso?launch= — exchanges a Portal launch for the ss_session cookie and redirects to the dashboard (app-kit). */
import { forward } from '../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
