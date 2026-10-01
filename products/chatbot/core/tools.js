/**
 * Tools (pure), from the ibrahimMobiles assistant tools and their security model: the model can only influence public
 * inputs (a search query, a webhook tool's declared parameters). The order lookup ignores anything the model passes
 * about *who* the customer is and reads only the verified identity of the conversation; guests may look up one
 * order only with its number and the e-mail on the order (when the merchant allows it). Escalation is the safe exit.
 * @module
 */
import { normalise, truncate } from './text.js';

/** Built-in tool names. */
export const BUILTIN = Object.freeze({
	orders: 'lookup_orders',
	guestOrder: 'lookup_order_by_number',
	knowledge: 'search_knowledge',
	escalate: 'escalate_to_human',
});

/** @typedef {import('./providers.js').ToolSchema} ToolSchema */
/**
 * @typedef {object} CustomTool
 * @property {string} name
 * @property {string} description
 * @property {string} url
 * @property {Array<{ name: string, type: 'string' | 'number' | 'integer' | 'boolean', description?: string, required?: boolean, enum?: string[] }>} [parameters]
 * @property {number} [timeout_ms]
 * @property {boolean} [allow_ai]
 * @property {boolean} [allow_flows]
 * @property {boolean} [include_customer]
 * @property {number} [max_response_chars]
 */
/**
 * @typedef {object} ToolsConfig
 * @property {boolean} order_lookup
 * @property {boolean} guest_order_lookup
 * @property {string[]} order_fields
 * @property {number} max_orders
 * @property {boolean} knowledge_search
 * @property {boolean} escalate
 * @property {CustomTool[]} custom
 * @property {number} calls_per_conversation
 */

/**
 * JSON-Schema parameters of a webhook tool.
 * @param {CustomTool} tool
 * @returns {Record<string, unknown>}
 */
export const parametersOf = (tool) => {
	const params = tool.parameters ?? [];
	return {
		type: 'object',
		properties: Object.fromEntries(
			params.map((p) => [
				p.name,
				{
					type: p.type,
					...(p.description ? { description: p.description } : {}),
					...(p.enum?.length ? { enum: p.enum } : {}),
				},
			]),
		),
		required: params.filter((p) => p.required).map((p) => p.name),
		additionalProperties: false,
	};
};

/**
 * Tools offered to the model for a conversation.
 * @param {{ config: ToolsConfig | null, identified: boolean, knowledge: boolean, handoff: boolean,
 *   t: (key: string) => string }} input
 * @returns {ToolSchema[]}
 */
export const toolSchemas = ({ config, identified, knowledge, handoff, t }) => {
	/** @type {ToolSchema[]} */
	const out = [];
	if (config?.order_lookup && identified)
		out.push({
			name: BUILTIN.orders,
			description: t('tools.orders.description'),
			parameters: { type: 'object', properties: {} },
		});
	if (config?.guest_order_lookup && !identified)
		out.push({
			name: BUILTIN.guestOrder,
			description: t('tools.guest_order.description'),
			parameters: {
				type: 'object',
				properties: {
					number: { type: 'string', description: t('tools.guest_order.number') },
					email: { type: 'string', description: t('tools.guest_order.email') },
				},
				required: ['number', 'email'],
			},
		});
	if (knowledge && (config?.knowledge_search ?? true))
		out.push({
			name: BUILTIN.knowledge,
			description: t('tools.knowledge.description'),
			parameters: {
				type: 'object',
				properties: { query: { type: 'string', description: t('tools.knowledge.query') } },
				required: ['query'],
			},
		});
	if (handoff && (config?.escalate ?? true))
		out.push({
			name: BUILTIN.escalate,
			description: t('tools.escalate.description'),
			parameters: {
				type: 'object',
				properties: { reason: { type: 'string', description: t('tools.escalate.reason') } },
				required: ['reason'],
			},
		});
	for (const tool of config?.custom ?? []) {
		if (tool.allow_ai === false) continue;
		out.push({ name: tool.name, description: tool.description, parameters: parametersOf(tool) });
	}
	return out;
};

/**
 * Validate and coerce model-provided arguments against a webhook tool's parameters (unknown keys dropped).
 * @param {CustomTool} tool
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: string[] }}
 */
export const checkArguments = (tool, args) => {
	/** @type {Record<string, unknown>} */
	const value = {};
	/** @type {string[]} */
	const errors = [];
	for (const p of tool.parameters ?? []) {
		let v = args?.[p.name];
		if (v === undefined || v === null || v === '') {
			if (p.required) errors.push(`${p.name}: required`);
			continue;
		}
		if ((p.type === 'number' || p.type === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
			v = Number(v);
		if (p.type === 'boolean' && (v === 'true' || v === 'false')) v = v === 'true';
		const typeOk =
			p.type === 'string'
				? typeof v === 'string'
				: p.type === 'boolean'
					? typeof v === 'boolean'
					: p.type === 'integer'
						? Number.isInteger(v)
						: typeof v === 'number' && Number.isFinite(v);
		if (!typeOk) {
			errors.push(`${p.name}: must be ${p.type}`);
			continue;
		}
		if (typeof v === 'string' && v.length > 2000) v = v.slice(0, 2000);
		if (p.enum?.length && !p.enum.includes(String(v))) {
			errors.push(`${p.name}: must be one of ${p.enum.join(', ')}`);
			continue;
		}
		value[p.name] = v;
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * @typedef {object} CachedOrder
 * @property {string} orderId
 * @property {string | null} number
 * @property {string | null} customerId
 * @property {{ customerId?: string, subject?: string, email?: string, phone?: string } | null} customer
 * @property {string} status placed | paid | completed | cancelled | refunded
 * @property {string | null} currency
 * @property {number | null} total
 * @property {Array<{ title?: string, sku?: string, quantity: number }>} lines
 * @property {number} refunded minor units refunded
 * @property {string | null} placedAt
 * @property {string} updatedAt
 */

/**
 * Money in minor units as a decimal string for the model (`12345` USD → `123.45 USD`).
 * @param {number | null} amount
 * @param {string | null} currency
 */
export const formatMoney = (amount, currency) => {
	if (amount === null || amount === undefined || !currency) return null;
	let digits = 2;
	try {
		digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		// unknown currency code: two decimals
	}
	return `${(amount / 10 ** digits).toFixed(digits)} ${currency}`;
};

/**
 * Customer-visible order summary with the merchant's chosen fields only.
 * @param {CachedOrder} order
 * @param {string[]} fields
 */
export const orderSummary = (order, fields) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	const want = new Set(fields);
	if (want.has('number')) out.number = order.number ?? order.orderId;
	if (want.has('status')) out.status = order.status;
	if (want.has('placedAt') && order.placedAt) out.placedAt = order.placedAt;
	if (want.has('updatedAt')) out.updatedAt = order.updatedAt;
	if (want.has('total')) out.total = formatMoney(order.total, order.currency);
	if (want.has('currency') && order.currency) out.currency = order.currency;
	if (want.has('items'))
		out.items = order.lines.slice(0, 20).map((line) => ({ title: line.title ?? line.sku ?? null, quantity: line.quantity }));
	if (want.has('refunded') && order.refunded > 0) out.refunded = formatMoney(order.refunded, order.currency);
	return out;
};

/**
 * Does a guest's claim (order number + e-mail) match a cached order? Case- and space-insensitive.
 * @param {CachedOrder} order
 * @param {{ number: string, email: string }} claim
 */
export const guestClaimMatches = (order, claim) => {
	const email = order.customer?.email;
	if (!email || !claim.email) return false;
	const sameNumber =
		normalise(order.number ?? order.orderId).replace(/\s|#/g, '') === normalise(claim.number).replace(/\s|#/g, '');
	return sameNumber && normalise(email) === normalise(claim.email);
};

/**
 * Tool output for the model: JSON text, capped.
 * @param {unknown} value
 * @param {number} max
 */
export const toolOutput = (value, max) => truncate(typeof value === 'string' ? value : JSON.stringify(value), max);

/**
 * Canonical string a webhook signature covers.
 * @param {number} timestamp seconds
 * @param {string} body
 */
export const signatureBase = (timestamp, body) => `ss-chatbot-tool.v1.${timestamp}.${body}`;
