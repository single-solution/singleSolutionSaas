import { notFound } from 'next/navigation';
import { loadProduct } from '../../../../src/console/admin/loaders.js';
import { PRODUCT_PARTS } from '../../../../src/console/admin/paths.js';
import { ProductsView } from '../../../../src/console/admin/views/products.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Product' };

/** A part of a product's page: `/admin/products/:productId/features` or `connection`; any other is a 404. */
/** @param {{ params: Promise<{ productId: string, part: string }> }} props */
export default async function ProductPartPage({ params }) {
	const { productId, part } = await params;
	if (!PRODUCT_PARTS.includes(part)) notFound();
	const { api, admin } = await adminContext(`/admin/products/${productId}/${part}`);
	return <ProductsView detail={await loadProduct(api, productId)} section={part} admin={admin} />;
}
