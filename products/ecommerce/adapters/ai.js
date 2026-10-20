/**
 * What Ecommerce asks the website's AI provider (PLAN 0.8.8: AI copy): one system text and one prompt in, the answer's
 * text out. The key is the Portal's (`portal: 'ai'`, entered once for the website: OpenAI, Anthropic, Google Gemini or
 * an OpenAI-compatible service); the call goes through the kit's AI client, so the wire formats, the key check and the
 * connection test are the kit's.
 * @module
 */
import { checkAiConnection, createAiClient } from '@ss/app-kit';

/** How freely the AI writes copy (0 to 2). */
const TEMPERATURE = 0.7;

/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} Send */

/**
 * @param {{ send: Send, policy?: import('@ss/net').OutboundPolicy }} options the product's outbound `send` and policy
 */
export const createAi = ({ send, policy }) => {
	const client = createAiClient({ send, ...(policy ? { policy } : {}) });
	return Object.freeze({
		/** The connection test (the `ai` definition's `test`): the kit's. */
		test: client.test,
		/**
		 * Write text: one completion.
		 * @param {unknown} value the `ai` connection
		 * @param {{ system: string, prompt: string, maxTokens: number }} request
		 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: 'not_connected' | 'rate_limited' | 'provider_error' }>}
		 */
		write: async (value, { system, prompt, maxTokens }) => {
			const checked = checkAiConnection(value);
			if (!checked.ok) return { ok: false, code: 'not_connected' };
			const answer = await client.chat(checked.value, {
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: prompt },
				],
				temperature: TEMPERATURE,
				maxTokens,
			});
			if (!answer.ok) return { ok: false, code: answer.code === 'rate_limited' ? 'rate_limited' : 'provider_error' };
			return answer.value.text === '' ? { ok: false, code: 'provider_error' } : { ok: true, text: answer.value.text };
		},
	});
};

/** @typedef {ReturnType<typeof createAi>} Ai */
