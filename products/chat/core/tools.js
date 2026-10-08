/**
 * Tools the AI may call (pure), from the ibrahimMobiles assistant tools and their security model: the model only
 * fills public inputs (a webhook tool's declared parameters, a date range, a slot id); who the visitor is comes from the
 * verified conversation, never from the model. `escalate_to_human` belongs to handoff. Webhook tools and the book-a-slot
 * tool are signed POSTs to the merchant's own https endpoints (adapters/tools.js); the timeout and the answer size cap
 * are code constants, the same for every tool.
 * @module
 */

/** Built-in tool names. */
export const BUILTIN = Object.freeze({
	escalate: 'escalate_to_human',
	slots: 'list_free_slots',
	book: 'book_slot',
});

/** The header carrying the signature of every tool and booking call: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const TOOL_SIGNATURE_HEADER = 'ss-chat-signature';

/** Call timeout of every tool and booking call (ms). */
export const TOOL_TIMEOUT_MS = 8000;

/** Largest tool answer kept for the AI (characters). */
export const TOOL_OUTPUT_MAX = 4000;

/** Largest tool answer read from the merchant's endpoint (bytes). */
export const TOOL_RESPONSE_MAX_BYTES = 64 * 1024;

/** Most tools a website defines. */
export const MAX_TOOLS = 20;

/** Most parameters of one tool. */
export const MAX_TOOL_PARAMETERS = 10;

const TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/;
const PARAMETER_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const PARAMETER_TYPES = Object.freeze(['string', 'number', 'boolean']);

/**
 * @typedef {object} ToolParameter
 * @property {string} name
 * @property {'string' | 'number' | 'boolean'} type
 * @property {string} description
 * @property {boolean} required
 */
/**
 * @typedef {object} WebhookTool
 * @property {string} name
 * @property {string} description
 * @property {string} url https
 * @property {ToolParameter[]} parameters
 * @property {boolean} includeVisitor send the signed-in visitor's id and e-mail with each call
 */
/** @typedef {import('./providers.js').ToolSchema} ToolSchema */

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @param {number} max */
const text = (value, max) => (typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null);

/** @param {unknown} value */
export const isHttpsUrl = (value) =>
	typeof value === 'string' && value.length <= 500 && /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(value);

/**
 * Check the list of webhook tools a merchant saves (Settings → Tools).
 * @param {unknown} items
 * @returns {{ ok: true, value: WebhookTool[] } | { ok: false, errors: string[] }}
 */
export const checkTools = (items) => {
	if (!Array.isArray(items) || items.length > MAX_TOOLS) return { ok: false, errors: [`Up to ${MAX_TOOLS} tools.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {WebhookTool[]} */
	const value = [];
	const names = new Set();
	items.forEach((item, index) => {
		const at = `Tool ${index + 1}`;
		if (!isObject(item)) return void errors.push(`${at}: not a tool.`);
		const name = typeof item.name === 'string' && TOOL_NAME.test(item.name) ? item.name : null;
		if (!name || Object.values(BUILTIN).includes(name) || names.has(name))
			return void errors.push(`${at}: the name is 2–41 lower-case letters, digits or _, unique and not a built-in tool.`);
		names.add(name);
		const description = text(item.description, 500);
		if (!description) errors.push(`${at}: describe what the tool does (up to 500 characters).`);
		if (!isHttpsUrl(item.url)) errors.push(`${at}: the address must be an https URL.`);
		const raw = Array.isArray(item.parameters) ? item.parameters : [];
		if (raw.length > MAX_TOOL_PARAMETERS) errors.push(`${at}: up to ${MAX_TOOL_PARAMETERS} parameters.`);
		/** @type {ToolParameter[]} */
		const parameters = [];
		const seen = new Set();
		for (const parameter of raw.slice(0, MAX_TOOL_PARAMETERS)) {
			const ok =
				isObject(parameter) &&
				typeof parameter.name === 'string' &&
				PARAMETER_NAME.test(parameter.name) &&
				!seen.has(parameter.name) &&
				PARAMETER_TYPES.includes(/** @type {string} */ (parameter.type));
			if (!ok) {
				errors.push(`${at}: each parameter has a unique name and a type (string, number or boolean).`);
				continue;
			}
			seen.add(parameter.name);
			parameters.push({
				name: /** @type {string} */ (parameter.name),
				type: /** @type {ToolParameter['type']} */ (parameter.type),
				description: typeof parameter.description === 'string' ? parameter.description.slice(0, 300) : '',
				required: parameter.required === true,
			});
		}
		value.push({
			name,
			description: description ?? '',
			url: String(item.url),
			parameters,
			includeVisitor: item.includeVisitor === true,
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The JSON schema the AI sees for a webhook tool.
 * @param {WebhookTool} tool
 * @returns {ToolSchema}
 */
export const webhookSchema = (tool) => ({
	name: tool.name,
	description: tool.description,
	parameters: {
		type: 'object',
		properties: Object.fromEntries(
			tool.parameters.map((p) => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}) }]),
		),
		required: tool.parameters.filter((p) => p.required).map((p) => p.name),
	},
});

/**
 * The built-in tools offered for a turn.
 * @param {{ handoff: boolean, booking: boolean }} on
 * @returns {ToolSchema[]}
 */
export const builtinSchemas = ({ handoff, booking }) => [
	...(handoff
		? [
				{
					name: BUILTIN.escalate,
					description:
						'Hand the conversation to a person from the team when the visitor asks for one, or when you cannot help.',
					parameters: {
						type: 'object',
						properties: { reason: { type: 'string', description: 'Why a person should take over (short).' } },
						required: [],
					},
				},
			]
		: []),
	...(booking
		? [
				{
					name: BUILTIN.slots,
					description: 'List free appointment slots between two dates (YYYY-MM-DD).',
					parameters: {
						type: 'object',
						properties: { from: { type: 'string' }, to: { type: 'string' } },
						required: ['from', 'to'],
					},
				},
				{
					name: BUILTIN.book,
					description:
						'Book one free slot (its id from list_free_slots) for the visitor, with their name and an e-mail or phone number.',
					parameters: {
						type: 'object',
						properties: {
							slotId: { type: 'string' },
							name: { type: 'string' },
							email: { type: 'string' },
							phone: { type: 'string' },
						},
						required: ['slotId', 'name'],
					},
				},
			]
		: []),
];

/**
 * Keep only the declared parameters of a call, with their declared types; a missing required one is an error.
 * @param {WebhookTool} tool
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, value: Record<string, string | number | boolean> } | { ok: false }}
 */
export const checkArguments = (tool, args) => {
	/** @type {Record<string, string | number | boolean>} */
	const value = {};
	for (const parameter of tool.parameters) {
		const raw = args[parameter.name];
		if (raw === undefined || raw === null || raw === '') {
			if (parameter.required) return { ok: false };
			continue;
		}
		if (parameter.type === 'number') {
			const n = typeof raw === 'number' ? raw : Number(raw);
			if (!Number.isFinite(n)) return { ok: false };
			value[parameter.name] = n;
		} else if (parameter.type === 'boolean') {
			if (typeof raw !== 'boolean') return { ok: false };
			value[parameter.name] = raw;
		} else value[parameter.name] = String(raw).slice(0, 1000);
	}
	return { ok: true, value };
};

/**
 * A date range the AI asked for, clamped to today … today + `daysAhead` (dates as YYYY-MM-DD).
 * @param {Record<string, unknown>} args
 * @param {{ today: string, daysAhead: number }} bounds
 * @returns {{ from: string, to: string } | null}
 */
export const slotRange = (args, { today, daysAhead }) => {
	const date = /^\d{4}-\d{2}-\d{2}$/;
	const from = typeof args.from === 'string' && date.test(args.from) ? args.from : today;
	const last = new Date(Date.parse(`${today}T00:00:00Z`) + daysAhead * 86_400_000).toISOString().slice(0, 10);
	const to = typeof args.to === 'string' && date.test(args.to) ? args.to : last;
	const start = from < today ? today : from;
	const end = to > last ? last : to;
	return start <= end ? { from: start, to: end } : null;
};

/**
 * The text the signature covers: `<unix seconds>.<raw body>`.
 * @param {number} timestamp unix seconds
 * @param {string} body
 */
export const signatureBase = (timestamp, body) => `${timestamp}.${body}`;

/**
 * A tool answer as the AI gets it (text, capped).
 * @param {unknown} value
 */
export const toolOutput = (value) => {
	const out = typeof value === 'string' ? value : JSON.stringify(value);
	return out.length > TOOL_OUTPUT_MAX ? `${out.slice(0, TOOL_OUTPUT_MAX)}…` : out;
};
