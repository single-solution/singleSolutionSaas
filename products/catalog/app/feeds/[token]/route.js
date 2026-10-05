/** GET /feeds/<token> — tokened public feeds (no key: the token names the website and the feed); cacheable responses. */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const OPTIONS = forward('OPTIONS');
