/**
 * Claims (pure): the status machine, building a claim from a validated submission against the purchase's eligibility,
 * the refund cap and the restock plan. Statuses, transitions, types and reasons are the merchant's data; nothing here
 * knows a status name. A claim is "released" once it reaches a status of kind `rejected`: its units become claimable
 * again (also after it is closed).
 * @module
 */

/** @typedef {'open' | 'resolved' | 'rejected' | 'closed'} StatusKind */
/** @typedef {{ key: string, label: string, kind: StatusKind, description?: string }} Status */
/** @typedef {{ from: string, to: string }} Transition */
/** @typedef {{ key: string, label: string, types?: string[], details_required?: boolean }} Reason */
/** @typedef {import('./windows.js').ClaimType} ClaimType */
/** @typedef {import('./windows.js').LineEligibility} LineEligibility */
/** @typedef {{ path: string, code: string }} FieldProblem */

/**
 * @param {Status[]} statuses
 * @returns {Map<string, Status>}
 */
export const statusIndex = (statuses) => new Map(statuses.map((status) => [status.key, status]));

/**
 * Kind of a status (`open` when unknown, so a claim never silently disappears from the queue).
 * @param {Status[]} statuses
 * @param {string} key
 * @returns {StatusKind}
 */
export const kindOf = (statuses, key) => statuses.find((status) => status.key === key)?.kind ?? 'open';

/**
 * Statuses that may follow `from` (only known statuses).
 * @param {Transition[]} transitions
 * @param {Status[]} statuses
 * @param {string} from
 * @returns {string[]}
 */
export const nextStatuses = (transitions, statuses, from) => {
	const known = statusIndex(statuses);
	return [...new Set(transitions.filter((t) => t.from === from && known.has(t.to)).map((t) => t.to))];
};

/**
 * @param {Transition[]} transitions
 * @param {Status[]} statuses
 * @param {string} from
 * @param {string} to
 */
export const canTransition = (transitions, statuses, from, to) => nextStatuses(transitions, statuses, from).includes(to);

/**
 * Short human reference of a claim, e.g. `CL-3F9A2C` (last 6 characters of the id).
 * @param {string} id
 */
export const claimReference = (id) => `CL-${id.slice(-6).toUpperCase()}`;

/**
 * @typedef {object} ClaimInput validated submission
 * @property {string} purchaseId
 * @property {string} type
 * @property {string} reason
 * @property {string} details
 * @property {Array<{ lineId: string, quantity: number, serial: string | null }>} lines
 * @property {string[]} photoIds
 */

/**
 * @typedef {object} BuildInput
 * @property {string} id
 * @property {ClaimInput} input
 * @property {Record<string, any>} purchase
 * @property {LineEligibility[]} eligibility
 * @property {ClaimType[]} types
 * @property {Reason[]} reasons
 * @property {number} maxLines
 * @property {(raw: string) => string | null} serialKeyOf the registry key of a serial
 * @property {Map<string, Set<string>>} knownSerials serial keys registered per line id (lines without any accept any)
 * @property {string} status initial status
 * @property {'identity' | 'token' | 'server'} via
 * @property {string[]} customerKeys
 * @property {number} slaHours 0 = no due time
 * @property {number} now
 */

/**
 * A new claim, or why it cannot be made.
 * @param {BuildInput} build
 * @returns {{ ok: true, claim: Record<string, any> } | { ok: false, reason: string, errors: FieldProblem[] }}
 */
export const buildClaim = (build) => {
	const { input, purchase, eligibility, types, reasons } = build;
	const type = types.find((entry) => entry.key === input.type && entry.enabled !== false);
	if (!type) return { ok: false, reason: 'validation_failed', errors: [{ path: '/type', code: 'type_invalid' }] };
	const reason = reasons.find((entry) => entry.key === input.reason);
	if (!reason || ((reason.types?.length ?? 0) > 0 && !reason.types?.includes(type.key)))
		return { ok: false, reason: 'validation_failed', errors: [{ path: '/reason', code: 'reason_invalid' }] };
	const minDetails = Math.max(type.details_min_length ?? 0, reason.details_required ? 1 : 0);
	if (input.details.length < minDetails)
		return { ok: false, reason: 'validation_failed', errors: [{ path: '/details', code: 'too_short' }] };
	if (input.lines.length > build.maxLines)
		return { ok: false, reason: 'validation_failed', errors: [{ path: '/lines', code: 'too_many' }] };
	if (input.photoIds.length < (type.min_photos ?? 0))
		return { ok: false, reason: 'validation_failed', errors: [{ path: '/photoIds', code: 'photos_required' }] };
	const byId = new Map(eligibility.map((entry) => [entry.line.lineId, entry]));
	/** @type {Map<string, number>} */
	const wanted = new Map();
	for (const line of input.lines) wanted.set(line.lineId, (wanted.get(line.lineId) ?? 0) + line.quantity);
	/** @type {Array<Record<string, any>>} */
	const lines = [];
	for (const [index, requested] of input.lines.entries()) {
		const path = `/lines/${index}`;
		const entry = byId.get(requested.lineId);
		if (!entry) return { ok: false, reason: 'validation_failed', errors: [{ path: `${path}/lineId`, code: 'line_unknown' }] };
		const span = entry.windows[type.key];
		if (!span?.eligible)
			return {
				ok: false,
				reason: 'not_eligible',
				errors: [{ path, code: span ? span.reason : 'no_window' }],
			};
		if (/** @type {number} */ (wanted.get(requested.lineId)) > entry.claimable)
			return { ok: false, reason: 'quantity_unavailable', errors: [{ path: `${path}/quantity`, code: 'too_many' }] };
		/** @type {string | null} */
		let serial = null;
		if (requested.serial !== null) {
			serial = build.serialKeyOf(requested.serial);
			if (serial === null)
				return { ok: false, reason: 'validation_failed', errors: [{ path: `${path}/serial`, code: 'serial_invalid' }] };
		}
		if (type.require_serial && serial === null)
			return { ok: false, reason: 'validation_failed', errors: [{ path: `${path}/serial`, code: 'required' }] };
		const known = build.knownSerials.get(requested.lineId);
		if (serial !== null && known && known.size > 0 && !known.has(serial))
			return { ok: false, reason: 'serial_mismatch', errors: [{ path: `${path}/serial`, code: 'serial_mismatch' }] };
		lines.push({
			lineId: entry.line.lineId,
			itemId: entry.line.itemId,
			variantId: entry.line.variantId,
			sku: entry.line.sku,
			title: entry.line.title,
			unitAmount: entry.line.unitAmount,
			quantity: requested.quantity,
			serial,
			closesAt: span.closesAt,
			restock: null,
			restockedAt: null,
		});
	}
	const at = new Date(build.now).toISOString();
	return {
		ok: true,
		claim: {
			id: build.id,
			reference: claimReference(build.id),
			purchaseId: purchase.id,
			orderId: purchase.orderId ?? null,
			number: purchase.number ?? null,
			currency: purchase.currency ?? null,
			type: type.key,
			reason: reason.key,
			details: input.details,
			lines,
			photos: [],
			status: build.status,
			released: false,
			history: [{ from: null, to: build.status, at, actor: { type: build.via === 'server' ? 'api' : 'customer' } }],
			notes: [],
			assignee: null,
			refunds: [],
			refundedAmount: 0,
			customerKeys: build.customerKeys,
			via: build.via,
			submittedAt: at,
			updatedAt: at,
			dueAt: build.slaHours > 0 ? new Date(build.now + build.slaHours * 3_600_000).toISOString() : null,
			resolvedAt: null,
			closedAt: null,
		},
	};
};

/**
 * Fields set on a claim moving to `to` (released by a rejection, resolved / closed times).
 * @param {{ claim: Record<string, any>, to: string, statuses: Status[], now: number }} input
 */
export const transitionSet = ({ claim, to, statuses, now }) => {
	const kind = kindOf(statuses, to);
	const at = new Date(now).toISOString();
	return {
		status: to,
		updatedAt: at,
		...(kind === 'rejected' ? { released: true } : {}),
		...((kind === 'resolved' || kind === 'rejected') && !claim.resolvedAt ? { resolvedAt: at } : {}),
		...(kind === 'closed' ? { closedAt: at } : {}),
		dueAt: null,
	};
};

/**
 * The most that can still be refunded on a claim (minor units), or null when there is no cap.
 * @param {{ claim: Record<string, any>, purchaseTotal: number | null, purchaseRefunded: number,
 *   cap: 'claimed_lines' | 'purchase' | 'none' }} input
 * @returns {number | null}
 */
export const refundCap = ({ claim, purchaseTotal, purchaseRefunded, cap }) => {
	if (cap === 'none') return null;
	const byPurchase = purchaseTotal === null ? null : Math.max(0, purchaseTotal - purchaseRefunded);
	if (cap === 'purchase') return byPurchase;
	const lines = /** @type {Array<{ unitAmount: number | null, quantity: number }>} */ (claim.lines);
	if (lines.some((line) => line.unitAmount === null)) return byPurchase;
	const claimed = lines.reduce((sum, line) => sum + /** @type {number} */ (line.unitAmount) * line.quantity, 0);
	const byLines = Math.max(0, claimed - claim.refundedAmount);
	return byPurchase === null ? byLines : Math.min(byLines, byPurchase);
};

/**
 * Restock decisions that still apply: the claim must be in an allowed status and of a type whose item comes back; lines
 * already decided are skipped (each line is restocked at most once).
 * @param {{ claim: Record<string, any>, decisions: Array<{ lineId: string, restock: boolean }>, allowedStatuses: string[],
 *   type: ClaimType | undefined }} input
 * @returns {{ ok: true, apply: Array<{ line: Record<string, any>, restock: boolean }>, skipped: string[] }
 *   | { ok: false, reason: string, errors?: FieldProblem[] }}
 */
export const restockPlan = ({ claim, decisions, allowedStatuses, type }) => {
	if (!allowedStatuses.includes(claim.status) || type?.returns_item === false)
		return { ok: false, reason: 'restock_not_allowed' };
	/** @type {Array<{ line: Record<string, any>, restock: boolean }>} */
	const apply = [];
	/** @type {string[]} */
	const skipped = [];
	for (const [index, decision] of decisions.entries()) {
		const line = /** @type {Array<Record<string, any>>} */ (claim.lines).find((entry) => entry.lineId === decision.lineId);
		if (!line)
			return { ok: false, reason: 'validation_failed', errors: [{ path: `/lines/${index}/lineId`, code: 'line_unknown' }] };
		if (line.restock !== null) skipped.push(line.lineId);
		else apply.push({ line, restock: decision.restock });
	}
	return { ok: true, apply, skipped };
};
