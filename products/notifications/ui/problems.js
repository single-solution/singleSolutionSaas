/**
 * The words of a refused admin call and of a message that was not sent (PLAN 0.4.10: every word a widget shows is
 * editable in Settings → Texts). A problem's `detail` is the server's English, so the admin widgets never show it: they
 * show the website's text for the field a refused form names (`problem.field.<field>`), else for the problem code
 * (`problem.<code>`; `problem.offline` when Notifications cannot be reached), else `problem.failed`.
 * @module
 */

/** Reasons a message is skipped (`reason.<reason>`); any other reason is a provider's error. */
const SKIP_REASONS = Object.freeze(['unsubscribed', 'limited']);

/**
 * The problem code of an answer that is not ok: the last segment of its problem type, `offline` when nothing
 * answered, else ''.
 * @param {{ status: number, data: any }} answer an `adminCall` answer
 * @returns {string}
 */
export const codeOf = (answer) => {
	if (answer.status === 0) return 'offline';
	const type = answer.data?.type;
	return typeof type === 'string' ? type.slice(type.lastIndexOf('/') + 1) : '';
};

/**
 * The website's words for a refused admin call.
 * @param {Readonly<Record<string, string>>} texts the widget texts
 * @param {{ status: number, data: any }} answer an `adminCall` answer that is not ok
 * @returns {string}
 */
export const problemText = (texts, answer) => {
	const code = codeOf(answer);
	const path = code === 'validation_failed' ? answer.data?.errors?.[0]?.path : undefined;
	const field = typeof path === 'string' ? path.split('/')[1] : undefined;
	const key = [...(field ? [`problem.field.${field}`] : []), `problem.${code}`].find((name) => Object.hasOwn(texts, name));
	return texts[key ?? 'problem.failed'] ?? '';
};

/**
 * Why a message was not sent, in the website's words: an unsubscribe or a send limit for a skipped one, else every
 * attempt failed (the delivery log shows each attempt's error).
 * @param {Readonly<Record<string, string>>} texts the widget texts
 * @param {{ status: string, reason?: string | null }} message
 * @returns {string}
 */
export const notSentText = (texts, message) =>
	texts[
		message.status === 'skipped' && SKIP_REASONS.includes(String(message.reason)) ? `reason.${message.reason}` : 'reason.failed'
	] ?? '';

/**
 * The reason the delivery log shows: the website's words for a skip, else the provider's error as it came ('' for
 * none).
 * @param {Readonly<Record<string, string>>} texts the widget texts
 * @param {{ reason: string | null }} message
 * @returns {string}
 */
export const logReason = (texts, message) =>
	message.reason !== null && SKIP_REASONS.includes(message.reason)
		? (texts[`reason.${message.reason}`] ?? message.reason)
		: (message.reason ?? '');
