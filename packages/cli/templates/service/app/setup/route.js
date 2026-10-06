/** GET/POST /setup — connect this product to a Portal with a connection code (only while unconnected), served by app-kit. */
import { forward } from '../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const POST = forward('POST');
