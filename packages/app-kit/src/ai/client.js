/**
 * The one AI client of the products (PLAN 0.8.3 AI): it calls OpenAI, Anthropic, Google Gemini or any OpenAI-compatible
 * service directly with the website's AI key (the Portal's, `portal: 'ai'`, or a product's own backup key of the same
 * shape), through the product's outbound `send` (`@ss/net` `safeFetch` under its outbound policy: no redirects, a
 * deadline, a body cap). Requests are built and answers parsed by ./wire.js. A key is tested with a read-only call (the
 * provider's model list).
 * @module
 */
import { checkUrl, createOutboundPolicy, jsonOf } from '@ss/net';
import { PROVIDER_BASE, checkAiConnection } from './models.js';
import { WIRE } from './wire.js';

/** Deadline of one AI call (ms). */
const AI_TIMEOUT_MS = 25_000;
/** Deadline of the connection test (ms). */
const TEST_TIMEOUT_MS = 10_000;

/** @typedef {import('./models.js').AiConnection} AiConnection */
/** @typedef {import('./wire.js').AiMessage} AiMessage */
/** @typedef {import('./wire.js').AiToolSchema} AiToolSchema */
/** @typedef {import('./wire.js').AiResult} AiResult */
/** @typedef {import('../connections.js').OutboundSend} OutboundSend */

/**
 * The base address and the authentication headers of a connection.
 * @param {AiConnection} connection
 * @returns {{ base: string, headers: Record<string, string> }}
 */
export const endpointOf = (connection) => {
	if (connection.provider === 'anthropic')
		return { base: PROVIDER_BASE.anthropic, headers: { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01' } };
	if (connection.provider === 'google') return { base: PROVIDER_BASE.google, headers: { 'x-goog-api-key': connection.apiKey } };
	return {
		base: connection.provider === 'compatible' ? /** @type {string} */ (connection.baseUrl) : PROVIDER_BASE.openai,
		headers: { authorization: `Bearer ${connection.apiKey}` },
	};
};

/**
 * @param {{ send: OutboundSend, policy?: import('@ss/net').OutboundPolicy }} options the product's outbound `send` and its
 *   policy (default: public https only), which vets a compatible service's address when a key is tested
 */
export const createAiClient = ({ send, policy = createOutboundPolicy() }) =>
	Object.freeze({
		/**
		 * One completion. `connection` is a checked key value (`checkAiConnection`).
		 * @param {AiConnection} connection
		 * @param {{ messages: AiMessage[], tools?: AiToolSchema[], temperature: number, maxTokens: number }} request
		 * @returns {Promise<{ ok: true, value: AiResult } | { ok: false, code: string }>} `rate_limited` or `provider_error`
		 */
		chat: async (connection, request) => {
			const wire = WIRE[connection.provider];
			const built = wire.build({ model: connection.model, ...request });
			const { base, headers } = endpointOf(connection);
			try {
				const response = await send(`${base}${built.path}`, {
					method: 'POST',
					headers: { ...headers, 'content-type': 'application/json' },
					body: JSON.stringify(built.body),
					redirect: 'error',
					timeoutMs: AI_TIMEOUT_MS,
					maxBytes: 2 * 1024 * 1024,
				});
				if (response.status < 200 || response.status > 299)
					return { ok: false, code: response.status === 429 ? 'rate_limited' : 'provider_error' };
				return { ok: true, value: wire.parse(jsonOf(response)) };
			} catch {
				return { ok: false, code: 'provider_error' };
			}
		},
		/**
		 * The connection test (a definition's `test`): the value's shape, then a read-only call to the provider's model list.
		 * @param {unknown} value
		 * @returns {Promise<{ ok: boolean, message?: string }>}
		 */
		test: async (value) => {
			const checked = checkAiConnection(value, (url) => checkUrl(url, policy).ok);
			if (!checked.ok) return { ok: false, message: checked.message };
			const { base, headers } = endpointOf(checked.value);
			try {
				const response = await send(`${base}/models`, { headers, redirect: 'error', timeoutMs: TEST_TIMEOUT_MS });
				if (response.status === 401 || response.status === 403)
					return { ok: false, message: 'The provider refused the key.' };
				if (response.status < 200 || response.status > 299)
					return { ok: false, message: `The provider answered ${response.status}.` };
				return { ok: true };
			} catch {
				return { ok: false, message: 'The provider cannot be reached.' };
			}
		},
	});

/** @typedef {ReturnType<typeof createAiClient>} AiClient */
