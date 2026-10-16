/**
 * The problem code of a refused call, the one place both the shop widgets and the admin widgets read it.
 * @module
 */

/**
 * The problem code of an answer: the last segment of its problem type, `offline` when the call could not reach the
 * website (status 0), else ''.
 * @param {{ status?: number, data: any }} answer
 * @returns {string}
 */
export const codeOf = (answer) => {
	if (answer.status === 0) return 'offline';
	const type = answer.data?.type;
	return typeof type === 'string' ? type.slice(type.lastIndexOf('/') + 1) : '';
};
