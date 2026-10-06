/**
 * Scheduled work of the product (PLAN F.19, free-tier hosting): one daily cron route (`jobs/daily.js`) plus throttled
 * background work after requests. Register background tasks in `wireJobs` with
 * `product.background.every(name, intervalMs, fn, { per: 'website' })` — none yet.
 */
import { dailyRoutes } from './daily.js';

/**
 * @template P
 * @param {P} product the app-kit product
 * @returns {P}
 */
export const wireJobs = (product) => product;

/**
 * @param {{ heartbeat: () => Promise<unknown> }} product
 * @param {{ cronSecret?: string | null }} [options]
 */
export const jobRoutes = (product, { cronSecret = null } = {}) => dailyRoutes({ product, cronSecret });
