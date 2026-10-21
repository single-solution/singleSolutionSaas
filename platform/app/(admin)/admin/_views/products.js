import { loadProduct, loadProducts } from '../../../../src/console/admin/loaders.js';
import { ProductsView } from '../../../../src/console/admin/views/products.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Products' };

/** The Products screen: list of products with the first product open beside it on wide screens. */
/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ProductsPage({ searchParams }) {
	const q = await searchParams;
	const status = one(q.status);
	const { api, admin } = await adminContext('/admin/products');
	const list = await loadProducts(api, { status });
	const firstId = list.ok && list.items?.[0]?.productId ? String(list.items[0].productId) : null;
	const detail = firstId ? await loadProduct(api, firstId) : null;
	return <ProductsView {...list} detail={detail} fromList admin={admin} />;
}
