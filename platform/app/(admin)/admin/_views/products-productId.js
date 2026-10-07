import { loadProduct } from '../../../../src/console/admin/loaders.js';
import { ProductView } from '../../../../src/console/admin/views/products.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Product' };

/**
 * @param {{ params: Promise<{ productId: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props
 */
export default async function ProductPage({ params, searchParams }) {
	const { productId } = await params;
	const q = await searchParams;
	const { api, admin } = await adminContext(`/admin/products/${productId}`);
	return <ProductView {...await loadProduct(api, productId, { tab: one(q.tab) })} admin={admin} />;
}
