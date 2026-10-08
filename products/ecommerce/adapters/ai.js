/**
 * The merchant's AI provider for AI copy (owner: catalog; stub until built), called through `@ss/net`.
 * @module
 */

/**
 * @param {{ send: (url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse> }} options
 */
export const createAi = ({ send }) =>
	Object.freeze({
		send,
		/**
		 * The connection test (read-only).
		 * @param {unknown} value
		 * @returns {Promise<{ ok: boolean, message?: string }>}
		 */
		test: async (value) => (value ? { ok: true } : { ok: false, message: 'The AI key is missing.' }),
	});

/** @typedef {ReturnType<typeof createAi>} Ai */
