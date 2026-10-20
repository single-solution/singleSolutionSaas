/**
 * The pure part of the shared AI client (`@ss/app-kit/ai`): the providers, the model suggestions, the check of an AI key
 * value and the token estimate. No network and no server module, so a dashboard form can use it in the browser and
 * core logic can use it as it is. `createAiClient` (the calls) is in the kit's main export.
 * @module
 */
export { AI_PROVIDERS, MODEL_SUGGESTIONS, checkAiConnection } from './models.js';
export { estimateTokens } from './wire.js';

/** @typedef {import('./models.js').AiConnection} AiConnection */
/** @typedef {import('./models.js').AiProvider} AiProvider */
/** @typedef {import('./wire.js').AiMessage} AiMessage */
/** @typedef {import('./wire.js').AiToolSchema} AiToolSchema */
/** @typedef {import('./wire.js').AiToolCall} AiToolCall */
/** @typedef {import('./wire.js').AiResult} AiResult */
