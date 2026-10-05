/** POST /.well-known/ss-events — signed Portal events (verified on the raw body), served by app-kit. */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const POST = forward('POST');
export const OPTIONS = forward('OPTIONS');
