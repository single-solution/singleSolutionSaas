/**
 * Notices (PLAN 0.4.12): signed Portal → product messages `{ type, websiteId?, subject? }` posted to
 * `<base>/.well-known/ss-events` with `@ss/protocol` `signNotice` (the Portal key). Each notice is queued in
 * `catalog_notices` and sent right after the request that caused it (outside a request: at once). A product that does
 * not answer 2xx keeps its notices; they are sent again, oldest first, right after that product's next call to any
 * `/v1/product/*` route, and dropped once it answers 2xx. An identical notice already waiting is not queued twice.
 * @module
 */
import { createId } from '@ss/contracts';
import { isNetError, safeFetch as netFetch } from '@ss/net';
import { NOTICE_PATH, signNotice } from '@ss/protocol';
import { afterResponse } from '../../infra/request-scope.js';
import { NOTICES, PRODUCTS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/** @typedef {import('./service.js').SafeFetch} SafeFetch */
/**
 * @typedef {{ type: 'status.changed' | 'token.revoked' | 'website.deleted', websiteId: string }
 *   | { type: 'sessions.revoked', subject: string }} NoticeBody
 */

/** At most this many notices go to one product after one request. */
const NOTICE_BATCH = 50;
const NOTICE_TIMEOUT_MS = 5_000;

/**
 * @param {{ ctx: ModuleContext, policy: OutboundPolicy, fetch?: SafeFetch }} input
 */
export const createNotices = ({ ctx, policy, fetch = netFetch }) => {
	const notices = /** @type {import('../../infra/db.js').MutableOps} */ (ctx.collection(NOTICES));
	const products = /** @type {import('../../infra/db.js').MutableOps} */ (ctx.collection(PRODUCTS));

	/**
	 * Send one product's waiting notices, oldest first; stop at the first one it does not take.
	 * @param {string} productId
	 * @returns {Promise<{ delivered: number, waiting: number }>}
	 */
	const deliver = async (productId) => {
		const product = await products.findOne({ _id: productId });
		const waiting = await notices.find({ productId }).sort({ queuedAt: 1, _id: 1 }).limit(NOTICE_BATCH).toArray();
		if (!product || waiting.length === 0) return { delivered: 0, waiting: waiting.length };
		let delivered = 0;
		for (const notice of waiting) {
			const body = String(notice.body);
			/** @type {string | null} */
			let failure = null;
			try {
				const headers = await signNotice({ signer: ctx.keys.signer, body, timestamp: Math.floor(ctx.now() / 1000) });
				const res = await fetch(
					`${product.baseUrl}${NOTICE_PATH}`,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json', ...headers },
						body,
						timeoutMs: NOTICE_TIMEOUT_MS,
						maxBytes: 16 * 1024,
						redirect: 'error',
					},
					policy,
				);
				if (res.status < 200 || res.status > 299) failure = `status ${res.status}`;
			} catch (error) {
				if (!isNetError(error)) throw error;
				failure = error.code;
			}
			if (failure !== null) {
				await notices.updateOne(
					{ _id: notice._id },
					{ $inc: { attempts: 1 }, $set: { lastError: failure, lastAttemptAt: new Date(ctx.now()) } },
				);
				ctx.logger.warn('notice not delivered', { productId, type: notice.type, reason: failure });
				break;
			}
			await notices.deleteOne({ _id: notice._id });
			delivered += 1;
		}
		return { delivered, waiting: waiting.length - delivered };
	};

	/**
	 * Deliver right after the current request (or at once outside one).
	 * @param {string} productId
	 */
	const schedule = async (productId) => {
		const task = async () => {
			try {
				await deliver(productId);
			} catch (error) {
				ctx.logger.warn('notices failed', { productId, error });
			}
		};
		if (!afterResponse(task)) await task();
	};

	/**
	 * Queue a notice for a product and send it right after the request.
	 * @param {string} productId
	 * @param {NoticeBody} body
	 */
	const notify = async (productId, body) => {
		const text = JSON.stringify(body);
		if (!(await notices.findOne({ productId, body: text })))
			await notices.insertOne({
				_id: createId('ntc', { randomBytes: ctx.randomBytes }),
				productId,
				type: body.type,
				body: text,
				queuedAt: new Date(ctx.now()),
				attempts: 0,
			});
		await schedule(productId);
	};

	return Object.freeze({
		notify,
		/**
		 * Queue a notice for every connected product (`sessions.revoked`).
		 * @param {NoticeBody} body
		 */
		notifyAll: async (body) => {
			const all = await products.find({}).project({ _id: 1 }).sort({ _id: 1 }).toArray();
			for (const product of all) await notify(String(product._id), body);
		},
		/** `productCalled` port: retry the product's waiting notices. */
		deliver,
		/**
		 * Notices waiting for a product (tests and the product page).
		 * @param {string} productId
		 */
		waiting: (productId) => notices.countDocuments({ productId }),
	});
};
/** @typedef {ReturnType<typeof createNotices>} Notices */
