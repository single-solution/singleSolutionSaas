import { loadProducts } from '../../../../../../src/console/loaders.js';
import { ProductsView } from '../../../../../../src/console/views/products.js';
import { merchantContext } from '../../../../_lib/server.js';

export const metadata = { title: 'Products' };

/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function ProductsPage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}/products`);
	return <ProductsView {...await loadProducts(api, merchantId, websiteId)} />;
}
