/**
 * The activity log and its copies to Accounts (PLAN 0.4.11, 0.8.10 K9). Each product keeps a log of actions done
 * through its widgets or API in the merchant database (`ss_<product id>_activity`): who (`actor`: kind, id, name and
 * the acting user's role), what (`action`), on what (`target`, and its `label`, for example an order number), when, and
 * an optional plain-text `detail` (never message contents, secrets or addresses). When the merchant pasted the
 * website's Accounts server token, every entry is also sent to Accounts right after the request
 * (`POST <accounts>/v1/activity-copies`). Unsent entries stay marked `pending` and are retried right after this
 * product's next request for that website.
 *
 * The merchant's server reads the log with `GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor=` (server token,
 * newest first), with counts (`/count`, `/counts?by=action|actor`).
 * @module
 */
import { createId, validateActivityCopy, zonedDayStart } from '@ss/contracts';
import { ObjectId } from 'mongodb';
import { kitError } from './util.js';

/** @typedef {{ kind: string, id: string, name?: string, role?: string }} Actor */
/** @typedef {{ websiteId: string, merchantId: string | null, after: (task: () => Promise<unknown>) => void }} ActivityContext */
/**
 * @typedef {{ actor: Actor, action: string, target: string, label?: string, detail?: string }} ActivityEntry
 */

/** Path of the Accounts route that receives copies. */
const ACTIVITY_COPY_PATH = '/v1/activity-copies';
const RETRY_BATCH = 20;
const MAX_LABEL = 200;
const MAX_DETAIL = 2000;
const MAX_QUERY = 100;
const ACTION = /^[a-z][a-z0-9_.]{0,63}$/;

/** Merchant database indexes of the activity log (created with the product's own). */
export const ACTIVITY_INDEXES = Object.freeze(
	/** @type {import('./data.js').IndexDefinition[]} */ ([
		{ collection: 'activity', keys: { websiteId: 1, at: -1, _id: -1 }, name: 'kit_activity_newest' },
		{ collection: 'activity', keys: { websiteId: 1, 'actor.id': 1, at: -1 }, name: 'kit_activity_actor' },
		{ collection: 'activity', keys: { websiteId: 1, target: 1, at: -1 }, name: 'kit_activity_target' },
		{ collection: 'activity', keys: { websiteId: 1, copy: 1, at: 1 }, name: 'kit_activity_copies' },
	]),
);

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A time filter bound: an ISO-8601 instant, or a day (`YYYY-MM-DD`) in the business time zone (`to` is the end of it).
 * @param {unknown} value
 * @param {string} timeZone
 * @param {boolean} end
 * @returns {Date | null | undefined} undefined when absent, null when invalid
 */
const boundOf = (value, timeZone, end) => {
	if (value === undefined || value === '') return undefined;
	const text = String(value);
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		const start = zonedDayStart(text, timeZone);
		if (Number.isNaN(start)) return null;
		if (!end) return new Date(start);
		const next = new Date(Date.parse(`${text}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
		return new Date(zonedDayStart(next, timeZone));
	}
	const at = Date.parse(text);
	return Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}T/.test(text) ? null : new Date(at);
};

/**
 * The merchant database filter of `GET /v1/activity` (and its counts) for a website.
 * @param {string} websiteId
 * @param {Record<string, string>} query
 * @param {string} timeZone the business.json time zone (days are business days, PLAN 0.8.10 K8)
 * @returns {{ ok: true, filter: Record<string, unknown> } | { ok: false, field: string, message: string }}
 */
export const activityFilter = (websiteId, query, timeZone) => {
	/** @type {Record<string, unknown>} */
	const filter = { websiteId };
	if (query.actor !== undefined && query.actor !== '') {
		if (query.actor.length > 256) return { ok: false, field: 'actor', message: 'actor is an actor id.' };
		filter['actor.id'] = query.actor;
	}
	if (query.action !== undefined && query.action !== '') {
		const actions = query.action.split(',').map((action) => action.trim());
		if (actions.length > 20 || actions.some((action) => !ACTION.test(action)))
			return { ok: false, field: 'action', message: 'action is one action, or several separated by commas.' };
		filter.action = actions.length === 1 ? actions[0] : { $in: actions };
	}
	if (query.target !== undefined && query.target !== '') {
		if (query.target.length > 256) return { ok: false, field: 'target', message: 'target is a target id.' };
		filter.target = query.target;
	}
	if (query.q !== undefined && query.q.trim() !== '') {
		const pattern = { $regex: escapeRegex(query.q.trim().slice(0, MAX_QUERY)), $options: 'i' };
		filter.$or = [{ label: pattern }, { detail: pattern }, { 'actor.name': pattern }, { target: pattern }];
	}
	const from = boundOf(query.from, timeZone, false);
	const to = boundOf(query.to, timeZone, true);
	if (from === null) return { ok: false, field: 'from', message: 'from is an ISO-8601 time or a day (YYYY-MM-DD).' };
	if (to === null) return { ok: false, field: 'to', message: 'to is an ISO-8601 time or a day (YYYY-MM-DD).' };
	if (from || to) filter.at = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
	return { ok: true, filter };
};

/**
 * Keyset filter for newest-first pages by `[at, _id]`.
 * @param {unknown} after the cursor key
 */
export const activityPage = (after) => {
	const [time, id] = Array.isArray(after) ? after : [];
	if (typeof time !== 'string' || typeof id !== 'string' || !ObjectId.isValid(id)) return {};
	const at = new Date(time);
	return { $or: [{ at: { $lt: at } }, { at, _id: { $lt: new ObjectId(id) } }] };
};

/**
 * An entry as the API answers it.
 * @param {Record<string, any>} entry
 */
export const activityView = (entry) => ({
	id: String(entry.id ?? entry._id),
	actor: entry.actor,
	action: entry.action,
	target: entry.target,
	label: entry.label ?? null,
	detail: entry.detail ?? null,
	at: new Date(entry.at).toISOString(),
});

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
				...(entry.label ? { label: entry.label } : {}),
				...(entry.detail ? { detail: entry.detail } : {}),
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
		 * `label` and `detail` are cut to 200 and 2,000 characters.
		 * @param {ActivityContext} ctx the request context
		 * @param {ActivityEntry} entry
		 * @param {{ copy?: boolean }} [options] `copy: false` keeps the entry in the merchant database only (imports)
		 */
		record: async (ctx, { actor, action, target, label, detail }, { copy: copied = true } = {}) => {
			const at = new Date(now());
			const who = {
				kind: actor?.kind,
				id: actor?.id,
				...(actor?.name === undefined ? {} : { name: actor.name }),
				...(actor?.role === undefined ? {} : { role: actor.role }),
			};
			const extra = {
				...(typeof label === 'string' && label !== '' ? { label: label.slice(0, MAX_LABEL) } : {}),
				...(typeof detail === 'string' && detail !== '' ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
			};
			const checked = validateActivityCopy({
				websiteId: ctx.websiteId,
				productId,
				actor: who,
				action,
				target,
				...extra,
				at: at.toISOString(),
			});
			if (!checked.ok)
				throw kitError(
					'invalid_argument',
					'activity entries need actor { kind, id, name?, role? }, action and target (label and detail are text)',
				);
			const copy = copied && (await hasAccounts(ctx.websiteId)) ? 'pending' : 'none';
			const db = await data.forWebsite(ctx.websiteId, ctx.merchantId ? { merchantId: ctx.merchantId } : {});
			await db
				.collection('activity')
				.insertOne({ id: createId('act'), actor: checked.value.actor, action, target, ...extra, at, copy });
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
