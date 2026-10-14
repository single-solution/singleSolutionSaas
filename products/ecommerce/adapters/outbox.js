/**
 * The message outbox in the merchant database (K-17, owner decision D7: nothing that matters may be lost): order and
 * claim messages and staff alerts are saved here before each is sent through Notifications, removed once Notifications
 * took it (or refused it for good), and tried again on the website's next uses while the call failed. A message not
 * sent within {@link KEEP_MS} is given up; `expireAt` lets the database remove a row the website never used again. A
 * data-rights deletion removes a person's rows at once (E63).
 * @module
 */
import { createId } from '@ss/contracts';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/**
 * One message to send; `fallbackTemplate`: the key Notifications uses when the website has no template of its own for
 * `template` (a per-status order message falls back to the general one).
 * @typedef {{ channel: 'email' | 'sms' | 'whatsapp', template: string, fallbackTemplate?: string,
 *   to: { email: string } | { phone: string }, values: Record<string, string | number> }} OutboxMessage
 */

/**
 * A saved message: `nextAt` is when it may be tried (a try in progress holds it for a while), `firstAt` when it was saved.
 * @typedef {OutboxMessage & { id: string, tries: number, nextAt: Date, firstAt: Date, expireAt: Date }} OutboxEntry
 */

/** A message is tried for at most a day (Notifications keeps an idempotency key that long). */
export const KEEP_MS = 24 * 3_600_000;
/** A try holds its message this long, so two instances never send it at once. */
const LEASE_MS = 5 * 60_000;

/** Merchant database indexes of the outbox. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: COLLECTIONS.outbox, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.outbox, keys: { websiteId: 1, nextAt: 1 }, name: 'by_next' },
	// a row of a website that was never used again goes a day after it was given up
	{ collection: COLLECTIONS.outbox, keys: { expireAt: 1 }, name: 'expiry', expireAfterSeconds: 0 },
];

const NO_ID = Object.freeze({ projection: { _id: 0 } });

/**
 * @param {WebsiteData} data the website's guarded merchant database
 */
export const createOutbox = (data) => {
	const { websiteId } = data;
	const rows = data.collection(COLLECTIONS.outbox);

	return Object.freeze({
		/**
		 * Save messages before their first try, held by that try.
		 * @param {OutboxMessage[]} messages @param {number} now
		 * @returns {Promise<OutboxEntry[]>}
		 */
		add: async (messages, now) => {
			const entries = messages.map((message) => ({
				...message,
				id: createId(ID_PREFIX.outbox),
				tries: 0,
				nextAt: new Date(now + LEASE_MS),
				firstAt: new Date(now),
				expireAt: new Date(now + 2 * KEEP_MS),
			}));
			if (entries.length > 0) await rows.insertMany(entries.map((entry) => ({ ...entry })));
			return entries;
		},
		/**
		 * Messages due again, oldest first.
		 * @param {number} now @param {number} limit
		 * @returns {Promise<OutboxEntry[]>}
		 */
		due: async (now, limit) =>
			/** @type {OutboxEntry[]} */ (
				await rows.find({ websiteId, nextAt: { $lte: new Date(now) } }, { ...NO_ID, sort: { nextAt: 1 }, limit }).toArray()
			),
		/**
		 * Hold a due message for a try; false when another try took it first.
		 * @param {OutboxEntry} entry @param {number} now
		 */
		hold: async (entry, now) =>
			(await rows.updateOne({ websiteId, id: entry.id, nextAt: entry.nextAt }, { $set: { nextAt: new Date(now + LEASE_MS) } }))
				.modifiedCount === 1,
		/**
		 * Try a message again later.
		 * @param {string} id @param {{ tries: number, nextAt: Date }} next
		 */
		later: async (id, { tries, nextAt }) => {
			await rows.updateOne({ websiteId, id }, { $set: { tries, nextAt } });
		},
		/** A message sent, or given up. @param {string} id */
		done: async (id) => {
			await rows.deleteOne({ websiteId, id });
		},
		/**
		 * Remove a person's messages (data rights): those to their email addresses or phones, and those about their orders
		 * (order messages and staff alerts carry the order's `number`).
		 * @param {{ emails: string[], phones: string[], numbers: string[] }} person
		 * @returns {Promise<number>} the messages removed
		 */
		forget: async ({ emails, phones, numbers }) => {
			const or = [
				...(emails.length > 0 ? [{ 'to.email': { $in: emails } }] : []),
				...(phones.length > 0 ? [{ 'to.phone': { $in: phones } }] : []),
				...(numbers.length > 0 ? [{ 'values.number': { $in: numbers } }] : []),
			];
			return or.length === 0 ? 0 : (await rows.deleteMany({ websiteId, $or: or })).deletedCount;
		},
	});
};

/** @typedef {ReturnType<typeof createOutbox>} Outbox */
