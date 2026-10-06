/** POST /.well-known/ss-connect — a Portal connecting with the deployer's CONNECT_SECRET (HMAC-verified), served by app-kit. */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const POST = forward('POST');
