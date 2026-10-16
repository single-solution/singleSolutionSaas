/**
 * The SEO checklist's last full report in the merchant database (`ss_growth_seo_reports`, through the kit's tenant
 * guard): one document per website, `{ checkedAt, pages, checks }`, replaced by each full run (the checklist's own
 * pages and the sample pages). The widget shows it when it opens, and a full run asked again within a few minutes
 * answers it instead of reading the site again. The texts are not kept: they are the website's widget texts when the
 * report is read.
 * @module
 */

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/seo-checks.js').Check} Check */
/** @typedef {import('../core/seo-checks.js').PageKind} PageKind */
/** @typedef {import('../core/seo-checks.js').PageHead} PageHead */
/**
 * @typedef {{ checkedAt: Date, pages: Array<{ url: string, kind: PageKind, sampled: boolean, head: PageHead | null }>,
 *   checks: Check[] }} KeptReport
 */

const REPORTS = 'seo_reports';

/** Merchant database index of the kept reports. @type {import('@ss/app-kit').IndexDefinition[]} */
export const SEO_REPORT_INDEXES = [{ collection: REPORTS, keys: { websiteId: 1 }, name: 'by_website', unique: true }];

/**
 * @param {WebsiteData} data the guarded merchant database of one website
 * @param {{ merchantId: string }} context
 */
export const createReportStore = (data, { merchantId }) => {
	const reports = data.collection(REPORTS);
	const websiteId = data.websiteId;
	return Object.freeze({
		/**
		 * The last full report, or null (one read).
		 * @returns {Promise<KeptReport | null>}
		 */
		kept: async () =>
			/** @type {KeptReport | null} */ (
				await reports.findOne({ websiteId }, { projection: { _id: 0, checkedAt: 1, pages: 1, checks: 1 } })
			),

		/**
		 * Keep a full report in place of the last one (one write).
		 * @param {KeptReport} report
		 */
		keep: async ({ checkedAt, pages, checks }) => {
			await reports.updateOne(
				{ websiteId },
				{ $set: { checkedAt, pages, checks }, $setOnInsert: { merchantId } },
				{ upsert: true },
			);
		},
	});
};
