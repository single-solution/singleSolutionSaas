/** POST /.well-known/ss-register — one-time registration handshake (proof of possession), served by app-kit. */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const POST = forward('POST');
export const OPTIONS = forward('OPTIONS');
