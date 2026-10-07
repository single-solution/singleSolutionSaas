/**
 * Activity (PLAN 0.5.12): who, when, what and the target, kept forever. Admins see every entry, filterable by merchant,
 * admin and date (UTC days); a merchant sees the entries about its own account, with admins shown under the Branding
 * name and without internal details (the suspension reason, before/after values). Merchant names come from the
 * merchant records, so a deleted merchant's entries show its business name, marked Deleted; personal details are
 * never written into entries (PLAN 0.5.9).
 * @module
 */

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */

const ID = /^[a-z]{2,8}_[0-9a-z]{10,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the Activity filters (`merchantId`, `adminId`, `from`, `to` as UTC days `YYYY-MM-DD`, both included).
 * @param {Record<string, string | undefined>} query
 * @returns {{ ok: true, value: { merchantId?: string, adminId?: string, from?: Date, to?: Date } } |
 *   { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const parseActivityQuery = (query) => {
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	/** @type {{ merchantId?: string, adminId?: string, from?: Date, to?: Date }} */
	const value = {};
	for (const key of /** @type {const} */ (['merchantId', 'adminId'])) {
		const v = query[key];
		if (v === undefined || v === '') continue;
		if (!ID.test(v)) errors.push({ path: `/${key}`, message: 'must be an id' });
		else value[key] = v;
	}
	for (const key of /** @type {const} */ (['from', 'to'])) {
		const v = query[key];
		if (v === undefined || v === '') continue;
		const ms = DAY.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
		if (!Number.isFinite(ms)) errors.push({ path: `/${key}`, message: 'must be a day YYYY-MM-DD' });
		else value[key] = new Date(key === 'to' ? ms + 86_400_000 : ms);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * @param {ModuleContext} ctx
 */
export const createActivity = (ctx) => {
	/**
	 * Entries as a viewer sees them.
	 * @param {Array<Record<string, any>>} docs
	 * @param {{ type: 'admin' | 'merchant' }} viewer
	 */
	const present = async (docs, viewer) => {
		const ids = docs.flatMap((d) => [d.merchantId, d.actor?.type === 'merchant' ? d.actor.id : null]).filter(Boolean);
		/** @type {Map<string, { name: string, deleted: boolean }>} */
		const names = ids.length > 0 ? await ctx.service('identity').merchantNames(ids) : new Map();
		const brand = ctx.config.settings.branding.name;
		return docs.map((d) => {
			const merchant = d.merchantId ? names.get(d.merchantId) : null;
			const actorMerchant = d.actor?.type === 'merchant' ? names.get(d.actor.id) : null;
			const actorName =
				d.actor?.type === 'admin'
					? viewer.type === 'admin'
						? (d.actor.name ?? null)
						: brand
					: d.actor?.type === 'merchant'
						? actorMerchant?.deleted
							? 'Deleted merchant'
							: (actorMerchant?.name ?? null)
						: null;
			return {
				activityId: String(d._id),
				at: new Date(d.at).toISOString(),
				action: d.action,
				actor: {
					type: d.actor?.type ?? 'system',
					id: viewer.type === 'admin' || d.actor?.type !== 'admin' ? (d.actor?.id ?? null) : null,
					name: actorName,
				},
				target: { type: d.target?.type ?? null, id: d.target?.id ?? null, websiteId: d.target?.websiteId ?? null },
				merchantId: d.merchantId ?? null,
				merchantName: merchant?.name ?? null,
				merchantDeleted: merchant?.deleted ?? false,
				...(viewer.type === 'admin' ? { reason: d.reason ?? null, before: d.before ?? null, after: d.after ?? null } : {}),
			};
		});
	};

	return Object.freeze({
		/**
		 * Newest-first entries for a viewer: admins with optional filters; merchants their own only.
		 * @param {{ viewer: { type: 'admin' | 'merchant', merchantId?: string }, merchantId?: string, adminId?: string,
		 *   from?: Date, to?: Date, actorId?: string, before: { at: string | number, id: string } | null, limit: number }} query
		 */
		list: async ({ viewer, merchantId, adminId, from, to, actorId, before, limit }) => {
			const docs = await ctx.audit.list({
				...(viewer.type === 'merchant' ? { merchantId: viewer.merchantId ?? '' } : merchantId ? { merchantId } : {}),
				...(adminId ? { actorId: adminId } : actorId ? { actorId } : {}),
				...(from ? { from } : {}),
				...(to ? { to } : {}),
				before: before ? { at: new Date(before.at), id: before.id } : null,
				limit,
			});
			return { items: await present(docs, viewer) };
		},
	});
};
/** @typedef {ReturnType<typeof createActivity>} Activity */
