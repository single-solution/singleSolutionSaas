/**
 * Append-only audit log (`platform_audit`). The repository is append-only, so no
 * code path in the Portal can update or delete an entry; retention is governed by backups, not by TTL.
 *
 * Every entry records who (`actor`), what (`action`, `target`), the change (`before`/`after`, redacted with the
 * logger rules so credentials never land in the log), and where from (`requestId`, `ip`). `merchantId` is
 * denormalised so merchant consoles can list their own history.
 * @module
 */
import { createId } from '@ss/contracts';
import { platformError } from './errors.js';
import { redact } from './logger.js';
import { defaultRandomBytes, isObject } from './util.js';

/** @typedef {import('./db.js').ReadOps} ReadOps */
/** @typedef {import('./rbac.js').Actor} Actor */

const AUDIT_ACTOR_TYPES = Object.freeze(['admin', 'merchant', 'product', 'system']);

/**
 * @typedef {object} AuditInput
 * @property {{ type: 'admin' | 'merchant' | 'product' | 'system', id: string, name?: string | null } | Actor} actor
 *   an admin's name is kept with the entry, so Activity still names a removed admin (PLAN 0.8.2)
 * @property {string} action dotted verb, e.g. `website.created`, `credits.adjusted`
 * @property {{ type: string, id: string, merchantId?: string | null, websiteId?: string | null }} target
 * @property {unknown} [before]
 * @property {unknown} [after]
 * @property {string | null} [requestId]
 * @property {string | null} [ip]
 * @property {string | null} [reason] free-text justification (required by some admin actions)
 */

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * @param {unknown} actor
 * @returns {{ type: string, id: string, name?: string }}
 */
const normaliseActor = (actor) => {
	if (!isObject(actor) || typeof actor.id !== 'string' || actor.id.length === 0)
		throw platformError('invalid_argument', 'audit actor needs an id');
	// only admins, merchants, products and the system act
	if (!AUDIT_ACTOR_TYPES.includes(String(actor.type)))
		throw platformError('invalid_argument', `audit actor type must be one of ${AUDIT_ACTOR_TYPES.join(', ')}`);
	const name = actor.type === 'admin' && typeof actor.name === 'string' && actor.name.length > 0 ? actor.name : null;
	return { type: String(actor.type), id: actor.id, ...(name ? { name } : {}) };
};

/**
 * JSON-normalised value (what MongoDB stores and returns unchanged): `undefined` members dropped, Dates as ISO.
 * @param {unknown} value
 */
const jsonValue = (value) => {
	const text = JSON.stringify(value);
	return text === undefined ? null : JSON.parse(text);
};

/**
 * @param {{ repo: ReadOps, now?: () => number, randomBytes?: (n: number) => Uint8Array }} options
 */
export const createAudit = ({ repo, now = Date.now, randomBytes = defaultRandomBytes }) => {
	/**
	 * @param {AuditInput} input
	 * @returns {Promise<string>} the entry id
	 */
	const record = async ({ actor, action, target, before, after, requestId = null, ip = null, reason = null }) => {
		if (typeof action !== 'string' || !ACTION.test(action))
			throw platformError('invalid_argument', 'audit action must be a dotted lower-case verb');
		if (!isObject(target) || typeof target.type !== 'string' || typeof target.id !== 'string') {
			throw platformError('invalid_argument', 'audit target needs a type and an id');
		}
		const id = createId('aud', { randomBytes });
		await repo.insertOne({
			_id: id,
			at: new Date(now()),
			actor: normaliseActor(actor),
			action,
			target: { type: target.type, id: target.id, websiteId: target.websiteId ?? null },
			merchantId: target.merchantId ?? null,
			...(before === undefined ? {} : { before: jsonValue(redact(before)) }),
			...(after === undefined ? {} : { after: jsonValue(redact(after)) }),
			requestId,
			ip,
			reason,
		});
		return id;
	};

	/**
	 * Newest-first entries. `before` is the `{ at, id }` of the last entry of the previous page (keyset pagination
	 * over the `{ at: -1, _id: -1 }` order).
	 * `action` is an exact action or a dotted prefix ending in `.*` (`credits.*`). `from` and `to` bound the time
	 * ([from, to)).
	 * @param {{ merchantId?: string | null, action?: string, targetId?: string, actorId?: string,
	 *   from?: Date | null, to?: Date | null, before?: { at: Date | number, id: string } | null, limit?: number }} [query]
	 */
	const list = async ({ merchantId, action, targetId, actorId, from = null, to = null, before = null, limit = 50 } = {}) => {
		/** @type {Record<string, unknown>} */
		const filter = {};
		if (merchantId !== undefined) filter.merchantId = merchantId;
		if (from || to) filter.at = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
		if (action)
			filter.action = action.endsWith('.*')
				? { $regex: `^${action.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` }
				: action;
		if (targetId) filter['target.id'] = targetId;
		if (actorId) filter['actor.id'] = actorId;
		if (before) {
			const at = new Date(before.at);
			filter.$and = [{ $or: [{ at: { $lt: at } }, { at, _id: { $lt: before.id } }] }];
		}
		const n = Math.min(Math.max(1, Math.floor(limit)), 200);
		return repo.find(filter).sort({ at: -1, _id: -1 }).limit(n).toArray();
	};

	return Object.freeze({ record, list });
};
/** @typedef {ReturnType<typeof createAudit>} Audit */
