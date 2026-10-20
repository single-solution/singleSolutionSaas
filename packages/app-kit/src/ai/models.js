/**
 * The AI providers and the shape of an AI key (PLAN 0.8.3 AI): OpenAI, Anthropic and Google Gemini built in, plus any
 * OpenAI-compatible service (base URL + key). The model is free text; the suggestions are kept in code (models are never
 * fetched live). Pure, so a dashboard form can use it in the browser too (`@ss/app-kit/ai`).
 *
 * `checkAiConnection` accepts exactly what the Portal accepts for the website's AI key (the Portal's
 * `checkAiValue`): `{ provider, apiKey, model }` and, for a `compatible` service, its public https `baseUrl`; nothing else.
 * @module
 */
import { AI_PROVIDERS } from '@ss/contracts';

export { AI_PROVIDERS };

/** @typedef {import('@ss/contracts').AiProvider} AiProvider */

/** Suggested models per provider (free text is allowed). */
export const MODEL_SUGGESTIONS = Object.freeze({
	openai: Object.freeze(['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o']),
	anthropic: Object.freeze(['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1']),
	google: Object.freeze(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']),
	compatible: Object.freeze([]),
});

/** The address of each built-in provider's API (a compatible service gives its own base URL). */
export const PROVIDER_BASE = Object.freeze({
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com/v1',
	google: 'https://generativelanguage.googleapis.com/v1beta',
});

/**
 * @typedef {object} AiConnection
 * @property {AiProvider} provider
 * @property {string} apiKey
 * @property {string} model
 * @property {string} [baseUrl] only for `compatible`: a public https address
 */

/** An AI model name: letters, digits and `_.:/@-`. */
const MODEL = /^[\w./:@-]{1,120}$/;
/** The shortest and the longest AI key. */
const KEY_MIN = 8;
const KEY_MAX = 512;
/** The longest base URL. */
const URL_MAX = 2048;
const SETTINGS = ['provider', 'apiKey', 'model', 'baseUrl'];

/**
 * Whether a text is an https address with a host and no sign-in part (the form of a base URL; whether the host is public
 * is the outbound policy's to say).
 * @param {string} text
 */
const isHttps = (text) => {
	try {
		const url = new URL(text);
		return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
	} catch {
		return false;
	}
};

/**
 * Check an AI key value: a dashboard form's, a Portal delivery or a saved one. The key, the model and the base URL are
 * trimmed, and the base URL loses its trailing slashes. The message never repeats the key.
 * @param {unknown} value
 * @param {(url: string) => boolean} [isPublic] whether a `compatible` service's address is allowed by the outbound policy
 *   (the server passes it; a form in the browser leaves it out and the server checks again)
 * @returns {{ ok: true, value: AiConnection } | { ok: false, message: string, field?: string }}
 */
export const checkAiConnection = (value, isPublic) => {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return { ok: false, message: 'Enter the AI provider key.' };
	const input = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(input))
		if (!SETTINGS.includes(key)) return { ok: false, message: `${key} is not an AI provider setting.`, field: key };
	const provider = input.provider;
	if (typeof provider !== 'string' || !(/** @type {readonly string[]} */ (AI_PROVIDERS).includes(provider)))
		return { ok: false, message: 'Pick a provider.', field: 'provider' };
	const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
	if (apiKey.length < KEY_MIN) return { ok: false, message: 'Enter the API key.', field: 'apiKey' };
	if (apiKey.length > KEY_MAX) return { ok: false, message: 'The API key is too long.', field: 'apiKey' };
	const model = typeof input.model === 'string' ? input.model.trim() : '';
	if (!MODEL.test(model)) return { ok: false, message: 'Enter the model.', field: 'model' };
	if (input.baseUrl !== undefined && typeof input.baseUrl !== 'string')
		return { ok: false, message: 'The base URL is an https address.', field: 'baseUrl' };
	const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
	const named = /** @type {AiProvider} */ (provider);
	if (named !== 'compatible') {
		if (baseUrl !== '') return { ok: false, message: 'Only a compatible service has a base URL.', field: 'baseUrl' };
		return { ok: true, value: { provider: named, apiKey, model } };
	}
	if (!isHttps(baseUrl) || baseUrl.length > URL_MAX || /[?#]/.test(baseUrl) || (isPublic && !isPublic(baseUrl)))
		return { ok: false, message: 'Enter the public https base URL of the service.', field: 'baseUrl' };
	return { ok: true, value: { provider: named, apiKey, model, baseUrl: baseUrl.replace(/\/+$/, '') } };
};
