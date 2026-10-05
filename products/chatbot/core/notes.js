/**
 * Internal notes (pure): agents' notes on a conversation are messages with `internal: true` — stored with the
 * conversation's messages, shown to the team only, never sent to the customer, the AI or customer transcripts.
 * @module
 */

/** Longest internal note (characters). */
export const NOTE_MAX_LENGTH = 8000;

/**
 * Validate a note body `{ text, mentions? }`.
 * @param {unknown} body
 * @returns {Array<{ path: string, code: string }>}
 */
export const validateNote = (body) => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ path: '', code: 'object_required' }];
	const b = /** @type {Record<string, unknown>} */ (body);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	if (typeof b.text !== 'string' || !b.text.trim()) problems.push({ path: '/text', code: 'required' });
	else if ([...b.text].length > NOTE_MAX_LENGTH) problems.push({ path: '/text', code: 'too_long' });
	if (
		b.mentions !== undefined &&
		(!Array.isArray(b.mentions) || b.mentions.length > 20 || b.mentions.some((m) => typeof m !== 'string' || m.length > 64))
	)
		problems.push({ path: '/mentions', code: 'invalid' });
	for (const key of Object.keys(b))
		if (!['text', 'mentions'].includes(key)) problems.push({ path: `/${key}`, code: 'unknown_field' });
	return problems;
};

/**
 * Agents mentioned in a note: explicit ids plus `@agent_id` tokens in the text.
 * @param {{ text: string, mentions?: string[] }} note
 * @param {readonly string[]} agentIds
 */
export const mentionsOf = (note, agentIds) =>
	[...new Set([...(note.mentions ?? []), ...[...note.text.matchAll(/@([A-Za-z0-9_-]{2,64})/g)].map((m) => m[1] ?? '')])].filter(
		(id) => agentIds.includes(id),
	);
