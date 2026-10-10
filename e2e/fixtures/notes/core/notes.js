/**
 * The notes feature's pure logic: checking a visitor's note and the note as the API answers it. No I/O, no DOM: the
 * API and the widgets share it.
 * @module
 */

/** Hard maximum of the `maxLength` setting (a limit is a setting within a maximum fixed in code, PLAN 0.4.2). */
export const NOTE_MAX_LENGTH = 2000;
/** Longest e-mail address kept with a note. */
export const EMAIL_MAX_LENGTH = 254;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @typedef {{ text: string, email: string | null }} NoteInput */
/** @typedef {'empty' | 'too_long' | 'bad_email'} NoteError */
/** @typedef {{ id: string, text: string, email: string | null, createdAt: Date | string }} NoteRecord */

/**
 * Check a note a visitor sends: text required and at most `maxLength` characters (never above
 * {@link NOTE_MAX_LENGTH}); e-mail optional.
 * @param {unknown} input
 * @param {{ maxLength: number }} settings
 * @returns {{ ok: true, value: NoteInput } | { ok: false, error: NoteError, field: 'text' | 'email', max: number }}
 */
export const checkNote = (input, { maxLength }) => {
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	const max = Math.min(maxLength, NOTE_MAX_LENGTH);
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (text.length === 0) return { ok: false, error: 'empty', field: 'text', max };
	if (text.length > max) return { ok: false, error: 'too_long', field: 'text', max };
	const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
	if (rawEmail.length > 0 && (rawEmail.length > EMAIL_MAX_LENGTH || !EMAIL.test(rawEmail)))
		return { ok: false, error: 'bad_email', field: 'email', max };
	return { ok: true, value: { text, email: rawEmail.length > 0 ? rawEmail.toLowerCase() : null } };
};

/**
 * The note as the API answers it (ISO-8601 UTC time).
 * @param {NoteRecord} note
 * @returns {{ id: string, text: string, email: string | null, createdAt: string }}
 */
export const noteView = ({ id, text, email, createdAt }) => ({
	id,
	text,
	email,
	createdAt: new Date(createdAt).toISOString(),
});

/**
 * Check a note an import sends (PLAN 0.8.10 K10, import mode): the given id, the text within the hard maximum, an
 * optional e-mail and a past time.
 * @param {Record<string, unknown>} record
 * @returns {{ ok: true, value: { id: string, text: string, email: string | null, createdAt: Date } }
 *   | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkImportedNote = (record) => {
	const checked = checkNote(record, { maxLength: NOTE_MAX_LENGTH });
	if (!checked.ok)
		return { ok: false, errors: [{ path: `/${checked.field}`, message: `${checked.field} is not valid (${checked.error})` }] };
	const createdAt = typeof record.createdAt === 'string' ? new Date(record.createdAt) : null;
	if (!createdAt || Number.isNaN(createdAt.getTime()))
		return { ok: false, errors: [{ path: '/createdAt', message: 'createdAt is an ISO-8601 time' }] };
	return { ok: true, value: { id: String(record.id), ...checked.value, createdAt } };
};
