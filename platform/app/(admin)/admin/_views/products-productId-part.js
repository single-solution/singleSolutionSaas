import { notFound, redirect } from 'next/navigation';
import { PRODUCT_PARTS } from '../../../../src/console/admin/paths.js';

export const metadata = { title: 'Product' };

/** A part of a product's page: `/admin/products/:productId/:part` redirects to `/admin/products/:productId#${part}`. */
/** @param {{ params: Promise<{ productId: string, part: string }> }} props */
export default async function ProductPartPage({ params }) {
	const { productId, part } = await params;
	if (!PRODUCT_PARTS.includes(part)) notFound();
	redirect(`/admin/products/${productId}#${part}`);
}
