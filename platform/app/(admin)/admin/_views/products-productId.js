import { loadProduct } from '../../../../src/console/admin/loaders.js';
import { ProductsView } from '../../../../src/console/admin/views/products.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Product' };

/** A product's page, on its Websites part (the product's own address). */
/** @param {{ params: Promise<{ productId: string }> }} props */
export default async function ProductPage({ params }) {
	const { productId } = await params;
	const { api, admin } = await adminContext(`/admin/products/${productId}`);
	return <ProductsView detail={await loadProduct(api, productId)} section="websites" admin={admin} />;
}
