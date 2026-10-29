import { connection } from 'next/server';
import { DocsHubView } from '../../../src/console/views/docs.js';
import { loadDocsHub } from '../../../src/console/loaders.js';
import { consoleApi, consoleBranding } from '../_lib/server.js';
import '../../(site)/site.css';

export const metadata = {
	title: 'Documentation Hub',
	description: 'Public developer documentation and OpenAPI 3.0 specs for Single Solution products.',
	robots: { index: true, follow: true },
};

export default async function DocsPage() {
	await connection();
	const [branding, api] = await Promise.all([consoleBranding(), consoleApi()]);
	const loaded = await loadDocsHub(api);
	return <DocsHubView branding={branding} items={loaded.ok ? loaded.items : []} />;
}
