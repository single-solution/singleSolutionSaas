/**
 * Transcripts and retention (pure): the retention instant moved forward with every write (the TTL index deletes
 * conversations and messages once it passes) and transcript rendering as JSON or plain text.
 * @module
 */
import { DAY_MS } from './time.js';

/**
 * @param {number} now
 * @param {number} days
 */
export const retainUntil = (now, days) => new Date(now + Math.max(1, days) * DAY_MS);

/**
 * @typedef {{ author: string, authorName: string | null, text: string, at: string, internal?: boolean, kind: string }} TranscriptMessage
 */

/**
 * Plain-text transcript.
 * @param {{ conversation: { id: string, openedAt: string, closedAt: string | null, status: string }, messages: TranscriptMessage[],
 *   labels: Record<string, string>, includeInternal: boolean, title: string }} input
 */
export const transcriptText = ({ conversation, messages, labels, includeInternal, title }) => {
	const lines = [
		title,
		`${conversation.id} · ${conversation.openedAt}${conversation.closedAt ? ` → ${conversation.closedAt}` : ''}`,
		'',
	];
	for (const m of messages) {
		if (m.internal && !includeInternal) continue;
		if (m.kind === 'event') {
			lines.push(`[${m.at}] — ${m.text}`);
			continue;
		}
		const who = m.authorName || labels[m.author] || m.author;
		lines.push(`[${m.at}] ${m.internal ? `(${labels.note ?? 'note'}) ` : ''}${who}: ${m.text}`);
	}
	return `${lines.join('\n')}\n`;
};

/**
 * JSON transcript (customer exports never contain internal notes or agent ids).
 * @param {{ conversation: Record<string, unknown>, messages: Array<Record<string, unknown>>, exportedAt: string }} input
 */
export const transcriptJson = ({ conversation, messages, exportedAt }) => ({
	format: 'ss-chatbot-transcript@1',
	exportedAt,
	conversation,
	messages,
});
