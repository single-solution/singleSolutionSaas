/**
 * Audit trail for dashboard and API actions (Part E §8, §10). Entries include the actor and are appended to the merchant's own database (`ss_<slug>_audit`, append-only by convention: the
 * kit exposes no update or delete for it). `before`/`after` may contain merchant data, so they never go to logs.
 * Inject `sink` to send entries elsewhere.
 * @module
 */
import { isObject, kitError } from './util.js';

/**
 * @typedef {object} AuditEntry
 * @property {string} websiteId
 * @property {{ type: string, id?: string }} actor
 * @property {string} action e.g. `coupon.created`
 * @property {{ type: string, id?: string } | string} [target]
 * @property {unknown} [before]
 * @property {unknown} [after]
 * @property {string} [requestId]
 */

const ACTION = /^[a-z][a-z0-9_.:-]{0,99}$/;

/**
 * @param {{
 *   data: { forWebsite: (websiteId: string) => Promise<{ collection: (name: string) => { insertOne: (doc: Record<string, unknown>) => Promise<{ insertedId: unknown }> } }> },
 *   now?: () => number,
 *   sink?: ((entry: AuditEntry & { at: string }) => Promise<unknown>) | null,
 * }} options
 */
export const createAudit = ({ data, now = Date.now, sink = null }) => {
	/**
	 * @param {AuditEntry} entry
	 * @returns {Promise<{ ok: true, id?: string }>}
	 */
	const record = async (entry) => {
		if (!isObject(entry) || typeof entry.websiteId !== 'string' || entry.websiteId === '')
			throw kitError('invalid_audit', 'websiteId is required');
		if (!isObject(entry.actor) || typeof entry.actor.type !== 'string')
			throw kitError('invalid_audit', 'actor.type is required');
		if (typeof entry.action !== 'string' || !ACTION.test(entry.action))
			throw kitError('invalid_audit', 'action must be a dotted lower-case name');
		const doc = {
			websiteId: entry.websiteId,
			actor: {
				type: entry.actor.type,
				...(entry.actor.id ? { id: entry.actor.id } : {}),
			},
			action: entry.action,
			...(entry.target === undefined ? {} : { target: entry.target }),
			...(entry.before === undefined ? {} : { before: entry.before }),
			...(entry.after === undefined ? {} : { after: entry.after }),
			...(entry.requestId ? { requestId: entry.requestId } : {}),
			at: new Date(now()).toISOString(),
		};
		if (sink) {
			await sink(doc);
			return { ok: true };
		}
		const scope = await data.forWebsite(entry.websiteId);
		const { insertedId } = await scope.collection('audit').insertOne(doc);
		return { ok: true, id: String(insertedId) };
	};
	return Object.freeze({ record });
};
