/**
 * PLAN 0.8.10 K1 (with K2 and K7) against the real Portal: a settings round trip per product. The merchant's server,
 * with the Portal-issued server token and an acting user (`SS-Actor-*`), reads the features and settings, saves a
 * setting of a switched-on feature, sees it in the product dashboard and in Recent changes under the acting user's
 * name, resets it, is refused a setting of a switched-off feature, and edits a widget text, the theme, the Format, a
 * list (Chat, Ecommerce) and reads the connections.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as accounts from '@ss/product-accounts/product';
import * as accountsRoutes from '@ss/product-accounts/routes';
import * as chat from '@ss/product-chat/product';
import * as chatRoutes from '@ss/product-chat/routes';
import * as ecommerce from '@ss/product-ecommerce/product';
import * as ecommerceRoutes from '@ss/product-ecommerce/routes';
import * as growth from '@ss/product-growth/product';
import * as growthRoutes from '@ss/product-growth/routes';
import * as notifications from '@ss/product-notifications/product';
import * as notificationsRoutes from '@ss/product-notifications/routes';
import * as payments from '@ss/product-payments/product';
import * as paymentsRoutes from '@ss/product-payments/routes';
import { codeOf, startSystem } from './helpers.js';

const ACTOR = { 'ss-actor-id': 'usr_settings_1', 'ss-actor-name': encodeURIComponent('Zara Qureshi'), 'ss-actor-role': 'Owner' };

/**
 * @typedef {object} Case
 * @property {string} id
 * @property {any} product the product module (`./product`)
 * @property {any} routes the routes module (`./routes`)
 * @property {string[]} on features switched on
 * @property {string} setting `<feature>.<setting>` of a switched-on feature
 * @property {unknown} value a valid value of it
 * @property {{ name: string, value: unknown } | null} list a list setting and a valid value
 */

/** @type {Case[]} */
const CASES = [
	{
		id: 'accounts',
		product: accounts,
		routes: accountsRoutes,
		on: ['phone_code'],
		setting: 'phone_code.codeLength',
		value: 8,
		list: null,
	},
	{
		id: 'chat',
		product: chat,
		routes: chatRoutes,
		on: ['visitor_chat', 'proactive_pages'],
		setting: 'visitor_chat.fullScreenOnMobile',
		value: false,
		list: { name: 'page_rules', value: [{ path: '/products/**', delay: 10, message: 'Need help choosing?' }] },
	},
	{
		id: 'ecommerce',
		product: ecommerce,
		routes: ecommerceRoutes,
		on: ['catalog', 'checkout'],
		setting: 'catalog.pageSize',
		value: 36,
		list: {
			name: 'couriers',
			value: [{ key: 'swift', name: 'Swift Couriers', trackingUrl: 'https://swift.example.com/t/{tracking}' }],
		},
	},
	{
		id: 'growth',
		product: growth,
		routes: growthRoutes,
		on: ['visitor_analytics'],
		setting: 'visitor_analytics.retentionMonths',
		value: 6,
		list: null,
	},
	{
		id: 'notifications',
		product: notifications,
		routes: notificationsRoutes,
		on: ['quiet_hours'],
		setting: 'quiet_hours.startHour',
		value: 22,
		list: null,
	},
	{
		id: 'payments',
		product: payments,
		routes: paymentsRoutes,
		on: ['bank_transfer'],
		setting: 'bank_transfer.proofUpload',
		value: false,
		list: null,
	},
];

/** @type {Array<() => Promise<void>>} */
const stops = [];
afterAll(async () => {
	for (const stop of stops) await stop();
});

describe.each(CASES)('settings API of $id (K1)', ({ id, product, routes, on, setting, value, list }) => {
	it('round-trips settings, texts, theme, Format, lists and connections as the acting user', async () => {
		const sys = await startSystem({
			unit: {
				createProductInstance: product.createProductInstance,
				createRoutes: routes.createRoutes,
				manifest: product.manifest,
				strings: product.strings,
				url: `https://${id}.test`,
			},
		});
		stops.push(() => sys.stop());
		await sys.connect();
		const m = await sys.merchant(`settings-${id}@shop.test`, [`settings-${id}.example.com`]);
		const websiteId = m.websiteIds[0] ?? '';
		await sys.addProduct(m.merchantId, websiteId, id);
		await sys.switchFeatures(await sys.adminSession(await sys.owner(), websiteId, id), websiteId, on);
		const { server } = await sys.tokens(m.merchantId, websiteId, id);
		/** @param {string} method @param {string} path @param {unknown} [body] */
		const api = (method, path, body) =>
			sys.call(method, path, { token: server, headers: ACTOR, ...(body === undefined ? {} : { body }) });

		// features: read-only, with on/off and the hourly price
		const features = await api('GET', '/v1/features');
		expect(features.status).toBe(200);
		for (const key of on)
			expect(features.json.features).toContainEqual(expect.objectContaining({ key, on: true, millicreditsPerHour: 0 }));
		expect((await api('PUT', '/v1/features', { on: [] })).status).toBe(405);

		// settings: values only of switched-on features
		const [featureKey = '', settingKey = ''] = setting.split('.');
		const listed = await api('GET', '/v1/settings');
		const feature = listed.json.features.find((/** @type {{ key: string }} */ f) => f.key === featureKey);
		expect(feature).toMatchObject({ on: true, values: { [settingKey]: { source: 'built-in' } } });
		for (const other of listed.json.features.filter((/** @type {{ on: boolean }} */ f) => !f.on))
			expect(other.values).toBeNull();
		const off = listed.json.features.find(
			(/** @type {{ on: boolean, schema: any }} */ f) => !f.on && Object.keys(f.schema.properties ?? {}).length > 0,
		);
		if (off) {
			const offKey = String(Object.keys(off.schema.properties)[0]);
			const refused = await api('PUT', `/v1/settings/${off.key}.${offKey}`, { value: off.schema.properties[offKey].default });
			expect([refused.status, codeOf(refused)]).toEqual([403, 'feature_off']);
		}

		const saved = await api('PUT', `/v1/settings/${setting}`, { value });
		expect(saved).toMatchObject({ status: 200, json: { key: setting, value, source: 'website' } });
		const dashboardCookie = await sys.merchantSession(m, websiteId);
		const base = `https://${id}.test`;
		const seen = await sys.dashboard(dashboardCookie, 'GET', `/v1/dashboard/websites/${websiteId}/settings`, undefined, base);
		expect(seen.json.features.find((/** @type {{ key: string }} */ f) => f.key === featureKey).values[settingKey]).toEqual({
			value,
			source: 'website',
		});
		const overview = await sys.dashboard(
			dashboardCookie,
			'GET',
			`/v1/dashboard/websites/${websiteId}/overview`,
			undefined,
			base,
		);
		expect(overview.json.recentChanges[0]).toMatchObject({
			what: 'settings',
			who: { kind: 'user', id: 'usr_settings_1', name: 'Zara Qureshi', role: 'Owner' },
		});
		const reset = await api('DELETE', `/v1/settings/${setting}`);
		expect(reset.json).toMatchObject({ key: setting, source: 'built-in' });
		expect(reset.json.value).not.toEqual(value);
		const invalid = await api('PUT', `/v1/settings/${setting}`, { value: 'not valid' });
		expect([invalid.status, codeOf(invalid)]).toEqual([422, 'validation_failed']);

		// widget texts, theme and Format (K7)
		const texts = await api('GET', '/v1/texts');
		const text = texts.json.texts.find((/** @type {{ english: string }} */ t) => !t.english.includes('{'));
		expect((await api('PUT', `/v1/texts/${text.key}`, { value: 'Translated' })).json).toMatchObject({
			value: 'Translated',
			source: 'website',
		});
		expect((await api('DELETE', `/v1/texts/${text.key}`)).json).toMatchObject({ value: text.english, source: 'built-in' });
		expect((await api('PUT', '/v1/theme', { radius: 4 })).json.theme.radius).toBe(4);
		const format = await api('PUT', '/v1/format', {
			locale: 'en-GB',
			currencyDisplay: 'symbol',
			wholeUnits: true,
			times: 'business',
		});
		expect(format.json.format).toEqual({
			locale: 'en-GB',
			currencyDisplay: 'symbol',
			currencySymbol: '',
			wholeUnits: true,
			times: 'business',
		});
		expect((await api('GET', '/v1/format')).json.sources.wholeUnits).toBe('website');

		// lists: the whole list, checked by the product
		if (list) {
			const before = await api('GET', `/v1/lists/${list.name}`);
			expect(before.status).toBe(200);
			const put = await api('PUT', `/v1/lists/${list.name}`, { value: list.value });
			expect(put).toMatchObject({ status: 200, json: { value: list.value } });
			expect((await api('GET', `/v1/lists/${list.name}`)).json.value).toEqual(list.value);
			const bad = await api('PUT', `/v1/lists/${list.name}`, { value: 'not a list' });
			expect([bad.status, codeOf(bad)]).toEqual([422, 'validation_failed']);
		}
		expect((await api('GET', '/v1/lists/nope')).status).toBe(404);

		// connections: never the secrets
		const connections = await api('GET', '/v1/connections');
		expect(connections.json.connections).toContainEqual(
			expect.objectContaining({ name: 'database', kind: 'database', state: 'not_connected', last4: '' }),
		);
	});
});
