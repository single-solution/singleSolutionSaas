/**
 * Staff operations reads of the `system` module: the audit log search. Read only; nothing is stored here.
 * @module
 */

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */

const AUDIT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const AUDIT_ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?$/;

/**
 * Validate the audit search query (`actorId`, `targetId`, `action`); unknown keys are ignored.
 * @param {Record<string, string | undefined>} query
 * @returns {{ ok: true, value: { actorId?: string, targetId?: string, action?: string } } |
 *   { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const parseAuditQuery = (query) => {
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	/** @type {Record<string, string>} */
	const value = {};
	/** @param {string} key @param {RegExp} pattern @param {string} message */
	const take = (key, pattern, message) => {
		const v = query[key];
		if (v === undefined || v === '') return;
		if (typeof v !== 'string' || v.length > 160 || !pattern.test(v)) errors.push({ path: `/${key}`, message });
		else value[key] = v;
	};
	take('actorId', AUDIT_ID, 'actorId is invalid');
	take('targetId', AUDIT_ID, 'targetId is invalid');
	take('action', AUDIT_ACTION, 'action must be a dotted action, optionally ending in .*');
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Audit entry as the admin API shows it (no IP address).
 * @param {Record<string, any>} doc
 */
export const presentAuditEntry = (doc) => ({
	auditId: String(doc._id),
	at: new Date(doc.at).toISOString(),
	action: doc.action,
	actor: doc.actor,
	target: doc.target,
	merchantId: doc.merchantId ?? null,
	reason: doc.reason ?? null,
	before: doc.before ?? null,
	after: doc.after ?? null,
	requestId: doc.requestId ?? null,
});

/**
 * @param {ModuleContext} ctx
 */
export const createOps = (ctx) =>
	Object.freeze({
		/**
		 * Newest-first audit entries.
		 * @param {{ actorId?: string, targetId?: string, action?: string,
		 *   before: { at: string | number, id: string } | null, limit: number }} query
		 */
		auditEntries: async ({ before, limit, ...filter }) =>
			(
				await ctx.audit.list({
					...filter,
					before: before ? { at: new Date(before.at), id: before.id } : null,
					limit,
				})
			).map(presentAuditEntry),
	});
/** @typedef {ReturnType<typeof createOps>} Ops */
