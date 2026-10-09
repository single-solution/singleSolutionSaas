import { loadProductsScreen } from '../../../../src/console/admin/loaders.js';
import { ProductsView } from '../../../../src/console/admin/views/products.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Products' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ProductsPage({ searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext('/admin/products');
	return <ProductsView {...await loadProductsScreen(api, { status: one(q.status) })} admin={admin} />;
}
