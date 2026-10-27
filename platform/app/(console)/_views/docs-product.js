import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { DocsProductView } from '../../../src/console/views/docs-product.js';
import { loadDocsProduct } from '../../../src/console/loaders.js';
import { consoleApi, consoleBranding } from '../_lib/server.js';

export const metadata = {
	title: 'Product Documentation',
	description: 'Developer documentation, guides, and OpenAPI spec.',
	robots: { index: true, follow: true },
};

/** @param {{ params: Promise<{ productId?: string }> }} props */
export default async function DocsProductPage({ params }) {
	await connection();
	const { productId } = await params;
	if (!productId) notFound();
	const [branding, api] = await Promise.all([consoleBranding(), consoleApi()]);
	const loaded = await loadDocsProduct(api, productId);
	if (!loaded.ok || !loaded.product) notFound();
	return <DocsProductView branding={branding} product={loaded.product} />;
}
