/**
 * API views (pure). Customers see only their own data and never internal notes, assignees, staff ids or other
 * customers' contacts; the merchant's views (`sk_` and the dashboard) carry everything.
 * @module
 */
import { kindOf, nextStatuses } from './claims.js';

/** @typedef {import('./claims.js').Status} Status */
/** @typedef {import('./claims.js').Transition} Transition */
/** @typedef {import('./claims.js').Reason} Reason */
/** @typedef {import('./windows.js').ClaimType} ClaimType */
/** @typedef {import('./windows.js').LineEligibility} LineEligibility */
/** @typedef {(photo: { id: string, key: string }) => string | null} PhotoUrl */

/**
 * @typedef {object} Vocabulary labels of the merchant's data
 * @property {ClaimType[]} types
 * @property {Reason[]} reasons
 * @property {Status[]} statuses
 * @property {Transition[]} transitions
 */

/**
 * @param {Array<{ key: string, label: string }>} list
 * @param {string} key
 */
const labelOf = (list, key) => list.find((entry) => entry.key === key)?.label ?? key;

/**
 * @param {Record<string, any>} claim
 * @param {PhotoUrl | null} photoUrl
 */
const photosOf = (claim, photoUrl) =>
	/** @type {Array<{ id: string, key: string, contentType: string }>} */ (claim.photos ?? []).map((photo) => ({
		id: photo.id,
		contentType: photo.contentType,
		url: photoUrl ? photoUrl(photo) : null,
	}));

/**
 * A claim as its customer sees it.
 * @param {Record<string, any>} claim
 * @param {Vocabulary} vocabulary
 * @param {PhotoUrl | null} [photoUrl]
 */
export const customerClaimView = (claim, vocabulary, photoUrl = null) => {
	const status = vocabulary.statuses.find((entry) => entry.key === claim.status);
	return {
		id: claim.id,
		reference: claim.reference,
		purchaseId: claim.purchaseId,
		number: claim.number ?? null,
		type: claim.type,
		typeLabel: labelOf(vocabulary.types, claim.type),
		reason: claim.reason,
		reasonLabel: labelOf(vocabulary.reasons, claim.reason),
		details: claim.details || null,
		status: claim.status,
		statusLabel: status?.label ?? claim.status,
		statusDescription: status?.description ?? null,
		kind: kindOf(vocabulary.statuses, claim.status),
		lines: /** @type {Array<Record<string, any>>} */ (claim.lines).map((line) => ({
			lineId: line.lineId,
			itemId: line.itemId,
			variantId: line.variantId,
			title: line.title,
			sku: line.sku,
			quantity: line.quantity,
			serial: line.serial,
		})),
		photos: photosOf(claim, photoUrl),
		history: /** @type {Array<Record<string, any>>} */ (claim.history).map((entry) => ({
			status: entry.to,
			label: labelOf(vocabulary.statuses, entry.to),
			at: entry.at,
		})),
		refundedAmount: claim.refundedAmount,
		currency: claim.currency ?? null,
		submittedAt: claim.submittedAt,
		updatedAt: claim.updatedAt,
	};
};

/**
 * A claim as the merchant sees it.
 * @param {Record<string, any>} claim
 * @param {Vocabulary} vocabulary
 * @param {{ photoUrl?: PhotoUrl | null, now: number }} options
 */
export const ownerClaimView = (claim, vocabulary, { photoUrl = null, now }) => ({
	...customerClaimView(claim, vocabulary, photoUrl),
	orderId: claim.orderId ?? null,
	via: claim.via,
	customerKeys: claim.customerKeys,
	released: claim.released === true,
	lines: /** @type {Array<Record<string, any>>} */ (claim.lines).map((line) => ({
		lineId: line.lineId,
		itemId: line.itemId,
		variantId: line.variantId,
		title: line.title,
		sku: line.sku,
		quantity: line.quantity,
		unitAmount: line.unitAmount,
		serial: line.serial,
		closesAt: line.closesAt,
		restock: line.restock,
		restockedAt: line.restockedAt,
	})),
	history: /** @type {Array<Record<string, any>>} */ (claim.history).map((entry) => ({
		from: entry.from,
		to: entry.to,
		at: entry.at,
		actor: entry.actor,
		note: entry.note ?? null,
	})),
	notes: claim.notes,
	assignee: claim.assignee,
	refunds: claim.refunds,
	dueAt: claim.dueAt,
	overdue: typeof claim.dueAt === 'string' && Date.parse(claim.dueAt) < now,
	resolvedAt: claim.resolvedAt,
	closedAt: claim.closedAt,
	nextStatuses: nextStatuses(vocabulary.transitions, vocabulary.statuses, claim.status),
});

/**
 * A purchase and what can still be claimed (customer view: no contact data).
 * @param {Record<string, any>} purchase
 * @param {{ lines: LineEligibility[], canClaim: boolean }} eligibility
 */
export const customerPurchaseView = (purchase, eligibility) => ({
	id: purchase.id,
	orderId: purchase.orderId ?? null,
	number: purchase.number ?? purchase.reference ?? null,
	currency: purchase.currency ?? null,
	status: purchase.status,
	placedAt: purchase.placedAt ?? null,
	deliveredAt: purchase.deliveredAt ?? null,
	canClaim: eligibility.canClaim,
	lines: eligibility.lines.map((entry) => ({
		lineId: entry.line.lineId,
		itemId: entry.line.itemId,
		variantId: entry.line.variantId,
		title: entry.line.title,
		sku: entry.line.sku,
		quantity: entry.line.quantity,
		claimable: entry.claimable,
		itemType: entry.itemType,
		grade: entry.grade,
		windows: Object.fromEntries(
			Object.entries(entry.windows).map(([type, state]) => [
				type,
				state.eligible
					? { eligible: true, closesAt: state.closesAt }
					: { eligible: false, reason: state.reason, closesAt: state.closesAt ?? null },
			]),
		),
	})),
});

/**
 * A purchase as the merchant sees it (with the customer reference and the window sources).
 * @param {Record<string, any>} purchase
 * @param {{ lines: LineEligibility[], canClaim: boolean }} eligibility
 */
export const ownerPurchaseView = (purchase, eligibility) => {
	const base = customerPurchaseView(purchase, eligibility);
	return {
		...base,
		reference: purchase.reference ?? null,
		customer: purchase.customer,
		source: purchase.source,
		total: purchase.total ?? null,
		refundedAmount: purchase.refundedAmount ?? 0,
		lines: base.lines.map((line, index) => {
			const entry = /** @type {LineEligibility} */ (eligibility.lines[index]);
			return {
				...line,
				unitAmount: entry.line.unitAmount,
				warrantyDays: entry.line.warrantyDays,
				refundedQuantity: entry.line.refundedQuantity,
				windows: Object.fromEntries(Object.entries(entry.windows).map(([type, state]) => [type, state])),
			};
		}),
	};
};

/**
 * What a claim form needs: types, reasons and evidence rules, photo limits when photos are on, messages when on.
 * @param {{ types: ClaimType[], reasons: Reason[], claims: Record<string, any>, photos: Record<string, any> | null,
 *   messages: Record<string, any> | null }} input
 */
export const formView = ({ types, reasons, claims, photos, messages }) => ({
	types: types
		.filter((type) => type.enabled !== false)
		.map((type) => ({
			key: type.key,
			label: type.label,
			refundable: type.refundable !== false,
			minPhotos: photos ? (type.min_photos ?? 0) : 0,
			requireSerial: type.require_serial === true,
			detailsMinLength: type.details_min_length ?? 0,
		})),
	reasons: reasons.map((reason) => ({
		key: reason.key,
		label: reason.label,
		types: reason.types ?? [],
		detailsRequired: reason.details_required === true,
	})),
	details: { maxLength: claims.details_max_length },
	maxLines: claims.max_lines_per_claim,
	guestAccess: claims.guest_access === true,
	photos: photos
		? { enabled: true, max: photos.max_photos_per_claim, maxBytes: photos.max_photo_bytes, types: photos.allowed_types }
		: { enabled: false, max: 0, maxBytes: 0, types: [] },
	messages: messages
		? { enabled: true, customerCanWrite: messages.customer_can_message === true, maxLength: messages.max_length }
		: { enabled: false, customerCanWrite: false, maxLength: 0 },
});

/**
 * A message of a claim conversation.
 * @param {Record<string, any>} message
 * @param {boolean} owner
 */
export const messageView = (message, owner) => ({
	id: message.id,
	claimId: message.claimId,
	author: message.author,
	body: message.body,
	at: message.at,
	...(owner ? { actor: message.actor ?? null, notified: message.notified ?? null } : {}),
});

/**
 * The public warranty lookup of a serial: the item and its cover per claim type, never the order or the customer.
 * @param {{ serial: Record<string, any>, entry: LineEligibility | null, types: ClaimType[], showSaleDate: boolean }} input
 */
export const publicSerialView = ({ serial, entry, types, showSaleDate }) => ({
	serial: serial.serial,
	title: serial.title ?? entry?.line.title ?? null,
	soldAt: showSaleDate ? (serial.soldAt ?? null) : null,
	cover: types
		.filter((type) => type.enabled !== false)
		.map((type) => {
			const state = entry?.windows[type.key];
			return {
				type: type.key,
				label: type.label,
				active: state?.eligible === true,
				endsAt: state?.closesAt ?? null,
			};
		}),
});

/**
 * A serial as the merchant sees it.
 * @param {{ serial: Record<string, any>, entry: LineEligibility | null, types: ClaimType[], claims: Array<Record<string, any>> }} input
 */
export const ownerSerialView = ({ serial, entry, types, claims }) => ({
	...publicSerialView({ serial, entry, types, showSaleDate: true }),
	itemId: serial.itemId,
	variantId: serial.variantId ?? null,
	orderId: serial.orderId ?? null,
	purchaseId: serial.purchaseId ?? null,
	lineId: entry?.line.lineId ?? null,
	source: serial.source,
	claims: claims.map((claim) => ({ id: claim.id, reference: claim.reference, type: claim.type, status: claim.status })),
});
