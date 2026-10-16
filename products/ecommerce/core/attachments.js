/**
 * Order attachments (fixed-choices E20): photos, videos and files staff keep on an order — a packing video, a photo of
 * the parcel, a signed delivery note — of the kinds the merchant names. The `attachment_kinds` list (feature `checkout`)
 * holds `{ key, label, type: photo | video | file, requiredAt, shoppers }`: `requiredAt` names the status of the order
 * flow a move into which needs one attachment of the kind ('' = never), `shoppers` whether shoppers see it in their
 * order (and Chat's order lookups). Seeded with one optional packing video shoppers see (today's dispatch video).
 *
 * An attachment is an upload key in the merchant's storage, or an https address (a YouTube address is kept as its
 * private embed address). Staff add attachments with a move or on the order, and remove them. Pure, no I/O.
 * @module
 */
import { youtubeId } from './catalog-content.js';
import { boolField, checkNamedList, oneOf } from './named-lists.js';

/** What an attachment is. */
export const ATTACHMENT_TYPES = Object.freeze(/** @type {const} */ (['photo', 'video', 'file']));
/** @typedef {typeof ATTACHMENT_TYPES[number]} AttachmentType */
/** Engine caps: kinds in the list, attachments on one order, attachments added by one call. */
export const ATTACHMENT_LIMITS = Object.freeze({ kinds: 20, perOrder: 30, perCall: 10 });

/**
 * @typedef {{ key: string, label: string, type: AttachmentType, requiredAt: string, shoppers: boolean }} AttachmentKind
 * @typedef {{ kind: string, key?: string, url?: string }} AttachmentInput what staff send
 * @typedef {{ id: string, kind: string, type: AttachmentType, key: string | null, url: string | null, at: Date,
 *   by: string }} AttachmentRecord
 */

/** The list before the merchant saves it (today's dispatch video, optional). @type {ReadonlyArray<AttachmentKind>} */
export const DEFAULT_ATTACHMENT_KINDS = Object.freeze([
	{ key: 'packing_video', label: 'Packing video', type: 'video', requiredAt: '', shoppers: true },
]);

const STATUS_KEY = /^[a-z][a-z0-9_-]{1,39}$/;
/** An upload key in the merchant's bucket. */
const UPLOAD_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,299}$/;

/**
 * Check the `attachment_kinds` list.
 * @param {unknown} value
 * @returns {{ ok: true, value: AttachmentKind[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkAttachmentKinds = (value) =>
	/** @type {{ ok: true, value: AttachmentKind[] } | { ok: false, errors: Array<{ path: string, message: string }> }} */ (
		checkNamedList(value, {
			max: ATTACHMENT_LIMITS.kinds,
			what: 'attachment kinds',
			fields: (entry, fail) => {
				const requiredAt = entry.requiredAt === undefined || entry.requiredAt === null ? '' : entry.requiredAt;
				if (requiredAt !== '' && (typeof requiredAt !== 'string' || !STATUS_KEY.test(requiredAt)))
					fail('requiredAt', 'requiredAt is a status key of the order flow, or empty.');
				return {
					type: oneOf(entry, 'type', ATTACHMENT_TYPES, 'file', fail),
					requiredAt: typeof requiredAt === 'string' ? requiredAt : '',
					shoppers: boolField(entry, 'shoppers', false, fail),
				};
			},
		})
	);

/**
 * Where an attachment is: an upload key, or an https address (YouTube kept as its private embed address); null when
 * it is neither.
 * @param {unknown} value
 * @returns {{ key: string } | { url: string } | null}
 */
export const attachmentSource = (value) => {
	if (typeof value !== 'string') return null;
	const raw = value.trim();
	if (/^https:\/\//i.test(raw)) {
		try {
			const url = new URL(raw);
			if (url.protocol !== 'https:' || raw.length > 2000) return null;
			const id = youtubeId(raw);
			if (id) return { url: `https://www.youtube-nocookie.com/embed/${id}` };
			return { url: url.toString() };
		} catch {
			return null;
		}
	}
	return UPLOAD_KEY.test(raw) && !raw.includes('..') ? { key: raw } : null;
};

/**
 * Check attachments staff send (their shape only: the kinds are checked against the list by {@link attachmentsOf}).
 * @param {unknown} value
 * @param {string} [path]
 * @returns {{ ok: true, value: AttachmentInput[] } | { ok: false, field: string, message: string }}
 */
export const checkAttachmentInputs = (value, path = 'attachments') => {
	if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.perCall)
		return { ok: false, field: path, message: `attachments lists 0 to ${ATTACHMENT_LIMITS.perCall} attachments.` };
	/** @type {AttachmentInput[]} */
	const out = [];
	for (const [index, raw] of value.entries()) {
		const entry = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		if (typeof entry.kind !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(entry.kind))
			return { ok: false, field: `${path}/${index}/kind`, message: 'kind is a key of the attachment_kinds list.' };
		const source = attachmentSource(entry.key ?? entry.url);
		if (!source)
			return {
				ok: false,
				field: `${path}/${index}/${entry.key === undefined ? 'url' : 'key'}`,
				message: 'An attachment is an upload key or an https address.',
			};
		out.push({ kind: entry.kind, ...source });
	}
	return { ok: true, value: out };
};

/**
 * The records of attachments staff add: each of a kind of the list, never more than {@link ATTACHMENT_LIMITS}
 * `perOrder` on the order.
 * @param {AttachmentInput[]} inputs
 * @param {ReadonlyArray<AttachmentKind>} kinds
 * @param {{ held: number, at: Date, by: string, id: () => string }} context `held`: attachments the order has
 * @returns {{ ok: true, value: AttachmentRecord[] } | { ok: false, field: string, message: string }}
 */
export const attachmentsOf = (inputs, kinds, { held, at, by, id }) => {
	if (held + inputs.length > ATTACHMENT_LIMITS.perOrder)
		return { ok: false, field: 'attachments', message: `An order keeps at most ${ATTACHMENT_LIMITS.perOrder} attachments.` };
	/** @type {AttachmentRecord[]} */
	const out = [];
	for (const [index, input] of inputs.entries()) {
		const kind = kinds.find((entry) => entry.key === input.kind);
		if (!kind) return { ok: false, field: `attachments/${index}/kind`, message: 'kind is a key of the attachment_kinds list.' };
		out.push({ id: id(), kind: kind.key, type: kind.type, key: input.key ?? null, url: input.url ?? null, at, by });
	}
	return { ok: true, value: out };
};

/**
 * The kinds a move into a status needs that the order does not have yet (nor gets with the move).
 * @param {ReadonlyArray<AttachmentKind>} kinds
 * @param {string} status the status moved into
 * @param {ReadonlyArray<{ kind: string }>} held the order's attachments and those the move adds
 */
export const missingAttachments = (kinds, status, held) =>
	kinds.filter((kind) => kind.requiredAt === status && !held.some((attachment) => attachment.kind === kind.key));
