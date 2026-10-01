/** GET /.well-known/ss-app.json — the manifest the Portal imports (features inline), served by app-kit. */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
