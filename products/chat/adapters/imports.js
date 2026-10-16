/**
 * The `import` feature (PLAN 0.8.10 K10, Migration step 7): what the kit's import routes take into Chat — `staff`,
 * `guests` (found by the hash of the old guest cookie value, so guest conversations keep working through it, C7),
 * `conversations` and their `messages` (one record per message) — checked by `core/imports.js` with the website's
 * staff list, custom fields and calling code; `finish`, which numbers each imported conversation's messages 1..n in
 * time order and derives its counters, preview and read marks (C8), a bounded batch of conversations per call; and the
 * sums `ss-import verify` compares. Nothing is sent: no message, event, alert, AI call or activity copy.
 * @module
 */
import { problem } from '@ss/app-kit';
import { isId } from '@ss/contracts';
import { callingCodeOf } from '@ss/contracts/phone';
import { STATUSES } from '../core/conversation.js';
import { changesOf, checkConversation, checkGuest, checkMessage, checkStaff, finishPlan, previewText } from '../core/imports.js';

/**
 * What the import checks read of the website (built in `product.js` on the kit's product).
 * @typedef {object} ImportDeps
 * @property {(websiteId: string, feature: string) => Promise<Record<string, unknown>>} settings a feature's settings
 * @property {(websiteId: string, name: 'custom_fields' | 'tags' | 'topics' | 'priorities') => Promise<any[]>} list a list
 *   setting
 * @property {(websiteId: string) => Promise<{ country?: string | null }>} business the business.json copy
 */

/** Conversations one `finish` call takes (call again with `?after=<next>` while `more`). */
const FINISH_BATCH = 100;
/** The kit's note of the keys imports wrote (`ss_chat_imports`): `finish` takes only imported conversations. */
const LEDGER = 'imports';

/**
 * The kit's `imports` option.
 * @param {ImportDeps} deps
 * @returns {import('@ss/app-kit').ImportOptions}
 */
export const createImportOptions = (deps) => ({
	collections: {
		staff: { check: (record) => checkStaff(record) },
		guests: {
			key: ['keyHash'],
			prepare: async (ctx) => ({ rememberDays: Number((await deps.settings(ctx.websiteId, 'guest_chat')).rememberDays) }),
			check: (record, ctx) =>
				checkGuest(record, { now: ctx.now(), rememberDays: /** @type {any} */ (ctx.prepared).rememberDays }),
		},
		conversations: {
			prepare: async (ctx) => ({
				callingCode: callingCodeOf((await deps.business(ctx.websiteId)).country),
				staffIds: new Set((await ctx.data.collection('staff').distinct('id', { websiteId: ctx.websiteId })).map(String)),
				customFields: await deps.list(ctx.websiteId, 'custom_fields'),
				labels: {
					tags: await deps.list(ctx.websiteId, 'tags'),
					topics: await deps.list(ctx.websiteId, 'topics'),
					priorities: await deps.list(ctx.websiteId, 'priorities'),
				},
			}),
			check: (record, ctx) => checkConversation(record, /** @type {any} */ (ctx.prepared)),
		},
		messages: {
			// the conversations this call's messages name, looked up once each
			prepare: async () => new Map(),
			check: async (record, ctx) => {
				const checked = checkMessage(record);
				if (!checked.ok) return checked;
				const id = String(checked.value.conversationId);
				const known = /** @type {Map<string, boolean>} */ (ctx.prepared);
				if (!known.has(id))
					known.set(
						id,
						(await ctx.data.collection('conversations').countDocuments({ websiteId: ctx.websiteId, id }, { limit: 1 })) > 0,
					);
				return known.get(id)
					? checked
					: {
							ok: false,
							errors: [{ path: '/conversationId', message: `No conversation ${id}: import the conversations first.` }],
						};
			},
		},
	},
	finish: (ctx) => finish(ctx),
	totals: (ctx) => totals(ctx),
});

/**
 * `POST /v1/import/finish?after=<conversation id>`: the next {@link FINISH_BATCH} imported conversations by id, each
 * with its messages numbered and its derived fields set. Answers `{ conversations, renumbered, updated, next, more }`
 * (`renumbered`: messages whose number moved; `updated`: conversations whose derived fields changed). Re-running it
 * changes nothing.
 * @param {any} ctx
 */
const finish = async (ctx) => {
	const after = ctx.query.after === undefined || ctx.query.after === '' ? null : String(ctx.query.after);
	if (after !== null && !isId(after, 'conv'))
		throw problem('validation_failed', 'after is the next value of the previous finish: a conversation id.');
	/** @type {import('@ss/app-kit').WebsiteData} */
	const data = await ctx.data();
	const websiteId = String(ctx.websiteId);
	const conversations = data.collection('conversations');
	const filter = { websiteId, name: 'conversations', ...(after === null ? {} : { key: { $gt: after } }) };
	const ids = (
		await data
			.collection(LEDGER)
			.find(filter, { projection: { _id: 0, key: 1 } })
			.sort({ key: 1 })
			.limit(FINISH_BATCH)
			.toArray()
	).map((entry) => String(entry.key));
	const found = await conversations.find({ websiteId, id: { $in: ids } }, { projection: { _id: 0 } }).toArray();
	let renumbered = 0;
	let updated = 0;
	for (const conversation of found) {
		const result = await finishOne(data, websiteId, /** @type {any} */ (conversation));
		renumbered += result.renumbered;
		if (result.updated) updated += 1;
	}
	const next = ids.at(-1) ?? null;
	const more =
		next !== null &&
		(await data.collection(LEDGER).countDocuments({ websiteId, name: 'conversations', key: { $gt: next } }, { limit: 1 })) > 0;
	return { conversations: found.length, renumbered, updated, next: more ? next : null, more };
};

/**
 * One conversation: its messages numbered 1..n in time order (ties by id) and its derived fields set, writing only what
 * changes. The numbers move in two steps (first below every number the conversation holds, then into place), so no two
 * messages ever share one (the unique index on the conversation and number).
 * @param {import('@ss/app-kit').WebsiteData} data
 * @param {string} websiteId
 * @param {Record<string, any> & { id: string, lastMessageAt: Date }} conversation
 */
const finishOne = async (data, websiteId, conversation) => {
	const messages = data.collection('messages');
	const facts = /** @type {import('../core/imports.js').MessageFacts[]} */ (
		await messages
			.find(
				{ websiteId, conversationId: conversation.id },
				{ projection: { _id: 0, id: 1, seq: 1, author: 1, internal: 1, createdAt: 1 } },
			)
			.toArray()
	);
	const plan = finishPlan(conversation, facts);
	if (plan.changed.length > 0) {
		const lowest = facts.reduce((min, m) => Math.min(min, m.seq), 0);
		const where = { websiteId, conversationId: conversation.id, id: { $in: plan.changed } };
		const index = { $indexOfArray: [{ $literal: plan.order }, '$id'] };
		await messages.updateMany(where, [{ $set: { seq: { $subtract: [lowest - 1, index] } } }]);
		await messages.updateMany(where, [{ $set: { seq: { $add: [index, 1] } } }]);
	}
	const last =
		plan.lastVisibleId === null
			? null
			: await messages.findOne(
					{ websiteId, id: plan.lastVisibleId },
					{ projection: { _id: 0, text: 1, format: 1, attachment: 1 } },
				);
	const changes = changesOf(conversation, { ...plan.set, preview: last ? previewText(last) : '' });
	if (changes) await data.collection('conversations').updateOne({ websiteId, id: conversation.id }, { $set: changes });
	return { renumbered: plan.changed.length, updated: changes !== null };
};

/**
 * The sums `ss-import verify` compares (`GET /v1/import/status`): conversations, messages, conversations per status and
 * conversations waiting for a person.
 * @param {any} ctx
 */
const totals = async (ctx) => {
	/** @type {import('@ss/app-kit').WebsiteData} */
	const data = await ctx.data();
	const websiteId = String(ctx.websiteId);
	const conversations = data.collection('conversations');
	const rows = await conversations
		.aggregate([{ $match: { websiteId } }, { $group: { _id: '$status', n: { $sum: 1 } } }])
		.toArray();
	/** @type {Record<string, number>} */
	const sums = {
		conversations: rows.reduce((sum, row) => sum + Number(row.n), 0),
		messages: await data.collection('messages').countDocuments({ websiteId }),
	};
	for (const status of STATUSES) sums[`conversations.${status}`] = Number(rows.find((row) => row._id === status)?.n ?? 0);
	sums['conversations.waiting'] = await conversations.countDocuments({ websiteId, waiting: true });
	return sums;
};
