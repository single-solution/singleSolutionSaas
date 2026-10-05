import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
	applyPatch,
	canAddNote,
	createNote,
	newNoteId,
	noteFromOrder,
	pageSize,
	resolveConfig,
	sortNotes,
	toPublic,
	validateNoteInput,
} from '../core/notes.js';

describe('core/notes', () => {
	it('resolves config over defaults and ignores mistyped values', () => {
		assert.deepEqual(resolveConfig({ max_notes: 3, max_length: 'x', show_timestamps: false }), {
			max_notes: 3,
			max_length: 500,
			show_timestamps: false,
		});
	});

	it('validates create and patch payloads', () => {
		const config = resolveConfig({ max_length: 5 });
		assert.deepEqual(validateNoteInput({ text: 'hi' }, config), []);
		assert.deepEqual(validateNoteInput({}, config), [{ path: '/text', code: 'text_required' }]);
		assert.deepEqual(validateNoteInput({ text: '   ' }, config), [{ path: '/text', code: 'text_required' }]);
		assert.deepEqual(validateNoteInput({ text: 'too long' }, config), [{ path: '/text', code: 'text_too_long' }]);
		assert.deepEqual(validateNoteInput({ text: 1 }, config), [{ path: '/text', code: 'text_invalid' }]);
		assert.deepEqual(validateNoteInput({ pinned: true }, config, { partial: true }), []);
		assert.deepEqual(validateNoteInput({ pinned: 'yes', extra: 1 }, config, { partial: true }), [
			{ path: '/extra', code: 'unknown_field' },
			{ path: '/pinned', code: 'pinned_invalid' },
		]);
		assert.deepEqual(validateNoteInput(null), [{ path: '', code: 'text_invalid' }]);
	});

	it('enforces the max_notes limit', () => {
		assert.equal(canAddNote(1, resolveConfig({ max_notes: 2 })), true);
		assert.equal(canAddNote(2, resolveConfig({ max_notes: 2 })), false);
	});

	it('creates, patches and exposes notes deterministically', () => {
		const id = newNoteId(0, 'AB-c1');
		assert.equal(id, 'note_000000000abc1');
		const note = createNote({ input: { text: ' hello ' }, websiteId: 'web_1', id, nowMs: 0 });
		assert.equal(note.text, 'hello');
		assert.equal(note.websiteId, 'web_1');
		const patched = applyPatch(note, { pinned: true }, 1000);
		assert.equal(patched.pinned, true);
		assert.equal(patched.updatedAt, '1970-01-01T00:00:01.000Z');
		assert.deepEqual(Object.keys(toPublic(patched)), ['id', 'text', 'pinned', 'createdAt', 'updatedAt']);
	});

	it('sorts pinned first then newest first, and clamps page sizes', () => {
		const sorted = sortNotes([
			{ id: 'note_a', pinned: false },
			{ id: 'note_c', pinned: false },
			{ id: 'note_b', pinned: true },
		]);
		assert.deepEqual(
			sorted.map((note) => note.id),
			['note_b', 'note_c', 'note_a'],
		);
		assert.equal(pageSize('5'), 5);
		assert.equal(pageSize(1000), 100);
		assert.equal(pageSize('nope'), 20);
	});

	it('describes orders from order.placed@1 data', () => {
		assert.equal(noteFromOrder({ orderId: 'ord_1', number: '1001', lines: [{}] }), 'Order 1001 placed (1 line)');
		assert.equal(noteFromOrder({ orderId: 'ord_1' }), 'Order ord_1 placed (0 lines)');
	});
});
