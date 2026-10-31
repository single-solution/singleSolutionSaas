/**
 * The activity log and its copies to Accounts (PLAN 0.4.11, 0.8.10 K9). Each product keeps a log of actions done
 * through its widgets or API in the merchant database (`ss_<product id>_activity`): who (`actor`: kind, id, name and
 * the acting user's role), what (`action`), on what (`target`, and its `label`, for example an order number), when, and
 * what changed: `values` (codes, numbers and yes/no that the product's texts put into words, A8: no sentence in one
 * language is stored) or an optional plain-text `detail` (never message contents, secrets or addresses). When
 * Accounts is on the website (the Portal links the products), every entry is also sent to Accounts right after the request
 * (`POST <accounts>/v1/activity-copies`). Unsent entries stay marked `pending` and are retried right after this
 * product's next request for that website. When Accounts refuses them (its activity copies feature off, the token
 * refused …), an instance sends none of that website's copies for {@link REFUSED_PAUSE_MS}, each copy waiting is
 * counted as refused once more, and after {@link COPY_TRIES} refusals it is marked `dropped` (RT-5); this is logged
 * at most once a day per website and instance.
 *
 * The merchant's server reads the log with `GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor=` (server token,
 * newest first), with counts (`/count`, `/counts?by=action|actor`). A website's settings saves are entries too
 * (`settings.changed`, written by the kit's `settingsChanged`).
 * @module
 */
import { createId, validateActivityCopy } from '@ss/contracts';
import { zonedDayStart } from '@ss/contracts/format';
import { ObjectId } from 'mongodb';
import { kitError } from './util.js';

/** @typedef {{ kind: string, id: string, name?: string, role?: string }} Actor */
/** @typedef {{ websiteId: string, merchantId: string | null, after: (task: () => Promise<unknown>) => void }} ActivityContext */
/**
 * @typedef {{ actor: Actor, action: string, target: string, label?: string, detail?: string,
 *   values?: Record<string, string | number | boolean> }} ActivityEntry
 */

/** Path of the Accounts route that receives copies. */
const ACTIVITY_COPY_PATH = '/v1/activity-copies';
const RETRY_BATCH = 20;
/** Refusals of Accounts a copy waits through before it is dropped (RT-5). */
const COPY_TRIES = 3;
/** After Accounts refused a copy, an instance sends none of that website's copies for this long. */
const REFUSED_PAUSE_MS = 15 * 60_000;
/** Refused copies of a website are logged at most this often per instance. */
const REFUSED_LOG_EVERY_MS = 24 * 3_600_000;
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

/**
 * True when Accounts answered and refused a copy (a refused token, its feature off, Accounts stopped for the website, a
 * copy it does not take), not when it could not be reached or asked to wait (408, 429).
 * @param {import('./connections.js').ProductCall} result
 */
const copyRefused = (result) =>
	!result.ok &&
	(result.reason === 'refused' ||
		(result.reason === 'failed' && result.status !== 408 && result.status !== 429) ||
		(result.reason === 'unavailable' && result.status === 403));

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
 * The database filter of an activity list and its counts (`GET /v1/activity`; also a product's own copies of activity
 * entries, such as Accounts' activity-log copies), without the website: `actor` (an actor id), `action` (one, or
 * several separated by commas), `target`, `q` (a search in the label, the detail, the actor's name and the target) and
 * `from`/`to` (ISO-8601 times, or days in the business time zone; `to` takes its whole day). A query value that does
 * not fit answers which one and why.
 * @param {Record<string, string | undefined>} query the request's query
 * @param {string} timeZone the business time zone (days are business days, PLAN 0.8.10 K8)
 * @returns {{ ok: true, filter: Record<string, unknown> } | { ok: false, field: string, message: string }}
 */
export const activityFilter = (query, timeZone) => {
	/** @type {Record<string, unknown>} */
	const filter = {};
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
	values: entry.values ?? {},
	at: new Date(entry.at).toISOString(),
});

/**
 * @param {{ productId: string, data: import('./data.js').Data, connections: import('./connections.js').Connections,
 *   now: () => number, logger: import('@ss/net').Logger }} options
 */
export const createActivity = ({ productId, data, connections, now, logger }) => {
	/** Per instance: websites known to have no unsent copies. @type {Set<string>} */
	const clean = new Set();
	/** Per instance: websites whose copies Accounts refused, until when none is sent. @type {Map<string, number>} */
	const pausedUntil = new Map();
	/** Per instance: when refused copies of a website were last logged. @type {Map<string, number>} */
	const loggedAt = new Map();

	/** @param {string} websiteId */
	const hasAccounts = async (websiteId) =>
		connections.declaresLink('accounts') && (await connections.hasLink(websiteId, 'accounts'));

	/**
	 * Send unsent copies of a website, oldest first; stops at the first failure. A refusal counts once more for every
	 * copy of the batch (Accounts refuses the website, not one copy), drops those refused {@link COPY_TRIES} times and
	 * pauses the website's copies on this instance.
	 * @param {string} websiteId
	 * @param {string | null} merchantId
	 */
	const forward = async (websiteId, merchantId) => {
		if (now() < (pausedUntil.get(websiteId) ?? 0)) return;
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
				...(entry.values ? { values: entry.values } : {}),
				at: entry.at.toISOString(),
			};
			const result = await connections.callProduct(websiteId, 'accounts', ACTIVITY_COPY_PATH, { method: 'POST', body: copy });
			if (copyRefused(result)) {
				const waiting = pending.slice(pending.indexOf(entry)).map((row) => row._id);
				await log.updateMany({ websiteId, copy: 'pending', _id: { $in: waiting } }, { $inc: { copyTries: 1 } });
				const dropped = await log.updateMany(
					{ websiteId, copy: 'pending', copyTries: { $gte: COPY_TRIES } },
					{ $set: { copy: 'dropped' } },
				);
				pausedUntil.set(websiteId, now() + REFUSED_PAUSE_MS);
				if (now() - (loggedAt.get(websiteId) ?? -Infinity) >= REFUSED_LOG_EVERY_MS) {
					loggedAt.set(websiteId, now());
					logger.warn('activity copies refused by Accounts; each is dropped after 3 refusals', {
						websiteId,
						status: result.ok ? 200 : result.status,
						dropped: dropped.modifiedCount,
					});
				}
				return;
			}
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
		 * `label` and `detail` are cut to 200 and 2,000 characters; `values` are at most 20 codes, numbers or yes/no.
		 * @param {ActivityContext} ctx the request context
		 * @param {ActivityEntry} entry
		 * @param {{ copy?: boolean }} [options] `copy: false` keeps the entry in the merchant database only (imports)
		 */
		record: async (ctx, { actor, action, target, label, detail, values }, { copy: copied = true } = {}) => {
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
				...(values && Object.keys(values).length > 0 ? { values } : {}),
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
					'activity entries need actor { kind, id, name?, role? }, action and target (label and detail are text, values at most 20 codes, numbers or yes/no)',
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
			if (clean.has(websiteId) || now() < (pausedUntil.get(websiteId) ?? 0)) return;
			if (!(await hasAccounts(websiteId))) {
				clean.add(websiteId);
				return;
			}
			await forward(websiteId, merchantId);
		},
	});
};

/** @typedef {ReturnType<typeof createActivity>} Activity */
