import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DELETED_RETENTION_MS, NOTES_INDEXES, createNotesRepository } from '../adapters/db.js';
import { createEventHandlers } from '../api/events.js';
import { createNotesHandlers } from '../api/notes.js';
import { sessionView } from '../api/session.js';
import { createMemoryCollection } from './memory-collection.js';

const setup = () => {
	const collection = createMemoryCollection();
	/** @type {Map<string, ReturnType<typeof createNotesRepository>>} */
	const repos = new Map();
	/** @param {string} websiteId */
	const repoFor = async (websiteId) => {
		if (!repos.has(websiteId)) repos.set(websiteId, createNotesRepository(collection, websiteId));
		return /** @type {ReturnType<typeof createNotesRepository>} */ (repos.get(websiteId));
	};
	/** @type {unknown[]} */
	const published = [];
	/** @type {unknown[]} */
	const usage = [];
	let clock = Date.parse('2026-10-01T00:00:00Z');
	let counter = 0;
	const handlers = createNotesHandlers({
		repoFor,
		publish: async (event) => published.push(event),
		recordUsage: (entry) => usage.push(entry),
		now: () => (clock += 1000),
		random: () => `r${(counter += 1)}`,
	});
	return { collection, repoFor, handlers, published, usage };
};

describe('api/notes', () => {
	it('creates, pages, updates and soft-deletes notes of one website', async () => {
		const { handlers, repoFor, published, usage } = setup();
		for (const text of ['a', 'b', 'c']) {
			const result = await handlers.create({ websiteId: 'web_1', body: { text }, idempotencyKey: `key-${text}` });
			assert.equal(result.kind === 'ok' && result.status, 201);
		}
		assert.equal(published.length, 3);
		assert.equal(usage.length, 3);

		const repo = await repoFor('web_1');
		const first = await repo.list({ fetchLimit: 3 });
		assert.deepEqual(
			first.map((note) => note.text),
			['c', 'b', 'a'],
		);
		const next = await repo.list({ after: first[1]?.id, fetchLimit: 3 });
		assert.deepEqual(
			next.map((note) => note.text),
			['a'],
		);
		assert.equal((await (await repoFor('web_2')).list({ fetchLimit: 3 })).length, 0);

		const id = first[0]?.id ?? '';
		const updated = /** @type {any} */ (await handlers.update({ websiteId: 'web_1', params: { id }, body: { pinned: true } }));
		assert.equal(updated.body.pinned, true);
		assert.equal((await handlers.get({ websiteId: 'web_2', params: { id } })).kind, 'problem');
		assert.equal((await handlers.get({ websiteId: 'web_1', params: { id } })).kind, 'ok');
		assert.equal((await handlers.remove({ websiteId: 'web_1', params: { id } })).kind, 'ok');
		assert.equal((await handlers.get({ websiteId: 'web_1', params: { id } })).kind, 'problem');
		assert.equal((await handlers.remove({ websiteId: 'web_1', params: { id } })).kind, 'problem');
	});

	it('rejects invalid input and enforces the max_notes limit from the entitlement config', async () => {
		const { handlers } = setup();
		const config = { max_notes: 1 };
		const invalid = /** @type {any} */ (await handlers.create({ websiteId: 'web_1', config, body: { text: '' } }));
		assert.equal(invalid.code, 'validation_failed');
		assert.equal((await handlers.create({ websiteId: 'web_1', config, body: { text: 'one' } })).kind, 'ok');
		const limited = /** @type {any} */ (await handlers.create({ websiteId: 'web_1', config, body: { text: 'two' } }));
		assert.equal(limited.code, 'conflict');
		const badPatch = /** @type {any} */ (
			await handlers.update({ websiteId: 'web_1', params: { id: 'x' }, body: { pinned: 'no' } })
		);
		assert.equal(badPatch.code, 'validation_failed');
		assert.equal(
			/** @type {any} */ (await handlers.update({ websiteId: 'web_1', params: { id: 'x' }, body: {} })).code,
			'not_found',
		);
	});
});

describe('api/events', () => {
	it('consumes order.placed idempotently (one note per event id)', async () => {
		const { repoFor, collection } = setup();
		const handlers = createEventHandlers({ repoFor, now: () => 0, random: () => 'x' });
		const event = { id: 'evt_1', websiteId: 'web_1', data: { orderId: 'ord_1', number: '1001', lines: [{}] } };
		await handlers['order.placed@1']?.(event);
		await handlers['order.placed@1']?.(event);
		assert.equal(await collection.countDocuments({ websiteId: 'web_1', sourceEventId: 'evt_1' }), 1);
	});

	it('the repository refuses queries without websiteId (guarded collection)', async () => {
		const { collection } = setup();
		await assert.rejects(() => collection.find({}).toArray(), { code: 'data_guard' });
	});
});

describe('api/session + jobs', () => {
	it('describes dashboard sessions', () => {
		assert.deepEqual(sessionView({ kind: 'merchant', role: 'owner', scope: { merchantId: 'mer_1' }, user: { id: 'u1' } }), {
			kind: 'merchant',
			role: 'owner',
			scope: { merchantId: 'mer_1' },
			user: 'u1',
		});
		assert.equal(sessionView({ kind: 'admin', role: 'support', subject: 'stf_1' }).user, 'stf_1');
	});

	it('marks soft-deleted notes for removal by a TTL index (no job)', async () => {
		const { handlers, collection } = setup();
		const created = /** @type {any} */ (await handlers.create({ websiteId: 'web_1', body: { text: 'old' } }));
		await handlers.remove({ websiteId: 'web_1', params: { id: created.body.id } });
		const doc = collection.docs.find((d) => d.id === created.body.id);
		assert.ok(doc?.purgeAt instanceof Date);
		assert.equal(doc.purgeAt.getTime(), Date.parse(doc.deletedAt) + DELETED_RETENTION_MS);
		assert.deepEqual(
			NOTES_INDEXES.find((index) => index.name === 'purge_ttl'),
			{ key: { purgeAt: 1 }, name: 'purge_ttl', expireAfterSeconds: 0 },
		);
	});
});
