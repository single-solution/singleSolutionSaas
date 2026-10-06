/**
 * Scheduled work of the product (PLAN F.19, free-tier hosting): one daily cron route (`jobs/daily.js`) plus throttled
 * background work after requests. `wireJobs` registers the background tasks once per instance (from the composition
 * root: `app/_lib/product.js`, `serve.js`); `jobRoutes` adds the cron route to the route table.
 */
import { notesRepositories } from '../adapters/db.js';
import { dailyRoutes } from './daily.js';
import { purgeDeletedNotes } from './purge-deleted.js';

/** At most one purge per website per hour, after a request for that website. */
export const PURGE_INTERVAL_MS = 60 * 60_000;

/**
 * @template {{ background: { every: Function } }} P
 * @param {P} product the app-kit product
 * @returns {P}
 */
export const wireJobs = (product) => {
	const repoFor = notesRepositories(/** @type {any} */ (product));
	product.background.every(
		'purge',
		PURGE_INTERVAL_MS,
		async (/** @type {{ websiteId: string }} */ { websiteId }) => purgeDeletedNotes({ repos: [await repoFor(websiteId)] }),
		{ per: 'website' },
	);
	return product;
};

/**
 * @param {{ heartbeat: () => Promise<unknown> }} product
 * @param {{ cronSecret?: string | null }} [options]
 */
export const jobRoutes = (product, { cronSecret = null } = {}) => dailyRoutes({ product, cronSecret });
