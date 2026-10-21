import { loadProduct, loadProducts } from '../../../../src/console/admin/loaders.js';
import { ProductsView } from '../../../../src/console/admin/views/products.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Product' };

/** A product's page beside the list of products. */
/** @param {{ params: Promise<{ productId: string }>, searchParams?: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ProductPage({ params, searchParams }) {
	const { productId } = await params;
	const q = searchParams ? await searchParams : {};
	const status = one(q.status);
	const { api, admin } = await adminContext(`/admin/products/${productId}`);
	const [list, detail] = await Promise.all([loadProducts(api, { status }), loadProduct(api, productId)]);
	return <ProductsView {...list} detail={detail} productId={productId} admin={admin} />;
}
