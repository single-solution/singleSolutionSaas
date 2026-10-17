/**
 * Staff alerts (PLAN 0.8.10 K6): one kit helper for products that alert the merchant's staff through Notifications
 * (the Portal link to Notifications).
 *
 * - Recipients: the website's alert team in the Portal (Website settings › Team and alerts: each person's email and
 *   phone); plus, when the feature's `staffPermission` setting names a permission, every
 *   unblocked Accounts user whose role grants it (through the Portal's link to Accounts:
 *   `GET /v1/users?permission=<product>:<key>&blocked=false`, cached 5 minutes) — the value `all_staff` names the
 *   permission the alert gives as `allStaff` (the one every staff member who works with it has, for example Chat's
 *   `inbox.read`); plus the assignee where the product has one. At most the alert's `maxRecipients` (the product's
 *   own constant; default {@link MAX_RECIPIENTS}, at most {@link RECIPIENTS_CAP}) people per alert.
 * - A channel per recipient (fixed-choices audit K8): an email address gets email and an international phone number
 *   the team's phone channel (SMS unless the merchant chose WhatsApp). Accounts staff get email (or their phone without
 *   one), and staff push too (`push:<Accounts user id>`, the merchant's own push keys) while the team's staff push is on.
 *   The channel and staff push are the Portal's, one choice for every product of the website.
 * - Templates `<product>.staff_<event>` (required, not urgent); one message per address per event, sent right after the
 *   request with `required: true` and its own `Idempotency-Key`, carrying the product's default words of the template
 *   (`callProduct`, parity P1); the link is built from the feature's `adminUrl` template (`{placeholders}` filled from
 *   the values) and sent as the value `link`.
 * - A product that keeps its own outbox (saved before the request is answered, one retry queue for all its messages)
 *   takes the messages from `prepare` and delivers them itself; `send`, the saved messages here, `retry` and `forget` are
 *   then not used.
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
import { normalizePhone } from '@ss/contracts/phone';
import { formatText } from './text.js';

/** @typedef {{ email?: string | null, phone?: string | null, id?: string | null }} Assignee */
/**
 * @typedef {{ websiteId: string, merchantId?: string | null, after: (task: () => Promise<unknown>) => void }} AlertContext
 */
/**
 * One message of an alert: `id` names it to Notifications (its `Idempotency-Key`) on every try.
 * @typedef {{ id: string, channel: 'email' | 'sms' | 'whatsapp' | 'staff_push', template: string,
 *   to: { email: string } | { phone: string } | { staffId: string }, values: Record<string, string | number> }} AlertMessage
 */
/**
 * A saved message: `tries` so far, `nextAt` when it may be tried again (a try in progress holds it), `firstAt` when it
 * was first sent.
 * @typedef {AlertMessage & { tries: number, nextAt: Date, firstAt: Date, expireAt: Date }} SavedAlert
 */

/** The `staffPermission` value that means every staff member who works with the alert (the alert's `allStaff`). */
const ALL_STAFF = 'all_staff';
/** People one alert goes to unless the alert's `maxRecipients` says otherwise, and the most it may say. */
export const MAX_RECIPIENTS = 20;
const RECIPIENTS_CAP = 200;
/** The Notifications route of each channel. */
const CHANNEL_PATHS = Object.freeze({ email: 'email', sms: 'sms', whatsapp: 'whatsapp', staff_push: 'staff-push' });
const STAFF_ID = /^[A-Za-z0-9_-]{1,64}$/;
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
 * An address: `{ email }` or `{ phone }` with the key that names the person whatever the channel, or null. Phones are
 * E.164 through the normalizer every product shares (`@ss/contracts/phone`), with their `+` or `00` and calling code,
 * as Notifications sends to them; a local number is left out.
 * @param {unknown} value
 * @returns {{ key: string, to: { email: string } | { phone: string } } | null}
 */
export const addressOf = (value) => {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (EMAIL.test(text)) return { key: `e:${text.toLowerCase()}`, to: { email: text.toLowerCase() } };
	const phone = normalizePhone(text);
	return phone ? { key: `p:${phone.slice(1)}`, to: { phone } } : null;
};

/**
 * A recipient with its channel (K8), or null: `push:<Accounts user id>` is a staff push; an email address gets email, a
 * phone `phoneChannel`. `key` dedupes one person on one channel.
 * @param {unknown} value
 * @param {'whatsapp' | 'sms'} [phoneChannel]
 * @returns {{ key: string, channel: AlertMessage['channel'], to: AlertMessage['to'] } | null}
 */
export const recipientOf = (value, phoneChannel = 'sms') => {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	const push = /^push:\s*(.+)$/i.exec(text);
	if (push) {
		const id = /** @type {string} */ (push[1]).trim();
		return STAFF_ID.test(id) ? { key: `staff_push|u:${id}`, channel: 'staff_push', to: { staffId: id } } : null;
	}
	const address = addressOf(text);
	if (!address) return null;
	const email = 'email' in address.to;
	const via = email ? 'email' : phoneChannel;
	return { key: `${via}|${address.key}`, channel: via, to: address.to };
};

/**
 * @param {{ productId: string, settings: import('./settings.js').Settings,
 *   connections: import('./connections.js').Connections, data: import('./data.js').Data, now: () => number,
 *   logger: import('./logger.js').Logger, website: import('./website-settings.js').WebsiteSettingsCache }} options
 *   `website`: the Portal's copy of the website's settings (its team gets the alerts)
 */
export const createStaffAlerts = ({ productId, settings, connections, data, now, logger, website }) => {
	/** @type {Map<string, { at: number, people: Array<{ address: string, id: string | null }> }>} */
	const staffCache = new Map();
	/** Per instance: when the saved messages of a website were last looked for. @type {Map<string, number>} */
	const lookedAt = new Map();
	/** A product without a Notifications token connection never sends an alert, so it never looks for saved ones. */
	const sends = connections.declaresLink('notifications');

	/**
	 * Send one message through Notifications (Portal link), required, with its own Idempotency-Key.
	 * @param {string} websiteId
	 * @param {AlertMessage} message
	 */
	const post = (websiteId, message) =>
		connections
			.callProduct(websiteId, 'notifications', `/v1/messages/${CHANNEL_PATHS[message.channel]}`, {
				method: 'POST',
				body: { template: message.template, to: message.to, values: message.values, required: true },
				headers: { 'idempotency-key': `${productId}-${message.id}` },
			})
			.catch(() => /** @type {const} */ ({ ok: false, reason: 'unreachable' }));

	/** @param {string} websiteId @param {string | null | undefined} merchantId */
	const savedOf = async (websiteId, merchantId) =>
		(await data.forWebsite(websiteId, merchantId ? { merchantId } : {})).collection(COLLECTION);

	/**
	 * Unblocked Accounts users whose role grants a permission (cached 5 minutes): each one's email address (or phone
	 * without one) and user id (staff push).
	 * @param {string} websiteId
	 * @param {string} permission `<product>:<key>`
	 * @returns {Promise<Array<{ address: string, id: string | null }>>}
	 */
	const staffWith = async (websiteId, permission) => {
		const key = `${websiteId}|${permission}`;
		const cached = staffCache.get(key);
		if (cached && now() - cached.at < STAFF_CACHE_MS) return cached.people;
		const answer = await connections.callProduct(
			websiteId,
			'accounts',
			`/v1/users?permission=${encodeURIComponent(permission)}&blocked=false&limit=${STAFF_PAGE}`,
		);
		if (!answer.ok) {
			logger.info('staff with a permission not read from Accounts', { websiteId, reason: answer.reason });
			return cached?.people ?? [];
		}
		const body = /** @type {{ items?: unknown }} */ (answer.body ?? {});
		const items = Array.isArray(body.items) ? body.items : [];
		/** @type {Array<{ address: string, id: string | null }>} */
		const people = [];
		for (const user of items) {
			if (typeof user !== 'object' || user === null) continue;
			const { id, email, phone, blocked } = /** @type {Record<string, unknown>} */ (user);
			if (blocked === true) continue;
			const address = typeof email === 'string' && email !== '' ? email : typeof phone === 'string' ? phone : '';
			people.push({ address, id: typeof id === 'string' && STAFF_ID.test(id) ? id : null });
		}
		staffCache.set(key, { at: now(), people });
		return people;
	};

	/**
	 * Everyone an alert of a feature goes to, deduplicated.
	 * @param {string} websiteId
	 * @param {Record<string, any>} values the feature's settings (`staffPermission`)
	 * @param {Assignee | null | undefined} assignee
	 * @param {string} [allStaff] the permission `staffPermission: all_staff` stands for (none: only the list)
	 * @param {number} [maxRecipients] the most people one alert goes to
	 */
	const recipientsOf = async (websiteId, values, assignee, allStaff = '', maxRecipients = MAX_RECIPIENTS) => {
		const most = Number.isInteger(maxRecipients) ? Math.min(Math.max(maxRecipients, 1), RECIPIENTS_CAP) : MAX_RECIPIENTS;
		// the alert team is the website's, set once in the Portal for every product (Website settings › Team and alerts)
		const { team } = await website.document(websiteId);
		const phoneChannel = team.phoneChannel === 'whatsapp' ? 'whatsapp' : 'sms';
		const push = team.staffPush === true;
		const listed = team.recipients
			.flatMap((person) => [person.email, person.phone])
			.filter(Boolean)
			.slice(0, RECIPIENTS_CAP);
		const chosen = typeof values.staffPermission === 'string' ? values.staffPermission : '';
		const permission = chosen === ALL_STAFF ? allStaff : chosen;
		const staff =
			permission !== '' && PERMISSION.test(permission) ? await staffWith(websiteId, `${productId}:${permission}`) : [];
		/** @param {{ address?: string | null, id?: string | null }} person */
		const asStaff = ({ address, id }) => [address ?? '', ...(push && id ? [`push:${id}`] : [])];
		const assigned = assignee ? [assignee.email, assignee.phone, ...(push && assignee.id ? [`push:${assignee.id}`] : [])] : [];
		/** @type {Map<string, { channel: AlertMessage['channel'], to: AlertMessage['to'] }>} */
		const out = new Map();
		for (const value of [...listed, ...staff.flatMap(asStaff), ...assigned]) {
			const found = recipientOf(value, phoneChannel);
			if (found && !out.has(found.key)) out.set(found.key, { channel: found.channel, to: found.to });
		}
		return [...out.values()].slice(0, most);
	};

	/**
	 * The messages of an alert, without sending or saving any: who gets it (the feature's recipients, the Accounts staff
	 * with the permission, the assignee; at most the alert's `maxRecipients`), on which channel, with the template
	 * `<product>.staff_<event>`, the values and the link built from `adminUrl`. For a product that delivers its alerts
	 * itself (its own outbox: saved before the request is answered, one retry queue for all its messages); {@link send}
	 * delivers them with the kit's own queue.
	 * @param {{ websiteId: string }} ctx
	 * @param {{ feature: string, event: string, values: Record<string, string | number>, assignee?: Assignee | null,
	 *   allStaff?: string, maxRecipients?: number }} alert
	 *   `feature`: the feature whose settings hold `staffPermission` and `adminUrl` (the recipients, their phone channel and
	 *   staff push are the Portal's team); `maxRecipients`: the most people one alert goes to (the product's own fixed limit);
	 *   `event`: the template is `<product>.staff_<event>`; `values`: the template's values (at most 1,000 characters each);
	 *   `allStaff`: the permission key the setting's `all_staff` stands for (every staff member who works with the alert)
	 * @returns {Promise<AlertMessage[]>} each with its own `id` (a send uses it as the Idempotency-Key)
	 */
	const prepare = async (ctx, { feature, event, values, assignee = null, allStaff = '', maxRecipients }) => {
		if (!EVENT.test(event)) return [];
		const own = await settings.values(ctx.websiteId, feature);
		const to = await recipientsOf(ctx.websiteId, own, assignee, allStaff, maxRecipients);
		const template = `${productId}.staff_${event}`;
		const adminUrl = typeof own.adminUrl === 'string' ? own.adminUrl : '';
		const link = adminUrl === '' ? '' : formatText(adminUrl, values);
		return to.map((recipient) => ({
			id: createId('sal'),
			channel: recipient.channel,
			template,
			to: recipient.to,
			values: { ...values, ...(link === '' ? {} : { link }) },
		}));
	};

	/**
	 * Alert the merchant's staff of an event, right after the request. Never throws.
	 * @param {AlertContext} ctx
	 * @param {Parameters<typeof prepare>[1]} alert as for {@link prepare}
	 * @returns {Promise<number>} the messages queued after the request
	 */
	const send = async (ctx, alert) => {
		const messages = await prepare(ctx, alert);
		if (messages.length === 0) return 0;
		const template = `${productId}.staff_${alert.event}`;
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
		return messages.length;
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
		const keys = new Set(addresses.map((value) => addressOf(value)?.key).filter((key) => key !== undefined));
		const named = new Map(Object.entries(values).map(([name, list]) => [name, new Set(list.map(String))]));
		if (!sends || (keys.size === 0 && [...named.values()].every((list) => list.size === 0))) return 0;
		const rows = await savedOf(ctx.websiteId, ctx.merchantId);
		const saved = /** @type {Array<Pick<SavedAlert, 'id' | 'to' | 'values'>>} */ (
			await rows.find({ websiteId: ctx.websiteId }, { projection: { _id: 0, id: 1, to: 1, values: 1 } }).toArray()
		);
		/** @param {unknown} value */
		const isAddress = (value) => keys.has(addressOf(value)?.key ?? '');
		const ids = saved
			.filter(
				(row) =>
					isAddress('email' in row.to ? row.to.email : 'phone' in row.to ? row.to.phone : null) ||
					Object.entries(row.values ?? {}).some(([name, value]) => isAddress(value) || named.get(name)?.has(String(value))),
			)
			.map((row) => row.id);
		return ids.length === 0 ? 0 : (await rows.deleteMany({ websiteId: ctx.websiteId, id: { $in: ids } })).deletedCount;
	};

	return Object.freeze({ send, prepare, retry, forget, recipients: recipientsOf });
};

/** @typedef {ReturnType<typeof createStaffAlerts>} StaffAlerts */
