/** POST /webhooks/payments/:websiteId — payment provider webhooks (verified by the merchant's gateway adapter). */
import { forward } from '../../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const POST = forward('POST');
export const OPTIONS = forward('OPTIONS');
