/**
 * The activity log and its copies to Accounts (PLAN 0.4.11). Each product keeps a log of actions done through its
 * widgets or API in the merchant database (`ss_<product id>_activity`). When the merchant pasted the website's
 * Accounts server token, every entry is also sent to Accounts right after the request (`POST <accounts>/v1/activity-
 * copies`, provisional until Accounts is grilled): actor, action, target and time, never contents. Unsent entries stay
 * marked `pending` and are retried right after this product's next request for that website.
 * @module
 */
import { validateActivityCopy } from '@ss/contracts';
import { kitError } from './util.js';

/** @typedef {{ kind: string, id: string, name?: string }} Actor */
/** @typedef {{ websiteId: string, merchantId: string | null, after: (task: () => Promise<unknown>) => void }} ActivityContext */

/** Path of the provisional Accounts route that receives copies. */
export const ACTIVITY_COPY_PATH = '/v1/activity-copies';
const RETRY_BATCH = 20;

/**
 * @param {{ productId: string, data: import('./data.js').Data, connections: import('./connections.js').Connections,
 *   now: () => number, logger: import('./logger.js').Logger }} options
 */
export const createActivity = ({ productId, data, connections, now, logger }) => {
	const accountsConnection = Object.entries(connections.definitions).find(
		([, def]) => def.kind === 'token' && def.productId === 'accounts',
	)?.[0];
	/** Per instance: websites known to have no unsent copies. @type {Set<string>} */
	const clean = new Set();

	/** @param {string} websiteId */
	const hasAccounts = async (websiteId) =>
		accountsConnection !== undefined && (await connections.value(websiteId, accountsConnection)) !== null;

	/**
	 * Send unsent copies of a website, oldest first; stops at the first failure.
	 * @param {string} websiteId
	 * @param {string | null} merchantId
	 */
	const forward = async (websiteId, merchantId) => {
		const db = await data.forWebsite(websiteId, merchantId ? { merchantId } : {});
		const log = db.collection('activity');
		const pending = await log.find({ websiteId, copy: 'pending' }).sort({ at: 1 }).limit(RETRY_BATCH).toArray();
		for (const entry of pending) {
			const copy = {
				websiteId,
				productId,
				actor: entry.actor,
				action: entry.action,
				target: entry.target,
				at: entry.at.toISOString(),
			};
			const result = await connections.callProduct(websiteId, 'accounts', ACTIVITY_COPY_PATH, { method: 'POST', body: copy });
			if (!result.ok) {
				logger.info('activity copy not sent; retried on the next request', { websiteId, reason: result.reason });
				return;
			}
			await log.updateOne({ websiteId, _id: entry._id }, { $set: { copy: 'sent' } });
		}
		if (pending.length < RETRY_BATCH) clean.add(websiteId);
	};

	return Object.freeze({
		/**
		 * Write one entry (merchant database) and, with the Accounts token, send its copy right after the request.
		 * @param {ActivityContext} ctx the request context
		 * @param {{ actor: Actor, action: string, target: string }} entry
		 */
		record: async (ctx, { actor, action, target }) => {
			const at = new Date(now());
			const checked = validateActivityCopy({
				websiteId: ctx.websiteId,
				productId,
				actor,
				action,
				target,
				at: at.toISOString(),
			});
			if (!checked.ok)
				throw kitError('invalid_argument', 'activity entries need actor { kind, id, name? }, action and target');
			const copy = (await hasAccounts(ctx.websiteId)) ? 'pending' : 'none';
			const db = await data.forWebsite(ctx.websiteId, ctx.merchantId ? { merchantId: ctx.merchantId } : {});
			await db.collection('activity').insertOne({ actor: checked.value.actor, action, target, at, copy });
			if (copy === 'pending') {
				clean.delete(ctx.websiteId);
				ctx.after(() => forward(ctx.websiteId, ctx.merchantId));
			}
		},
		/**
		 * Retry unsent copies after a request for this website (once known clean, an instance stops looking).
		 * @param {string} websiteId
		 * @param {string | null} merchantId
		 */
		retry: async (websiteId, merchantId) => {
			if (clean.has(websiteId)) return;
			if (!(await hasAccounts(websiteId))) {
				clean.add(websiteId);
				return;
			}
			await forward(websiteId, merchantId);
		},
	});
};

/** @typedef {ReturnType<typeof createActivity>} Activity */
