import { describe, expect, it } from 'vitest';
import { NOTE_MAX_LENGTH, checkNote, noteView } from '../core/notes.js';

describe('checkNote', () => {
	it('accepts a note, trims it and keeps the e-mail in lower case', () => {
		expect(checkNote({ text: '  Hello  ', email: ' Sam@Example.com ' }, { maxLength: 500 })).toEqual({
			ok: true,
			value: { text: 'Hello', email: 'sam@example.com' },
		});
		expect(checkNote({ text: 'Hi' }, { maxLength: 500 })).toEqual({ ok: true, value: { text: 'Hi', email: null } });
	});

	it('refuses empty and too long notes and bad e-mail addresses', () => {
		expect(checkNote(null, { maxLength: 500 })).toMatchObject({ ok: false, error: 'empty', field: 'text' });
		expect(checkNote({ text: 'abcdef' }, { maxLength: 5 })).toMatchObject({ ok: false, error: 'too_long', max: 5 });
		expect(checkNote({ text: 'x'.repeat(NOTE_MAX_LENGTH + 1) }, { maxLength: 99_999 })).toMatchObject({
			error: 'too_long',
			max: NOTE_MAX_LENGTH,
		});
		expect(checkNote({ text: 'ok', email: 'nope' }, { maxLength: 500 })).toMatchObject({ error: 'bad_email', field: 'email' });
		expect(checkNote({ text: 'ok', email: `${'a'.repeat(250)}@b.co` }, { maxLength: 500 })).toMatchObject({
			error: 'bad_email',
		});
	});
});

describe('noteView', () => {
	it('answers ISO-8601 UTC times', () => {
		expect(noteView({ id: 'note_1', text: 'Hi', email: null, createdAt: new Date(Date.UTC(2026, 9, 1)) })).toEqual({
			id: 'note_1',
			text: 'Hi',
			email: null,
			createdAt: '2026-10-01T00:00:00.000Z',
		});
	});
});
