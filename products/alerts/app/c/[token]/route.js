/** Hosted link page: GET shows a confirm button (link previews never change anything), POST applies it. */
import { forward } from '../../_lib/product.js';

export const dynamic = 'force-dynamic';
export const GET = forward('GET');
export const POST = forward('POST');
