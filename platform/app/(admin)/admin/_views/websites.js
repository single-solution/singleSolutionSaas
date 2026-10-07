import { loadWebsites } from '../../../../src/console/admin/loaders.js';
import { WebsitesView } from '../../../../src/console/admin/views/websites.js';
import { staffContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Websites' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function WebsitesPage({ searchParams }) {
	const q = await searchParams;
	const { api, staff } = await staffContext('/admin/websites');
	return <WebsitesView {...await loadWebsites(api, { domain: one(q.domain), env: one(q.env) })} staff={staff} />;
}
