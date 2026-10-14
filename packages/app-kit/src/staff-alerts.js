/**
 * Staff alerts (PLAN 0.8.10 K6): one kit helper for products that alert the merchant's staff through Notifications
 * (the pasted Notifications token).
 *
 * - Recipients: the feature's `recipients` setting (email addresses and phone numbers, at most 20); plus, when its
 *   `staffPermission` setting names a permission, every unblocked Accounts user whose role grants it (through the
 *   pasted Accounts token: `GET /v1/users?permission=<product>:<key>&blocked=false`, cached 5 minutes); plus the
 *   assignee where the product has one.
 * - An email address gets email; an international phone number gets WhatsApp, or SMS with the feature's
 *   `phoneChannel` setting.
 * - Templates `<product>.staff_<event>` (required, not urgent); one message per address per event, sent right after the
 *   request with `required: true` and its own `Idempotency-Key`; the link is built from the feature's `adminUrl`
 *   template (`{placeholders}` filled from the values) and sent as the value `link`.
 * - Nothing that matters is lost (K-17, owner decision D7): a message Notifications did not take (no answer, 5xx, a
 *   refused token, 408, 409 `in_progress` or 429) is saved in the merchant database (`ss_<product>_staff_alerts`) and
 *   tried again with the same key on the website's next uses ({@link RETRY_MS}, then every 3 hours), for at most a day;
 *   a TTL index removes rows a website never used again. Nothing runs in the background.
 * - A data-rights deletion removes the saved messages that hold the person's details at once (as Ecommerce's outbox,
 *   E63): those to one of their addresses, those with a value that is one of them, and those the product names by a
 *   value (`forget`, for example Chat's alerts about the person's conversations).
 * @module
 */
import { createId } from '@ss/contracts';
import { normalisePhone } from '@ss/contracts/phone';
import { formatText } from './text.js';

/** @typedef {{ email?: string | null, phone?: string | null }} Assignee */
/**
 * @typedef {{ websiteId: string, merchantId?: string | null, after: (task: () => Promise<unknown>) => void }} AlertContext
 */
/**
 * One message of an alert: `id` names it to Notifications (its `Idempotency-Key`) on every try.
 * @typedef {{ id: string, channel: 'email' | 'sms' | 'whatsapp', template: string,
 *   to: { email: string } | { phone: string }, values: Record<string, string | number> }} AlertMessage
 */
/**
 * A saved message: `tries` so far, `nextAt` when it may be tried again (a try in progress holds it), `firstAt` when it
 * was first sent.
 * @typedef {AlertMessage & { tries: number, nextAt: Date, firstAt: Date, expireAt: Date }} SavedAlert
 */

/** Most recipients a `recipients` setting holds. */
export const MAX_RECIPIENTS = 20;
/** Waits before a message Notifications did not take is tried again (as Ecommerce's outbox, E63): 1, 5, 15, 60 minutes, then every 3 hours. */
export const RETRY_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000]);
/** A message is tried for at most a day after its first try (Notifications keeps an Idempotency-Key that long). */
export const ALERT_KEEP_MS = 24 * 3_600_000;
/** A try holds a saved message this long, so two instances never send it at once. */
const LEASE_MS = 5 * 60_000;
/** Saved messages tried again per use of a website, at most. */
const RETRY_BATCH = 20;
/** An instance looks for saved messages of a website at most this often. */
const LOOK_EVERY_MS = 60_000;
/** Why a call to Notifications is tried again: it did not take the message. */
const RETRY_REASONS = Object.freeze(['unreachable', 'unavailable', 'refused']);
const COLLECTION = 'staff_alerts';

/** Merchant database indexes of saved messages (created when the first one is saved). */
const STAFF_ALERT_INDEXES = Object.freeze(
	/** @type {import('./data.js').IndexDefinition[]} */ ([
		{ collection: COLLECTION, keys: { websiteId: 1, nextAt: 1 }, name: 'kit_staff_alerts_due' },
		{ collection: COLLECTION, keys: { expireAt: 1 }, name: 'kit_staff_alerts_expiry', expireAfterSeconds: 0 },
	]),
);

/**
 * What an answer of Notifications means for a message: taken (a 409 `duplicate_request` is an earlier try that got
 * through), not connected (no token), to try again, or refused for good (a missing template, values it refuses …).
 * @param {import('./connections.js').ProductCall} answer
 * @returns {'sent' | 'not_connected' | 'retry' | 'failed'}
 */
export const alertOutcome = (answer) => {
	if (answer.ok) return 'sent';
	if (answer.reason === 'not_connected') return 'not_connected';
	const type = /** @type {{ type?: unknown } | null | undefined} */ (answer.body)?.type;
	const code = typeof type === 'string' ? type.split('/').pop() : '';
	if (answer.status === 409 && code === 'duplicate_request') return 'sent';
	if (
		RETRY_REASONS.includes(String(answer.reason)) ||
		answer.status === 408 ||
		answer.status === 429 ||
		(answer.status === 409 && code === 'in_progress')
	)
		return 'retry';
	return 'failed';
};
/** Accounts users with a permission are asked again after this long. */
const STAFF_CACHE_MS = 5 * 60_000;
/** Most Accounts users read per permission. */
const STAFF_PAGE = 100;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const EVENT = /^[a-z][a-z0-9_]{0,40}$/;
const PERMISSION = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * An address as a recipient: `{ email }` or `{ phone }` with its dedupe key, or null. Phones are E.164 through the
 * normalizer every product shares (`@ss/contracts/phone`), with their `+` or `00` and calling code, as Notifications
 * sends to them; a local number is left out.
 * @param {unknown} value
 * @returns {{ key: string, to: { email: string } | { phone: string } } | null}
 */
export const recipientOf = (value) => {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (EMAIL.test(text)) return { key: `e:${text.toLowerCase()}`, to: { email: text.toLowerCase() } };
	const phone = normalisePhone(text);
	return phone ? { key: `p:${phone.slice(1)}`, to: { phone } } : null;
};

/**
 * @param {{ productId: string, settings: import('./settings.js').Settings,
 *   connections: import('./connections.js').Connections, data: import('./data.js').Data, now: () => number,
 *   logger: import('./logger.js').Logger }} options
 */
export const createStaffAlerts = ({ productId, settings, connections, data, now, logger }) => {
	/** @type {Map<string, { at: number, addresses: string[] }>} */
	const staffCache = new Map();
	/** Per instance: when the saved messages of a website were last looked for. @type {Map<string, number>} */
	const lookedAt = new Map();
	/** A product without a Notifications token connection never sends an alert, so it never looks for saved ones. */
	const sends = Object.values(connections.definitions).some((def) => def.kind === 'token' && def.productId === 'notifications');

	/**
	 * Send one message through Notifications (pasted token), required, with its own Idempotency-Key.
	 * @param {string} websiteId
	 * @param {AlertMessage} message
	 */
	const post = (websiteId, message) =>
		connections
			.callProduct(websiteId, 'notifications', `/v1/messages/${message.channel}`, {
				method: 'POST',
				body: { template: message.template, to: message.to, values: message.values, required: true },
				headers: { 'idempotency-key': `${productId}-${message.id}` },
			})
			.catch(() => /** @type {const} */ ({ ok: false, reason: 'unreachable' }));

	/** @param {string} websiteId @param {string | null | undefined} merchantId */
	const savedOf = async (websiteId, merchantId) =>
		(await data.forWebsite(websiteId, merchantId ? { merchantId } : {})).collection(COLLECTION);

	/**
	 * The email addresses and phones of unblocked Accounts users whose role grants a permission (cached 5 minutes).
	 * @param {string} websiteId
	 * @param {string} permission `<product>:<key>`
	 * @returns {Promise<string[]>}
	 */
	const staffWith = async (websiteId, permission) => {
		const key = `${websiteId}|${permission}`;
		const cached = staffCache.get(key);
		if (cached && now() - cached.at < STAFF_CACHE_MS) return cached.addresses;
		const answer = await connections.callProduct(
			websiteId,
			'accounts',
			`/v1/users?permission=${encodeURIComponent(permission)}&blocked=false&limit=${STAFF_PAGE}`,
		);
		if (!answer.ok) {
			logger.info('staff with a permission not read from Accounts', { websiteId, reason: answer.reason });
			return cached?.addresses ?? [];
		}
		const body = /** @type {{ items?: unknown }} */ (answer.body ?? {});
		const items = Array.isArray(body.items) ? body.items : [];
		/** @type {string[]} */
		const addresses = [];
		for (const user of items) {
			if (typeof user !== 'object' || user === null) continue;
			const { email, phone, blocked } = /** @type {Record<string, unknown>} */ (user);
			if (blocked === true) continue;
			if (typeof email === 'string' && email !== '') addresses.push(email);
			else if (typeof phone === 'string' && phone !== '') addresses.push(phone);
		}
		staffCache.set(key, { at: now(), addresses });
		return addresses;
	};

	/**
	 * Everyone an alert of a feature goes to, deduplicated.
	 * @param {string} websiteId
	 * @param {Record<string, any>} values the feature's settings
	 * @param {Assignee | null | undefined} assignee
	 */
	const recipientsOf = async (websiteId, values, assignee) => {
		const listed = Array.isArray(values.recipients) ? values.recipients.slice(0, MAX_RECIPIENTS) : [];
		const permission = typeof values.staffPermission === 'string' ? values.staffPermission : '';
		const staff =
			permission !== '' && PERMISSION.test(permission) ? await staffWith(websiteId, `${productId}:${permission}`) : [];
		const assigned = [assignee?.email, assignee?.phone].filter((value) => typeof value === 'string' && value !== '');
		/** @type {Map<string, { email: string } | { phone: string }>} */
		const out = new Map();
		for (const value of [...listed, ...staff, ...assigned]) {
			const found = recipientOf(value);
			if (found && !out.has(found.key)) out.set(found.key, found.to);
		}
		return [...out.values()];
	};

	/**
	 * Alert the merchant's staff of an event, right after the request. Never throws.
	 * @param {AlertContext} ctx
	 * @param {{ feature: string, event: string, values: Record<string, string | number>, assignee?: Assignee | null }} alert
	 *   `feature`: the feature whose settings hold `recipients`, `staffPermission`, `phoneChannel` and `adminUrl`;
	 *   `event`: the template is `<product>.staff_<event>`; `values`: the template's values (at most 1,000 characters each)
	 * @returns {Promise<number>} the messages queued after the request
	 */
	const send = async (ctx, { feature, event, values, assignee = null }) => {
		if (!EVENT.test(event)) return 0;
		const own = await settings.values(ctx.websiteId, feature);
		const to = await recipientsOf(ctx.websiteId, own, assignee);
		if (to.length === 0) return 0;
		const template = `${productId}.staff_${event}`;
		const adminUrl = typeof own.adminUrl === 'string' ? own.adminUrl : '';
		const link = adminUrl === '' ? '' : formatText(adminUrl, values);
		const channelOfPhone = own.phoneChannel === 'sms' ? 'sms' : 'whatsapp';
		/** @type {AlertMessage[]} */
		const messages = to.map((recipient) => ({
			id: createId('sal'),
			channel: 'email' in recipient ? 'email' : channelOfPhone,
			template,
			to: recipient,
			values: { ...values, ...(link === '' ? {} : { link }) },
		}));
		ctx.after(async () => {
			/** @type {AlertMessage[]} */
			const missed = [];
			for (const message of messages) {
				const answer = await post(ctx.websiteId, message);
				const outcome = alertOutcome(answer);
				if (outcome === 'retry') missed.push(message);
				else if (outcome !== 'sent')
					logger.info('staff alert not sent', {
						websiteId: ctx.websiteId,
						template,
						reason: answer.ok ? outcome : answer.reason,
					});
			}
			if (missed.length === 0) return;
			const at = now();
			try {
				const db = await data.forWebsite(ctx.websiteId, ctx.merchantId ? { merchantId: ctx.merchantId } : {});
				await db.ensureIndexes([...STAFF_ALERT_INDEXES]);
				await db.collection(COLLECTION).insertMany(
					missed.map((message) => ({
						...message,
						tries: 1,
						nextAt: new Date(at + /** @type {number} */ (RETRY_MS[0])),
						firstAt: new Date(at),
						expireAt: new Date(at + ALERT_KEEP_MS),
					})),
				);
				lookedAt.delete(ctx.websiteId);
				logger.info('staff alert not taken; tried again on a later use', { websiteId: ctx.websiteId, template });
			} catch (error) {
				logger.warn('staff alert not sent and not saved', { websiteId: ctx.websiteId, template, error });
			}
		});
		return to.length;
	};

	/**
	 * Right after a request for the website: try again the saved messages that are due (at most {@link RETRY_BATCH};
	 * an instance looks at most every minute, and only in a product that can send alerts). A message Notifications
	 * still does not take waits longer, and is given up a day after its first try.
	 * @param {string} websiteId
	 * @param {string | null} merchantId
	 */
	const retry = async (websiteId, merchantId) => {
		const t = now();
		if (!sends || t - (lookedAt.get(websiteId) ?? -Infinity) < LOOK_EVERY_MS) return;
		lookedAt.set(websiteId, t);
		const rows = await savedOf(websiteId, merchantId);
		const due = /** @type {SavedAlert[]} */ (
			await rows
				.find(
					{ websiteId, nextAt: { $lte: new Date(t) } },
					{ projection: { _id: 0 }, sort: { nextAt: 1 }, limit: RETRY_BATCH },
				)
				.toArray()
		);
		for (const row of due) {
			const held = await rows.updateOne(
				{ websiteId, id: row.id, nextAt: row.nextAt },
				{ $set: { nextAt: new Date(now() + LEASE_MS) } },
			);
			if (held.modifiedCount !== 1) continue;
			const answer = await post(websiteId, row);
			const outcome = alertOutcome(answer);
			if (outcome === 'retry') {
				const tries = row.tries + 1;
				const next = now() + /** @type {number} */ (RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]);
				if (next < new Date(row.firstAt).getTime() + ALERT_KEEP_MS) {
					await rows.updateOne({ websiteId, id: row.id }, { $set: { tries, nextAt: new Date(next) } });
					continue;
				}
			}
			await rows.deleteOne({ websiteId, id: row.id });
			if (outcome !== 'sent')
				logger.warn('staff alert given up', {
					websiteId,
					template: row.template,
					tries: row.tries + 1,
					reason: answer.ok ? outcome : answer.reason,
				});
		}
	};

	/**
	 * Remove a person's saved messages (data rights): those to one of their `addresses`, those with a value that is one
	 * of them (email addresses compared without case, phones through the shared normalizer), and those whose value
	 * `name` is one of `values[name]` (for example `{ conversationId: [...] }`). A product that cannot send alerts keeps
	 * none, so it never looks. The saved messages are few (only those Notifications did not take, for a day at most), so
	 * they are read and matched here.
	 * @param {{ websiteId: string, merchantId?: string | null }} ctx
	 * @param {{ addresses?: unknown[], values?: Record<string, unknown[]> }} person
	 * @returns {Promise<number>} the messages removed
	 */
	const forget = async (ctx, { addresses = [], values = {} }) => {
		const keys = new Set(addresses.map((value) => recipientOf(value)?.key).filter((key) => key !== undefined));
		const named = new Map(Object.entries(values).map(([name, list]) => [name, new Set(list.map(String))]));
		if (!sends || (keys.size === 0 && [...named.values()].every((list) => list.size === 0))) return 0;
		const rows = await savedOf(ctx.websiteId, ctx.merchantId);
		const saved = /** @type {Array<Pick<SavedAlert, 'id' | 'to' | 'values'>>} */ (
			await rows.find({ websiteId: ctx.websiteId }, { projection: { _id: 0, id: 1, to: 1, values: 1 } }).toArray()
		);
		/** @param {unknown} value */
		const isAddress = (value) => keys.has(recipientOf(value)?.key ?? '');
		const ids = saved
			.filter(
				(row) =>
					isAddress('email' in row.to ? row.to.email : row.to.phone) ||
					Object.entries(row.values ?? {}).some(([name, value]) => isAddress(value) || named.get(name)?.has(String(value))),
			)
			.map((row) => row.id);
		return ids.length === 0 ? 0 : (await rows.deleteMany({ websiteId: ctx.websiteId, id: { $in: ids } })).deletedCount;
	};

	return Object.freeze({ send, retry, forget, recipients: recipientsOf });
};

/** @typedef {ReturnType<typeof createStaffAlerts>} StaffAlerts */
