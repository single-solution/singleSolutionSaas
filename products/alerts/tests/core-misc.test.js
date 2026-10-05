import { describe, expect, it } from 'vitest';
import { summarize } from '../core/analytics.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { checkCondition, compileCondition, conditionMatches } from '../core/rules.js';
import { isActive, mergeItem, newSubscription, sanitizeItem } from '../core/subscription.js';
import { isLang, isObject, validateSubscribe, validateTemplates, validateTrigger } from '../core/validate.js';
import { messageView, subscriptionView, triggerView } from '../core/views.js';

const policy = {
	types: ['back_in_stock', 'price_drop', 'custom:vip'],
	channels: ['email', 'sms'],
	requireConsent: true,
	allowTarget: true,
	serverKey: false,
};
const valid = { type: 'back_in_stock', itemId: 'itm_1', channel: 'email', email: 'a@b.co', consent: true };
/** @param {Array<{ path: string, code: string }>} problems */
const codes = (problems) => problems.map((p) => `${p.path}:${p.code}`);

describe('validate', () => {
	it('accepts a valid sign-up and reports every invalid field', () => {
		expect(validateSubscribe(valid, policy)).toEqual([]);
		expect(validateSubscribe(null, policy)).toEqual([{ path: '', code: 'invalid' }]);
		expect(codes(validateSubscribe({}, policy))).toEqual([
			'/type:required',
			'/itemId:required',
			'/channel:required',
			'/consent:consent_required',
		]);
		expect(
			codes(
				validateSubscribe(
					{
						type: 'restock',
						itemId: 'bad id',
						variantId: 'bad id',
						channel: 'fax',
						email: 5,
						consent: 'yes',
						lang: 'English',
						price: { amount: 'x' },
						item: { name: '', url: 'http://x' },
						customerId: 'c',
						tier: 'gold',
					},
					policy,
				),
			),
		).toEqual([
			'/type:type_not_enabled',
			'/itemId:invalid',
			'/variantId:invalid',
			'/channel:invalid',
			'/email:invalid',
			'/consent:consent_required',
			'/consent:invalid',
			'/lang:invalid',
			'/price:invalid_money',
			'/item/name:invalid',
			'/item/url:invalid',
			'/customerId:server_key_required',
			'/tier:server_key_required',
		]);
		expect(codes(validateSubscribe({ ...valid, channel: 'whatsapp' }, policy))).toEqual(['/channel:channel_not_enabled']);
		expect(codes(validateSubscribe({ ...valid, item: 'x' }, policy))).toEqual(['/item:invalid']);
		expect(codes(validateSubscribe({ ...valid, item: { url: 'not a url' } }, policy))).toEqual(['/item/url:invalid']);
		expect(validateSubscribe({ ...valid, type: 'custom:vip', itemId: '*' }, policy)).toEqual([]);
	});

	it('checks price-drop thresholds and server-only fields', () => {
		const drop = { ...valid, type: 'price_drop' };
		expect(validateSubscribe({ ...drop, threshold: { targetAmount: 500, percent: 10, amount: 100 } }, policy)).toEqual([]);
		expect(codes(validateSubscribe({ ...drop, threshold: { targetAmount: 0, percent: 100, amount: -1 } }, policy))).toEqual([
			'/threshold/targetAmount:invalid',
			'/threshold/percent:invalid',
			'/threshold/amount:invalid',
		]);
		expect(codes(validateSubscribe({ ...drop, threshold: { targetAmount: 5 } }, { ...policy, allowTarget: false }))).toEqual([
			'/threshold/targetAmount:target_not_allowed',
		]);
		expect(codes(validateSubscribe({ ...valid, threshold: {} }, policy))).toEqual(['/threshold:invalid']);
		const server = { ...policy, serverKey: true };
		expect(validateSubscribe({ ...valid, consent: undefined, customerId: 'cus_1', tier: 'gold' }, server)).toEqual([]);
		expect(codes(validateSubscribe({ ...valid, customerId: 'bad id', tier: '' }, server))).toEqual([
			'/customerId:invalid',
			'/tier:invalid',
		]);
	});

	it('validates trigger bodies', () => {
		expect(validateTrigger({ kind: 'inventory', itemId: 'itm_1', quantity: 5 })).toEqual([]);
		expect(validateTrigger({ kind: 'price', itemId: 'itm_1', price: { amount: 5, currency: 'EUR' } })).toEqual([]);
		expect(validateTrigger({ kind: 'custom', type: 'custom.drop_opened@2', data: {} })).toEqual([]);
		expect(validateTrigger('x')).toEqual([{ path: '', code: 'invalid' }]);
		expect(codes(validateTrigger({}))).toEqual(['/kind:required', '/itemId:required']);
		expect(
			codes(
				validateTrigger({
					kind: 'inventory',
					itemId: 'itm_1',
					locationId: 'bad id',
					quantity: 'x',
					previousQuantity: 1.5,
					id: 'bad id',
					occurredAt: 'yesterday',
					item: { name: 7 },
				}),
			),
		).toEqual([
			'/locationId:invalid',
			'/quantity:invalid',
			'/previousQuantity:invalid',
			'/id:invalid',
			'/occurredAt:invalid',
			'/item/name:invalid',
		]);
		expect(codes(validateTrigger({ kind: 'price', itemId: 'itm_1' }))).toEqual(['/price:required']);
		expect(codes(validateTrigger({ kind: 'custom', type: 'order.placed', data: [] }))).toEqual([
			'/type:invalid',
			'/data:invalid',
		]);
		expect(codes(validateTrigger({ kind: 'custom' }))).toEqual(['/type:required']);
		expect(codes(validateTrigger({ kind: 'nope', itemId: 'itm_1' }))).toEqual(['/kind:invalid']);
		expect(codes(validateTrigger({ kind: 'inventory', itemId: 'itm_1' }))).toEqual(['/quantity:required']);
	});

	it('checks template placeholders', () => {
		const allowed = { back_in_stock: ['item', 'url'], custom: ['item'], '*': ['item'] };
		expect(validateTemplates([{ type: 'back_in_stock', body: '{item} {url}', subject: '{item}' }], allowed)).toEqual([]);
		expect(
			validateTemplates(
				[
					{ type: 'custom:vip', body: '{price}' },
					{ type: 'digest', body: '{lines}' },
				],
				allowed,
			),
		).toEqual([
			{ path: '/templates/0/body', code: 'unknown_placeholder:price' },
			{ path: '/templates/1/body', code: 'unknown_placeholder:lines' },
		]);
		expect(validateTemplates([{ type: 'x', body: '{a}' }], {})).toEqual([
			{ path: '/templates/0/body', code: 'unknown_placeholder:a' },
		]);
	});

	it('recognises languages and objects', () => {
		expect(isLang('pt-BR')).toBe(true);
		expect(isLang('EN')).toBe(false);
		expect(isObject([])).toBe(false);
		expect(isObject({})).toBe(true);
	});
});

describe('subscriptions', () => {
	const input = {
		id: 'als_1',
		type: 'back_in_stock',
		target: { itemId: 'itm_1', variantId: 'v1' },
		channel: /** @type {const} */ ('email'),
		address: { email: 'a@b.co' },
		contactKey: 'ck_1',
		customerId: null,
		lang: 'en',
		tier: null,
		rank: 0,
		threshold: null,
		priceAtSubscribe: null,
		item: null,
		consent: { given: true, textVersion: 'v1' },
		source: /** @type {const} */ ('widget'),
		confirm: false,
		now: Date.parse('2026-10-01T00:00:00Z'),
		pendingDays: 10,
		confirmHours: 2,
	};
	it('builds pending and unconfirmed subscriptions', () => {
		const sub = newSubscription(input);
		expect(sub).toMatchObject({
			status: 'pending',
			active: true,
			targetKey: 'itm_1|v1',
			cycle: 0,
			confirmedAt: '2026-10-01T00:00:00.000Z',
		});
		expect(sub.expiresAt.toISOString()).toBe('2026-10-11T00:00:00.000Z');
		const unconfirmed = newSubscription({
			...input,
			confirm: true,
			target: { itemId: 'itm_1' },
			consent: { given: false, textVersion: null },
		});
		expect(unconfirmed).toMatchObject({
			status: 'unconfirmed',
			confirmedAt: null,
			target: { itemId: 'itm_1' },
			consent: { at: null },
		});
		expect(unconfirmed.expiresAt.toISOString()).toBe('2026-10-01T02:00:00.000Z');
		expect(isActive('claimed')).toBe(true);
		expect(isActive('notified')).toBe(false);
	});

	it('sanitises display details from the page', () => {
		const site = { domain: 'shop.example.com', allowSubdomains: true, policy: /** @type {const} */ ('same_site') };
		expect(sanitizeItem({ name: ' Phone\u0007X ', url: 'https://m.shop.example.com/p' }, site)).toEqual({
			name: 'Phone X',
			url: 'https://m.shop.example.com/p',
		});
		expect(sanitizeItem({ url: 'https://evil.example/p' }, site)).toBeNull();
		expect(sanitizeItem({ url: 'https://evil.example/p' }, { ...site, policy: 'any_https' })).toEqual({
			url: 'https://evil.example/p',
		});
		expect(sanitizeItem({ url: 'https://user:pw@shop.example.com/' }, site)).toBeNull();
		expect(sanitizeItem({ url: 'https://shop.example.com/' }, { ...site, policy: 'none' })).toBeNull();
		expect(sanitizeItem({ url: 'https://x.shop.example.com/' }, { ...site, allowSubdomains: false })).toBeNull();
		expect(sanitizeItem({ url: '::' }, site)).toBeNull();
		expect(sanitizeItem(undefined, site)).toBeNull();
		expect(mergeItem({ name: 'a', url: 'u' }, { name: 'b' })).toEqual({ name: 'b', url: 'u' });
		expect(mergeItem(null, { name: 'b' })).toEqual({ name: 'b' });
		expect(mergeItem({ name: 'a' }, null)).toEqual({ name: 'a' });
	});

	it('views subscriptions, messages and runs', () => {
		const sub = newSubscription(input);
		expect(subscriptionView(sub)).toMatchObject({ id: 'als_1', contact: null, contactMasked: 'a•••@b.co', variantId: 'v1' });
		expect(subscriptionView(sub, { reveal: true, position: 2 })).toMatchObject({ contact: { email: 'a@b.co' }, position: 2 });
		expect(
			subscriptionView(/** @type {any} */ ({ ...sub, address: null, target: { itemId: 'i' }, consent: undefined })),
		).toMatchObject({ contact: null, contactMasked: null, consent: { given: false, at: null } });
		expect(
			messageView({
				id: 'alm_1',
				kind: 'alert',
				to: { phone: '+15550001111' },
				notBefore: 0,
				items: [{ subscriptionId: 's', type: 't' }],
			}),
		).toMatchObject({
			to: '+15••••••111',
			attempts: 0,
			notBefore: '1970-01-01T00:00:00.000Z',
			items: [{ subscriptionId: 's', type: 't', itemId: null, variantId: null }],
		});
		expect(messageView({ id: 'alm_2' })).toMatchObject({ items: [], notBefore: null, sentAt: null });
		expect(triggerView({ id: 'trg_1', source: 'api', kind: 'custom', status: 'done', at: 'x' })).toMatchObject({
			itemId: null,
			matched: 0,
			more: false,
		});
		expect(triggerView({ id: 'trg_1', target: { itemId: 'i', variantId: 'v' }, open: true })).toMatchObject({
			itemId: 'i',
			variantId: 'v',
			more: true,
		});
	});
});

describe('analytics', () => {
	it('folds rows into a report with basis-point rates and zero-filled days', () => {
		const report = summarize({
			from: 'a',
			to: 'b',
			subscriptions: [
				{ type: 'back_in_stock', status: 'notified', count: 3 },
				{ type: 'back_in_stock', status: 'pending', count: 5 },
				{ type: 'price_drop', status: 'unsubscribed', count: 2 },
				{ type: 'back_in_stock', status: 'notified', count: 1 },
			],
			messages: [
				{ channel: 'email', status: 'sent', count: 3, alerts: 4 },
				{ channel: 'sms', status: 'failed', count: 1, alerts: 1 },
				{ channel: 'email', status: 'sent', count: 1, alerts: 1 },
			],
			daily: [{ day: '2026-10-01', subscribed: 2, sent: 1 }],
			days: ['2026-09-30', '2026-10-01'],
		});
		expect(report.subscriptions).toEqual({
			total: 11,
			byStatus: { notified: 4, pending: 5, unsubscribed: 2 },
			byType: { back_in_stock: { notified: 4, pending: 5 }, price_drop: { unsubscribed: 2 } },
		});
		expect(report.messages).toEqual({
			sent: 4,
			failed: 1,
			byChannel: { email: { sent: 4 }, sms: { failed: 1 } },
			alertsDelivered: 5,
		});
		expect(report.rates).toEqual({ notifiedBps: 3636, unsubscribedBps: 1818, deliveryBps: 8000 });
		expect(report.daily).toEqual([
			{ day: '2026-09-30', subscribed: 0, sent: 0 },
			{ day: '2026-10-01', subscribed: 2, sent: 1 },
		]);
		expect(summarize({ from: 'a', to: 'b', subscriptions: [], messages: [], daily: [], days: [] }).rates).toEqual({
			notifiedBps: 0,
			unsubscribedBps: 0,
			deliveryBps: 0,
		});
	});
});

describe('config and rules', () => {
	it('overlays typed values on schema defaults', () => {
		const schema = {
			properties: {
				a: { type: 'integer', default: 1 },
				b: { type: 'array', default: ['x'] },
				c: { type: 'string', default: 's' },
				d: { default: null },
			},
		};
		expect(defaultsOf(schema)).toEqual({ a: 1, b: ['x'], c: 's', d: null });
		expect(effectiveConfig(schema, { a: 2.5, b: [], c: 3, d: 4, extra: 1 })).toEqual({ a: 1, b: [], c: 's', d: 4 });
		expect(
			effectiveConfig(
				{
					properties: {
						n: { type: 'number', default: 1 },
						f: { type: 'boolean', default: false },
						o: { type: 'object', default: {} },
					},
				},
				{ n: 2.5, f: true, o: { k: 1 } },
			),
		).toEqual({ n: 2.5, f: true, o: { k: 1 } });
		expect(effectiveConfig({}, null)).toEqual({});
	});

	it('compiles, checks and evaluates custom-type conditions', () => {
		expect(compileCondition('')).toEqual({ ok: true, program: null });
		expect(compileCondition("event.data.region == 'EU'").ok).toBe(true);
		expect(compileCondition("event.data.region == 'EU'")).toBe(compileCondition("event.data.region == 'EU'"));
		expect(compileCondition('(((').ok).toBe(false);
		expect(checkCondition('').ok).toBe(true);
		expect(checkCondition('foo == 1').warnings.length).toBeGreaterThan(0);
		const context = { event: { type: 'custom.drop@1', data: { region: 'EU' } }, item: {} };
		const options = { now: 0, timeZone: 'UTC' };
		expect(conditionMatches("event.data.region == 'EU'", context, options)).toEqual({ matched: true, error: null });
		expect(conditionMatches("event.data.region == 'US'", context, options)).toEqual({ matched: false, error: null });
		expect(conditionMatches('', context, options)).toEqual({ matched: true, error: null });
		expect(conditionMatches('(((', context, options).matched).toBe(false);
		expect(conditionMatches('len(event.data.region) > 1 and number(event.data.region) > 1', context, options).matched).toBe(
			false,
		);
		for (let index = 0; index < 510; index += 1) compileCondition(`event.data.n == ${index}`);
	});
});
