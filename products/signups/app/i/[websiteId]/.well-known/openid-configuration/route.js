/** GET /i/<websiteId>/.well-known/openid-configuration — discovery document of the website's issuer. */
import { forward } from '../../../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
