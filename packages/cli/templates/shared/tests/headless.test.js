import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNotes } from '../headless/notes.js';
import { createMemoryClient } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));

describe('headless/notes', () => {
	it('loads, adds, pins and removes notes through the Mode C client', async () => {
		const client = createMemoryClient();
		/** @type {Array<[string, unknown]>} */
		const events = [];
		const notes = createNotes({ config: { max_notes: 2 }, strings, client, emit: (name, data) => events.push([name, data]) });
		/** @type {string[]} */
		const seen = [];
		const unsubscribe = notes.subscribe((state) => seen.push(state.status));

		await notes.actions.load();
		assert.equal(notes.state().status, 'ready');

		await notes.actions.setDraft('first');
		const added = await notes.actions.add();
		assert.equal(added.ok, true);
		assert.equal(notes.state().draft, '');
		assert.equal(notes.state().notes.length, 1);

		const id = notes.state().notes[0]?.id ?? '';
		await notes.actions.togglePin(id);
		assert.equal(notes.state().notes[0]?.pinned, true);

		await notes.actions.setDraft('second');
		await notes.actions.add();
		assert.equal(notes.state().canAdd, false);
		await notes.actions.setDraft('third');
		const refused = await notes.actions.add();
		assert.equal(refused.ok, false);
		assert.equal(notes.state().error, 'You have reached the limit of 2 notes.');

		await notes.actions.remove(id);
		assert.equal(notes.state().notes.length, 1);
		assert.deepEqual(
			events.map(([name]) => name),
			['notes.added', 'notes.added', 'notes.removed'],
		);
		assert.ok(seen.includes('loading'));
		unsubscribe();
		notes.destroy();
	});

	it('validates with resolved messages and surfaces client problems', async () => {
		const client = {
			...createMemoryClient(),
			list: async () => ({ ok: /** @type {const} */ (false), problem: { code: 'forbidden', status: 403 } }),
		};
		const notes = createNotes({ config: { max_length: 3 }, strings, client });
		assert.deepEqual(notes.validate({ text: 'long' }), [
			{ path: '/text', code: 'text_too_long', message: 'Notes can have at most 3 characters.' },
		]);
		const empty = await notes.actions.add();
		assert.equal(empty.ok, false);
		assert.equal(notes.state().error, 'Please write something first.');
		await notes.actions.load();
		assert.equal(notes.state().status, 'error');
		assert.equal(notes.state().error, 'Something went wrong. Please try again.');
		assert.equal((await notes.actions.togglePin('missing')).ok, false);
	});
});
