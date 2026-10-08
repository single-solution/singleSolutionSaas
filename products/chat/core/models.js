/**
 * AI providers and model suggestions (PLAN 0.8.3 AI): OpenAI, Anthropic and Google Gemini built in, plus any
 * OpenAI-compatible service (base URL + key). The model is free text; these lists are only suggestions kept in code
 * (models are never fetched live).
 * @module
 */

/** Providers a Chat AI connection may name. */
export const AI_PROVIDERS = Object.freeze(/** @type {const} */ (['openai', 'anthropic', 'google', 'compatible']));

/** @typedef {(typeof AI_PROVIDERS)[number]} AiProvider */

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
 * @property {string} [baseUrl] only for `compatible`: an https address
 */

/**
 * Check an AI connection value (the dashboard's form sends it as one connection).
 * @param {unknown} value
 * @returns {{ ok: true, value: AiConnection } | { ok: false, message: string }}
 */
export const checkAiConnection = (value) => {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return { ok: false, message: 'Pick a provider and enter the key and the model.' };
	const v = /** @type {Record<string, unknown>} */ (value);
	if (!AI_PROVIDERS.includes(/** @type {any} */ (v.provider))) return { ok: false, message: 'Pick a provider.' };
	if (typeof v.apiKey !== 'string' || v.apiKey.trim().length < 8) return { ok: false, message: 'Enter the API key.' };
	if (typeof v.model !== 'string' || !/^[\w./:@-]{1,120}$/.test(v.model.trim()))
		return { ok: false, message: 'Enter the model.' };
	const provider = /** @type {AiProvider} */ (v.provider);
	if (provider === 'compatible') {
		if (typeof v.baseUrl !== 'string' || !/^https:\/\/[^\s/]+(\/\S*)?$/.test(v.baseUrl.trim()))
			return { ok: false, message: 'Enter the https base URL of the service.' };
		return {
			ok: true,
			value: { provider, apiKey: v.apiKey.trim(), model: v.model.trim(), baseUrl: v.baseUrl.trim().replace(/\/+$/, '') },
		};
	}
	return { ok: true, value: { provider, apiKey: v.apiKey.trim(), model: v.model.trim() } };
};
