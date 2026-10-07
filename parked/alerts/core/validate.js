/**
 * Input validation at every boundary (pure). Problems are `{ path, code }` (JSON Pointer paths); the API turns them
 * into RFC 9457 `validation_failed` errors and the headless core into field messages from the string catalog.
 * @module
 */
import { isChannel } from './contact.js';
import { customKeyOf, isId, isMoney } from './types.js';

/** @typedef {{ path: string, code: string }} FieldProblem */

const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TEXT_MAX = 200;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export const isLang = (value) => typeof value === 'string' && value.length <= 35 && LANG.test(value);

/**
 * Display details of a target (`{ name?, url? }`): `name` plain text ≤ 200, `url` absolute https ≤ 2048.
 * @param {unknown} item
 * @param {string} path
 * @returns {FieldProblem[]}
 */
const checkItem = (item, path) => {
	if (item === undefined) return [];
	if (!isObject(item)) return [{ path, code: 'invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	if (item.name !== undefined && (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > TEXT_MAX))
		problems.push({ path: `${path}/name`, code: 'invalid' });
	if (item.url !== undefined) {
		let ok = typeof item.url === 'string' && item.url.length <= 2048;
		if (ok) {
			try {
				ok = new URL(/** @type {string} */ (item.url)).protocol === 'https:';
			} catch {
				ok = false;
			}
		}
		if (!ok) problems.push({ path: `${path}/url`, code: 'invalid' });
	}
	return problems;
};

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {FieldProblem[]}
 */
const checkMoney = (value, path) => (value === undefined || isMoney(value) ? [] : [{ path, code: 'invalid_money' }]);

/**
 * Target fields shared by subscriptions and triggers.
 * @param {Record<string, any>} body
 * @returns {FieldProblem[]}
 */
const checkTarget = (body) => [
	...(isId(body.itemId) ? [] : [{ path: '/itemId', code: body.itemId === undefined ? 'required' : 'invalid' }]),
	...(body.variantId === undefined || body.variantId === null || isId(body.variantId)
		? []
		: [{ path: '/variantId', code: 'invalid' }]),
];

/**
 * `POST /v1/subscriptions`.
 * @param {unknown} body
 * @param {{ types: readonly string[], channels: readonly string[], requireConsent: boolean, allowTarget: boolean, serverKey: boolean }} policy
 * @returns {FieldProblem[]}
 */
export const validateSubscribe = (body, { types, channels, requireConsent, allowTarget, serverKey }) => {
	if (!isObject(body)) return [{ path: '', code: 'invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	if (typeof body.type !== 'string') problems.push({ path: '/type', code: 'required' });
	else if (!types.includes(body.type)) problems.push({ path: '/type', code: 'type_not_enabled' });
	const custom = typeof body.type === 'string' ? customKeyOf(body.type) : null;
	if (!(custom && body.itemId === '*')) problems.push(...checkTarget(body));
	if (!isChannel(body.channel)) problems.push({ path: '/channel', code: body.channel === undefined ? 'required' : 'invalid' });
	else if (!channels.includes(body.channel)) problems.push({ path: '/channel', code: 'channel_not_enabled' });
	for (const field of ['email', 'phone'])
		if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string')
			problems.push({ path: `/${field}`, code: 'invalid' });
	if (requireConsent && !serverKey && body.consent !== true) problems.push({ path: '/consent', code: 'consent_required' });
	if (body.consent !== undefined && typeof body.consent !== 'boolean') problems.push({ path: '/consent', code: 'invalid' });
	if (body.lang !== undefined && !isLang(body.lang)) problems.push({ path: '/lang', code: 'invalid' });
	problems.push(...checkMoney(body.price, '/price'), ...checkItem(body.item, '/item'));
	if (body.threshold !== undefined) {
		if (!isObject(body.threshold) || body.type !== 'price_drop') problems.push({ path: '/threshold', code: 'invalid' });
		else {
			const { targetAmount, percent, amount } = body.threshold;
			if (targetAmount !== undefined && targetAmount !== null) {
				if (!allowTarget) problems.push({ path: '/threshold/targetAmount', code: 'target_not_allowed' });
				else if (!Number.isSafeInteger(targetAmount) || targetAmount <= 0)
					problems.push({ path: '/threshold/targetAmount', code: 'invalid' });
			}
			if (percent !== undefined && percent !== null && !(typeof percent === 'number' && percent > 0 && percent < 100))
				problems.push({ path: '/threshold/percent', code: 'invalid' });
			if (amount !== undefined && amount !== null && !(Number.isSafeInteger(amount) && amount > 0))
				problems.push({ path: '/threshold/amount', code: 'invalid' });
		}
	}
	if (!serverKey)
		for (const field of ['customerId', 'tier'])
			if (body[field] !== undefined) problems.push({ path: `/${field}`, code: 'server_key_required' });
	if (body.customerId !== undefined && !isId(body.customerId)) problems.push({ path: '/customerId', code: 'invalid' });
	if (body.tier !== undefined && (typeof body.tier !== 'string' || body.tier.length === 0 || body.tier.length > 64))
		problems.push({ path: '/tier', code: 'invalid' });
	return problems;
};

/**
 * `POST /v1/triggers` (one change).
 * @param {unknown} body
 * @returns {FieldProblem[]}
 */
export const validateTrigger = (body) => {
	if (!isObject(body)) return [{ path: '', code: 'invalid' }];
	/** @type {FieldProblem[]} */
	const problems = [];
	if (!['inventory', 'price', 'custom'].includes(body.kind))
		problems.push({ path: '/kind', code: body.kind === undefined ? 'required' : 'invalid' });
	if (body.kind !== 'custom' || body.itemId !== undefined) problems.push(...checkTarget(body));
	if (body.locationId !== undefined && !isId(body.locationId)) problems.push({ path: '/locationId', code: 'invalid' });
	if (body.kind === 'inventory' && !Number.isSafeInteger(body.quantity))
		problems.push({ path: '/quantity', code: body.quantity === undefined ? 'required' : 'invalid' });
	if (body.previousQuantity !== undefined && !Number.isSafeInteger(body.previousQuantity))
		problems.push({ path: '/previousQuantity', code: 'invalid' });
	if (body.kind === 'price' && body.price === undefined) problems.push({ path: '/price', code: 'required' });
	problems.push(...checkMoney(body.price, '/price'), ...checkMoney(body.previousPrice, '/previousPrice'));
	if (
		body.kind === 'custom' &&
		!(typeof body.type === 'string' && /^custom\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:@[1-9]\d*)?$/.test(body.type))
	)
		problems.push({ path: '/type', code: body.type === undefined ? 'required' : 'invalid' });
	if (body.data !== undefined && !isObject(body.data)) problems.push({ path: '/data', code: 'invalid' });
	if (body.id !== undefined && !isId(body.id)) problems.push({ path: '/id', code: 'invalid' });
	if (body.occurredAt !== undefined && (typeof body.occurredAt !== 'string' || Number.isNaN(Date.parse(body.occurredAt))))
		problems.push({ path: '/occurredAt', code: 'invalid' });
	problems.push(...checkItem(body.item, '/item'));
	return problems;
};

/**
 * Merchant template overrides: every placeholder must be one the type provides.
 * @param {readonly { type: string, body: string, subject?: string }[]} templates
 * @param {Readonly<Record<string, readonly string[]>>} allowed placeholders per template type family
 * @returns {FieldProblem[]}
 */
export const validateTemplates = (templates, allowed) => {
	/** @type {FieldProblem[]} */
	const problems = [];
	for (const [index, template] of templates.entries()) {
		const family = template.type.startsWith('custom:') ? 'custom' : template.type;
		const names = allowed[family] ?? allowed['*'] ?? [];
		for (const part of /** @type {const} */ (['subject', 'body'])) {
			const text = template[part];
			if (typeof text !== 'string') continue;
			for (const match of text.matchAll(/\{([A-Za-z_]\w*)\}/g))
				if (!names.includes(match[1] ?? ''))
					problems.push({ path: `/templates/${index}/${part}`, code: `unknown_placeholder:${match[1]}` });
		}
	}
	return problems;
};
