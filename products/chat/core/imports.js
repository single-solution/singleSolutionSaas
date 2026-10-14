/**
 * The `import` feature's records (pure; PLAN 0.8.10 K10, Migration step 7): Chat's own stored shapes of staff, guests,
 * conversations and messages as `ss-import` sends them (JSON times as ISO 8601 text), checked in import mode: given ids
 * and past times are taken, unknown fields and the tenant fields are refused by name, and text longer than Chat keeps
 * is refused, never cut (IMP-31). Nothing here sends anything.
 *
 * - Guests are found by `keyHash`, the SHA-256 (hex) of the old guest cookie value, as Chat hashes the `SS-Guest` key of
 *   a request, so a guest's conversations keep working through the store's own cookie (C7).
 * - Messages are separate records; each gets a provisional sequence number from its time and id (far past the numbers
 *   a conversation reaches by itself), and `finish` numbers each conversation's messages 1..n in time order (ties by
 *   id) and derives what the conversation keeps of them: the counters, the preview, the last message time and the read
 *   marks behind the unread counts the record gives (C8, C11).
 * @module
 */
import { isId } from '@ss/contracts';
import { normalisePhone } from '@ss/contracts/phone';
import { STATUSES, messageText, previewOf } from './conversation.js';
import { checkFieldValue } from './fields.js';
import { plainOf } from './markdown.js';
import { MAX_MESSAGE_LENGTH, MAX_STAFF_ATTACHMENT_BYTES, PAGE_KINDS, STAFF_TYPES } from './widgets.js';

/** @typedef {{ path: string, message: string }} ImportError */
/** @typedef {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: ImportError[] }} Checked */
/** @typedef {import('./conversation.js').Author} Author */
/** @typedef {import('./fields.js').CustomField} CustomField */

/** The longest texts Chat keeps (characters), as its own routes take them. */
const IMPORT_TEXT_LIMITS = Object.freeze({
	/** a member of staff's or a message author's name (the acting user's name, K2) */
	name: 120,
	/** a visitor's captured name (lead capture) */
	contactName: 200,
	/** the single note (C11) */
	note: 4000,
	/** the AI summary */
	summary: 2000,
	/** a rating's comment */
	comment: 1000,
	/** why the AI was paused (C11) */
	reason: 200,
	device: 100,
	/** an attachment's file name */
	fileName: 120,
	/** an attachment's object key */
	fileKey: 512,
	/** a page address and title (the page a chat started on) */
	pageUrl: 500,
	pageTitle: 200,
});

/** Fields of each record (the stored shape; derived fields are `finish`'s, the tenant the import's). */
export const IMPORT_FIELDS = Object.freeze({
	staff: Object.freeze(['id', 'name', 'email', 'presence', 'maxChats', 'createdAt']),
	guests: Object.freeze(['keyHash', 'id', 'expireAt', 'createdAt']),
	conversations: Object.freeze([
		'id',
		'visitor',
		'guestIds',
		'name',
		'email',
		'phone',
		'status',
		'waiting',
		'waitingSince',
		'handedOffAt',
		'aiPaused',
		'aiPausedBy',
		'aiPausedAt',
		'aiPausedReason',
		'assignedTo',
		'note',
		'fields',
		'summary',
		'rating',
		'ratingRequested',
		'page',
		'device',
		'unreadStaff',
		'unreadVisitor',
		'lastMessageAt',
		'createdAt',
	]),
	messages: Object.freeze([
		'id',
		'conversationId',
		'author',
		'staffId',
		'name',
		'text',
		'format',
		'internal',
		'attachment',
		'createdAt',
	]),
});

const TENANT = Object.freeze(['websiteId', 'merchantId']);
const AUTHORS = Object.freeze(/** @type {const} */ (['visitor', 'ai', 'staff', 'system']));
const PRESENCES = Object.freeze(['online', 'away', 'offline']);
/** A guest key's hash: SHA-256, 64 lower-case hex digits. */
const KEY_HASH = /^[0-9a-f]{64}$/;
/** An Accounts user id, a staff id or a pause's actor id (as the inbox and the `SS-Actor-*` headers take them). */
const USER_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;
/** An ISO 8601 time with its zone. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const DAY_MS = 86_400_000;
/** Most guests behind one conversation, and most custom field values on one. */
const MAX_GUEST_IDS = 100;
const MAX_FIELDS = 50;
/** Provisional sequence numbers start past any number a conversation reaches by itself (2^21 messages). */
export const PROVISIONAL_SEQ = 2 ** 21;
const SEQ_EPOCH = Date.UTC(2000, 0, 1);
/** The last second a provisional number keeps apart (the year 2136); later times share it. */
const MAX_SEQ_SECONDS = 2 ** 32 - 2;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A time given as ISO 8601 text with its zone (`2024-05-01T10:00:00Z`), or null when it is not a real time.
 * @param {unknown} value
 * @returns {Date | null}
 */
export const timeOf = (value) => {
	const match = typeof value === 'string' ? ISO_TIME.exec(value) : null;
	if (!match) return null;
	const [y, mo, d, h, mi, s = 0, zh = 0, zm = 0] = match.slice(1).map((part) => Number(part ?? 0));
	const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
	const real =
		day.getUTCFullYear() === y &&
		day.getUTCMonth() === Number(mo) - 1 &&
		day.getUTCDate() === d &&
		Number(h) <= 23 &&
		Number(mi) <= 59 &&
		s <= 59 &&
		zh <= 23 &&
		zm <= 59;
	return real ? new Date(Date.parse(/** @type {string} */ (value))) : null;
};

/**
 * Collects a record's errors while its fields are read.
 * @param {Record<string, unknown>} record
 * @param {ReadonlyArray<string>} allowed
 */
const reader = (record, allowed) => {
	/** @type {ImportError[]} */
	const errors = [];
	/** @param {string} path @param {string} message */
	const fail = (path, message) => {
		errors.push({ path, message });
		return null;
	};
	/**
	 * Errors for the fields an object may not have: the tenant fields (the import stamps the website) and unknown ones.
	 * @param {Record<string, unknown>} object
	 * @param {ReadonlyArray<string>} fields
	 * @param {string} at
	 */
	const only = (object, fields, at = '') => {
		for (const field of Object.keys(object))
			if (!fields.includes(field))
				fail(
					`${at}/${field}`,
					at === '' && TENANT.includes(field)
						? `${field} is never taken from a record: the import stamps the website.`
						: `Unknown field ${field}.`,
				);
	};
	only(record, allowed);
	return {
		errors,
		fail,
		only,
		/**
		 * Text up to `max` characters (trimmed); null when missing, null or empty.
		 * @param {unknown} value @param {string} path @param {number} max @param {{ required?: boolean }} [options]
		 * @returns {string | null}
		 */
		text: (value, path, max, { required = false } = {}) => {
			const text = typeof value === 'string' ? value.trim() : value;
			if (text === undefined || text === null || text === '') return required ? fail(path, 'This is required.') : null;
			if (typeof text !== 'string') return fail(path, 'This is text.');
			const length = [...text].length;
			return length > max ? fail(path, `At most ${max} characters (this has ${length}); shorten it in the source.`) : text;
		},
		/**
		 * A time (ISO 8601 with its zone); null when missing or null.
		 * @param {unknown} value @param {string} path @param {{ required?: boolean }} [options]
		 * @returns {Date | null}
		 */
		time: (value, path, { required = false } = {}) => {
			if (value === undefined || value === null) return required ? fail(path, 'A time is required.') : null;
			return timeOf(value) ?? fail(path, 'A time in ISO 8601 with its zone, such as 2024-05-01T10:00:00Z.');
		},
		/** @param {unknown} value @param {string} path @param {boolean} fallback */
		flag: (value, path, fallback) => {
			if (value === undefined) return fallback;
			return typeof value === 'boolean' ? value : Boolean(fail(path, 'true or false.'));
		},
		/**
		 * A whole number from `min` to `max`.
		 * @param {unknown} value @param {string} path @param {number} min @param {number} max @param {number} fallback
		 */
		whole: (value, path, min, max, fallback) => {
			if (value === undefined) return fallback;
			return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
				? Number(value)
				: Number(fail(path, `A whole number from ${min} to ${max}.`) ?? fallback);
		},
		/**
		 * One of the values; `fallback` when missing.
		 * @template {string} T @param {unknown} value @param {string} path @param {ReadonlyArray<T>} values
		 * @param {T | null} fallback
		 * @returns {T | null}
		 */
		oneOf: (value, path, values, fallback) => {
			if (value === undefined) return fallback;
			return values.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fail(path, `One of ${values.join(', ')}.`);
		},
		/** @param {unknown} value @param {string} path @returns {string | null} */
		email: (value, path) => {
			if (value === undefined || value === null || value === '') return null;
			const checked = checkFieldValue({ key: 'email', label: 'email', type: 'email', options: [] }, value);
			return checked.ok ? String(checked.value) : fail(path, 'Not an e-mail address.');
		},
	};
};

/**
 * The answer of a check.
 * @param {ImportError[]} errors
 * @param {() => Record<string, unknown>} value
 * @returns {Checked}
 */
const answer = (errors, value) => (errors.length > 0 ? { ok: false, errors } : { ok: true, value: value() });

/**
 * A member of staff (the staff list of the inbox, with presence and max chats): `{ id, name, email?, presence?,
 * maxChats?, createdAt? }`; the id as given (an Accounts user id).
 * @param {Record<string, unknown>} record
 * @returns {Checked}
 */
export const checkStaff = (record) => {
	const read = reader(record, IMPORT_FIELDS.staff);
	const name = read.text(record.name, '/name', IMPORT_TEXT_LIMITS.name, { required: true });
	const email = read.email(record.email, '/email');
	const presence = read.oneOf(record.presence, '/presence', PRESENCES, null);
	const maxChats =
		record.maxChats === undefined || record.maxChats === null
			? record.maxChats
			: read.whole(record.maxChats, '/maxChats', 1, 200, 0);
	const createdAt = read.time(record.createdAt, '/createdAt');
	return answer(read.errors, () => ({
		id: record.id,
		name,
		...(email ? { email } : {}),
		...(presence ? { presence } : {}),
		...(maxChats === undefined ? {} : { maxChats }),
		...(createdAt ? { createdAt } : {}),
	}));
};

/**
 * A guest's device key: `{ keyHash, id, expireAt?, createdAt? }`. `keyHash` is the SHA-256 (hex) of the old guest
 * cookie value, which must be a guest key Chat takes (16–128 of `A–Z a–z 0–9 - _`); `id` the guest id the guest's
 * conversations name. Without `expireAt` the device is remembered for the `guest_chat` setting's days from now.
 * @param {Record<string, unknown>} record
 * @param {{ now: number, rememberDays: number }} rules
 * @returns {Checked}
 */
export const checkGuest = (record, { now, rememberDays }) => {
	const read = reader(record, IMPORT_FIELDS.guests);
	if (typeof record.keyHash !== 'string' || !KEY_HASH.test(record.keyHash))
		read.fail('/keyHash', 'The SHA-256 of the guest cookie value: 64 lower-case hex digits.');
	if (!isId(record.id, 'guest')) read.fail('/id', 'A guest id: guest_ and 10–64 of 0–9 a–z.');
	const given = read.time(record.expireAt, '/expireAt');
	if (given && given.getTime() <= now) read.fail('/expireAt', 'This time has passed: the guest would be forgotten at once.');
	const createdAt = read.time(record.createdAt, '/createdAt');
	return answer(read.errors, () => ({
		keyHash: record.keyHash,
		id: record.id,
		expireAt: given ?? new Date(now + rememberDays * DAY_MS),
		...(createdAt ? { createdAt } : {}),
	}));
};

/**
 * A conversation: who the visitor is (a guest or a signed-in Accounts user), the captured contact, the status, waiting
 * for a person, the AI pause with who and when, the assignment, the single note, custom field values, the AI summary,
 * the rating, the page it started on, the unread counts, `lastMessageAt` and `createdAt`. Counters, the preview and
 * the read marks come from the messages (`finish`); until then it reads as a conversation without messages.
 * @param {Record<string, unknown>} record
 * @param {{ callingCode: string, staffIds: ReadonlySet<string>, customFields: ReadonlyArray<CustomField> }} rules
 *   `callingCode`: the website's, for phones without one; `staffIds`: the staff list (assignments name one of them);
 *   `customFields`: the custom field definitions
 * @returns {Checked}
 */
export const checkConversation = (record, { callingCode, staffIds, customFields }) => {
	const read = reader(record, IMPORT_FIELDS.conversations);
	if (!isId(record.id, 'conv')) read.fail('/id', 'A conversation id: conv_ and 10–64 of 0–9 a–z.');
	const visitor = visitorOf(record.visitor, read);
	const guestIds = guestIdsOf(record.guestIds, read);
	const phone =
		record.phone === undefined || record.phone === null || record.phone === ''
			? null
			: (normalisePhone(record.phone, callingCode) ?? read.fail('/phone', 'Not a phone number.'));
	const status = read.oneOf(record.status, '/status', STATUSES, null);
	if (record.status === undefined) read.fail('/status', `One of ${STATUSES.join(', ')}.`);
	const assignedTo = record.assignedTo === undefined || record.assignedTo === null ? null : String(record.assignedTo);
	if (assignedTo !== null && !staffIds.has(assignedTo))
		read.fail('/assignedTo', `No member of staff ${assignedTo}: import the staff first.`);
	const values = {
		id: record.id,
		visitor,
		guestIds,
		name: read.text(record.name, '/name', IMPORT_TEXT_LIMITS.contactName),
		email: read.email(record.email, '/email'),
		phone,
		status,
		waiting: read.flag(record.waiting, '/waiting', false),
		waitingSince: read.time(record.waitingSince, '/waitingSince'),
		handedOffAt: read.time(record.handedOffAt, '/handedOffAt'),
		aiPaused: read.flag(record.aiPaused, '/aiPaused', false),
		aiPausedBy: pausedByOf(record.aiPausedBy, read),
		aiPausedAt: read.time(record.aiPausedAt, '/aiPausedAt'),
		aiPausedReason: read.text(record.aiPausedReason, '/aiPausedReason', IMPORT_TEXT_LIMITS.reason),
		assignedTo,
		note: read.text(record.note, '/note', IMPORT_TEXT_LIMITS.note),
		fields: fieldsOf(record.fields, customFields, read),
		summary: read.text(record.summary, '/summary', IMPORT_TEXT_LIMITS.summary),
		rating: ratingOf(record.rating, read),
		ratingRequested: read.flag(record.ratingRequested, '/ratingRequested', false),
		page: pageOf(record.page, read),
		device: read.text(record.device, '/device', IMPORT_TEXT_LIMITS.device) ?? '',
		unreadStaff: read.whole(record.unreadStaff, '/unreadStaff', 0, 1_000_000, 0),
		unreadVisitor: read.whole(record.unreadVisitor, '/unreadVisitor', 0, 1_000_000, 0),
		lastMessageAt: read.time(record.lastMessageAt, '/lastMessageAt', { required: true }),
		createdAt: read.time(record.createdAt, '/createdAt', { required: true }),
	};
	return answer(read.errors, () => ({
		...values,
		aiPending: false,
		aiFailures: 0,
		// what `finish` derives from the messages; until then, as a conversation without messages
		lastSeq: 0,
		visitorMessages: 0,
		aiReplies: 0,
		staffReplied: false,
		firstVisitorAt: null,
		firstStaffReplyAt: null,
		visitorSeenSeq: 0,
		staffSeenSeq: 0,
		alerted: false,
		preview: '',
		flow: null,
		flowsRun: [],
	}));
};

/**
 * @param {unknown} value
 * @param {ReturnType<typeof reader>} read
 * @returns {{ kind: 'guest' | 'user', id: string } | null}
 */
const visitorOf = (value, read) => {
	if (!isObject(value))
		return read.fail('/visitor', 'The visitor: { kind: guest, id: <guest id> } or { kind: user, id: <Accounts user id> }.');
	read.only(value, ['kind', 'id'], '/visitor');
	if (value.kind === 'guest' && isId(value.id, 'guest')) return { kind: 'guest', id: String(value.id) };
	if (value.kind === 'user' && typeof value.id === 'string' && USER_ID.test(value.id)) return { kind: 'user', id: value.id };
	return read.fail('/visitor', 'The visitor: { kind: guest, id: <guest id> } or { kind: user, id: <Accounts user id> }.');
};

/**
 * Guests whose chats moved into this conversation (data rights).
 * @param {unknown} value
 * @param {ReturnType<typeof reader>} read
 * @returns {string[]}
 */
const guestIdsOf = (value, read) => {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_GUEST_IDS || !value.every((id) => isId(id, 'guest'))) {
		read.fail('/guestIds', `Up to ${MAX_GUEST_IDS} guest ids.`);
		return [];
	}
	return [...new Set(/** @type {string[]} */ (value))];
};

/**
 * Who paused the AI (C11): `{ kind, id, name }`.
 * @param {unknown} value
 * @param {ReturnType<typeof reader>} read
 */
const pausedByOf = (value, read) => {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return read.fail('/aiPausedBy', 'Who paused the AI: { kind, id, name }.');
	read.only(value, ['kind', 'id', 'name'], '/aiPausedBy');
	const kind = read.text(value.kind, '/aiPausedBy/kind', 40, { required: true });
	const id = typeof value.id === 'string' && USER_ID.test(value.id) ? value.id : read.fail('/aiPausedBy/id', 'An id.');
	const name = read.text(value.name, '/aiPausedBy/name', IMPORT_TEXT_LIMITS.name, { required: true });
	return kind && id && name ? { kind, id, name } : null;
};

/**
 * Custom field values, each checked against its definition (the `custom_fields` list).
 * @param {unknown} value
 * @param {ReadonlyArray<CustomField>} definitions
 * @param {ReturnType<typeof reader>} read
 */
const fieldsOf = (value, definitions, read) => {
	/** @type {Record<string, string | number | boolean>} */
	const fields = {};
	if (value === undefined || value === null) return fields;
	if (!isObject(value) || Object.keys(value).length > MAX_FIELDS) {
		read.fail('/fields', `Custom field values: { <key>: <value> }, up to ${MAX_FIELDS}.`);
		return fields;
	}
	for (const [key, raw] of Object.entries(value)) {
		const field = definitions.find((definition) => definition.key === key);
		if (!field) {
			read.fail(`/fields/${key}`, `No custom field ${key}: add it to the custom_fields list first.`);
			continue;
		}
		const checked = checkFieldValue(field, raw);
		if (checked.ok) fields[key] = checked.value;
		else read.fail(`/fields/${key}`, `Not a value of ${field.label}.`);
	}
	return fields;
};

/**
 * The visitor's rating: `{ score, comment, at }` (score 1–5).
 * @param {unknown} value
 * @param {ReturnType<typeof reader>} read
 */
const ratingOf = (value, read) => {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return read.fail('/rating', 'The rating: { score, comment, at }.');
	read.only(value, ['score', 'comment', 'at'], '/rating');
	const score = read.whole(value.score ?? null, '/rating/score', 1, 5, 0);
	const comment = read.text(value.comment, '/rating/comment', IMPORT_TEXT_LIMITS.comment);
	const at = read.time(value.at, '/rating/at', { required: true });
	return { score, comment, at };
};

/**
 * The page a chat started on: `{ url, title, kind, productId, productName }`.
 * @param {unknown} value
 * @param {ReturnType<typeof reader>} read
 */
const pageOf = (value, read) => {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return read.fail('/page', 'The page: { url, title, kind, productId, productName }.');
	read.only(value, ['url', 'title', 'kind', 'productId', 'productName'], '/page');
	const url = read.text(value.url, '/page/url', IMPORT_TEXT_LIMITS.pageUrl) ?? '';
	if (url !== '' && !/^https?:\/\//.test(url)) read.fail('/page/url', 'An http(s) address.');
	return {
		url,
		title: read.text(value.title, '/page/title', IMPORT_TEXT_LIMITS.pageTitle) ?? '',
		kind: read.oneOf(value.kind, '/page/kind', PAGE_KINDS, 'other'),
		productId: read.text(value.productId, '/page/productId', 100),
		productName: read.text(value.productName, '/page/productName', IMPORT_TEXT_LIMITS.pageTitle),
	};
};

/**
 * A message of a conversation: `{ id, conversationId, author, staffId?, name?, text, format?, internal?,
 * attachment?, createdAt }`. `author` is visitor, ai, staff or system; staff messages carry the staff id and may be
 * internal notes (a timeline note); an attachment keeps its key, which must be under Chat's `chat/` folder of the
 * storage (Chat opens only its own keys). The text may be empty only beside an attachment.
 * @param {Record<string, unknown>} record
 * @returns {Checked}
 */
export const checkMessage = (record) => {
	const read = reader(record, IMPORT_FIELDS.messages);
	if (!isId(record.id, 'msg')) read.fail('/id', 'A message id: msg_ and 10–64 of 0–9 a–z.');
	if (!isId(record.conversationId, 'conv')) read.fail('/conversationId', 'A conversation id: conv_ and 10–64 of 0–9 a–z.');
	const author = read.oneOf(record.author, '/author', AUTHORS, null);
	if (record.author === undefined) read.fail('/author', `One of ${AUTHORS.join(', ')}.`);
	const staffId = record.staffId === undefined || record.staffId === null ? null : record.staffId;
	if (staffId !== null && (author !== 'staff' || typeof staffId !== 'string' || !USER_ID.test(staffId)))
		read.fail('/staffId', 'The id of the member of staff who wrote a staff message (none for other authors).');
	const internal = read.flag(record.internal, '/internal', false);
	if (internal && author !== 'staff') read.fail('/internal', 'Only staff write internal notes.');
	const attachment = attachmentOf(record.attachment, read);
	const text = messageText(record.text, { allowEmpty: attachment !== null });
	if (text === null)
		read.fail(
			'/text',
			typeof record.text === 'string' && record.text.trim() !== ''
				? `At most ${MAX_MESSAGE_LENGTH} characters (this has ${[...record.text.trim()].length}); shorten it in the source.`
				: 'The text is required (it may be empty only beside an attachment).',
		);
	const format = read.oneOf(record.format, '/format', /** @type {const} */ (['text', 'markdown']), 'text');
	const name = read.text(record.name, '/name', IMPORT_TEXT_LIMITS.name);
	const createdAt = read.time(record.createdAt, '/createdAt', { required: true });
	return answer(read.errors, () => ({
		id: record.id,
		conversationId: record.conversationId,
		seq: provisionalSeq(/** @type {Date} */ (createdAt), String(record.id)),
		author,
		staffId,
		name,
		text,
		...(format === 'markdown' ? { format } : {}),
		internal,
		attachment,
		createdAt,
	}));
};

/**
 * An attachment `{ key, name, type, size }` (C12's staff types and size).
 * @param {unknown} value
 * @param {ReturnType<typeof reader>} read
 */
const attachmentOf = (value, read) => {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return read.fail('/attachment', 'The attachment: { key, name, type, size }.');
	read.only(value, ['key', 'name', 'type', 'size'], '/attachment');
	const key = read.text(value.key, '/attachment/key', IMPORT_TEXT_LIMITS.fileKey, { required: true });
	// eslint-disable-next-line no-control-regex
	if (key !== null && (!key.startsWith('chat/') || /[\u0000-\u001f]/.test(key)))
		read.fail('/attachment/key', 'A key under chat/ in Chat’s storage (copy the file there first).');
	const name = read.text(value.name, '/attachment/name', IMPORT_TEXT_LIMITS.fileName, { required: true });
	if (name !== null && /[\\/\r\n"]/.test(name)) read.fail('/attachment/name', 'A file name without / \\ " or line breaks.');
	const type = read.oneOf(value.type, '/attachment/type', STAFF_TYPES, null);
	if (value.type === undefined) read.fail('/attachment/type', `One of ${STAFF_TYPES.join(', ')}.`);
	const size = read.whole(value.size ?? null, '/attachment/size', 1, MAX_STAFF_ATTACHMENT_BYTES, 0);
	return { key: key ?? '', name: name ?? '', type: type ?? '', size };
};

/**
 * A 32-bit FNV-1a hash of a text.
 * @param {string} text
 */
const hashOf = (text) => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
	return hash;
};

/**
 * The provisional sequence number of an imported message: its second (since 2000) and 21 bits of its id's hash, past
 * {@link PROVISIONAL_SEQ}, so imported messages keep their time order until `finish` and never take a number a
 * conversation holds; two messages of one conversation in one second share a number only when 21 bits of their ids'
 * hashes match (about one pair in two million), and that message is then refused as a duplicate.
 * @param {Date} createdAt
 * @param {string} id
 */
export const provisionalSeq = (createdAt, id) => {
	const seconds = Math.min(Math.max(0, Math.floor((createdAt.getTime() - SEQ_EPOCH) / 1000)), MAX_SEQ_SECONDS);
	return (seconds + 1) * PROVISIONAL_SEQ + (hashOf(id) % PROVISIONAL_SEQ);
};

/**
 * @typedef {{ id: string, seq: number, author: Author, internal: boolean, createdAt: Date }} MessageFacts
 */

/**
 * What `finish` makes of a conversation's messages: their order (time, then id) and numbers 1..n (`order`; `changed`:
 * the ids whose number moves), the last visible message (`lastVisibleId`, for the preview), and the conversation's
 * derived fields as Chat keeps them while it runs (`set`): the last number, the visitor's messages, AI replies,
 * whether staff replied, the first visitor message and staff reply, the last visible message's time (else the given
 * `lastMessageAt`), and the read marks behind the given unread counts (each at most the messages there are).
 * @param {{ lastMessageAt: Date, unreadStaff?: number, unreadVisitor?: number }} conversation
 * @param {MessageFacts[]} messages
 */
export const finishPlan = (conversation, messages) => {
	const sorted = [...messages].sort(
		(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const numbered = sorted.map((m, index) => ({ ...m, seq: index + 1 }));
	const visible = numbered.filter((m) => !m.internal);
	const fromVisitor = visible.filter((m) => m.author === 'visitor');
	const replies = visible.filter((m) => m.author !== 'visitor');
	const staff = visible.filter((m) => m.author === 'staff');
	const last = visible.at(-1) ?? null;
	const unreadStaff = Math.min(Number(conversation.unreadStaff ?? 0), fromVisitor.length);
	const unreadVisitor = Math.min(Number(conversation.unreadVisitor ?? 0), replies.length);
	/** The number before the first of the last `count` messages of a list, else the last number. @param {typeof numbered} list @param {number} count */
	const seenBefore = (list, count) => (count > 0 ? Number(list[list.length - count]?.seq) - 1 : numbered.length);
	return {
		order: sorted.map((m) => m.id),
		changed: sorted.filter((m, index) => m.seq !== index + 1).map((m) => m.id),
		lastVisibleId: last?.id ?? null,
		set: {
			lastSeq: numbered.length,
			visitorMessages: fromVisitor.length,
			aiReplies: visible.filter((m) => m.author === 'ai').length,
			staffReplied: staff.length > 0,
			firstVisitorAt: fromVisitor[0]?.createdAt ?? null,
			firstStaffReplyAt: staff[0]?.createdAt ?? null,
			lastMessageAt: last?.createdAt ?? conversation.lastMessageAt,
			unreadStaff,
			unreadVisitor,
			staffSeenSeq: seenBefore(fromVisitor, unreadStaff),
			visitorSeenSeq: seenBefore(replies, unreadVisitor),
		},
	};
};

/**
 * A conversation's preview of its last visible message, as Chat writes it when a message comes.
 * @param {{ text?: string, format?: string, attachment?: { name?: string } | null }} message
 */
export const previewText = (message) =>
	previewOf(
		(message.format === 'markdown' ? plainOf(String(message.text ?? '')) : String(message.text ?? '')) ||
			message.attachment?.name ||
			'',
	);

/**
 * The fields of `set` whose value differs from the record's, or null when none does (dates compared by time).
 * @param {Record<string, unknown>} record
 * @param {Record<string, unknown>} set
 * @returns {Record<string, unknown> | null}
 */
export const changesOf = (record, set) => {
	const changed = Object.entries(set).filter(([field, value]) => JSON.stringify(record[field]) !== JSON.stringify(value));
	return changed.length > 0 ? Object.fromEntries(changed) : null;
};
