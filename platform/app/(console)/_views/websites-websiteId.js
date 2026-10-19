import { loadWebsitePage } from '../../../src/console/loaders.js';
import { routes } from '../../../src/console/paths.js';
import { WebsiteView } from '../../../src/console/views/websites.js';
import { websitePartOf } from '../../../src/console/website-parts.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Website' };

/** One website's own page: the Overview, or the part named by the next one or two segments of the address. */
/** @param {{ params: Promise<{ websiteId: string, part?: string, sub?: string }> }} props */
export default async function WebsitePage({ params }) {
	const { websiteId, part, sub } = await params;
	const path = websitePartOf(part, sub);
	const { api, merchantId } = await merchantContext(routes.websitePart(websiteId, path));
	return <WebsiteView {...await loadWebsitePage(api, merchantId, websiteId, path)} />;
}
