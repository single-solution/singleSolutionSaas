/** GET /.well-known/jwks/<websiteId>.json — the public keys of the website's identity issuer (served by the app-kit router). */
import { forward } from '../../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
