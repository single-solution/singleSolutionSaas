import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorOf, demoDashboard, resolveDashboard } from '../api/dashboard.js';
import { sessionView } from '../api/session.js';
import { settingsFrom } from '../api/settings.js';
import { createTranslator } from '../headless/strings.js';
import { PHONE } from './helpers.js';
import { MERCHANT, T0, WEBSITE, WEBSITE_2, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/**
 * A dashboard API call with a session cookie.
 * @param {string} method @param {string} path @param {string} session @param {unknown} [body]
 */
const dashboard = async (method, path, session, body) => {
	const response = await h.handle(
		new Request(`https://configurator.example.com${path}`, {
			method,
			headers: {
				cookie: `ss_session=${session}`,
				'x-ss-website': WEBSITE,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
				...(method === 'POST' ? { 'idempotency-key': `idk-${Math.random()}` } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
	const text = await response.text();
	return { status: response.status, json: text ? JSON.parse(text) : null };
};

describe('dashboard API (SSO sessions)', () => {
	it('creates, checks, updates and previews configurators, audited with the dashboard actor', async () => {
		const session = await h.session();
		const view = await dashboard('GET', '/v1/session', session);
		expect(view.json).toMatchObject({ kind: 'merchant', role: 'merchant' });
		const created = await dashboard('POST', '/v1/dashboard/configurators', session, { ...PHONE, status: 'published' });
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		const audit = await h.db
			.collection('ss_configurator_audit')
			.findOne({ websiteId: WEBSITE, action: 'configurator.created' });
		expect(audit?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		expect((await dashboard('POST', '/v1/dashboard/configurators', session, { name: 'x' })).status).toBe(422);
		expect(
			(await dashboard('POST', '/v1/dashboard/configurators', session, { ...PHONE, key: 'other', status: 'x' })).status,
		).toBe(422);
		const updated = await dashboard('PATCH', `/v1/dashboard/configurators/${created.json.id}`, session, {
			version: 1,
			name: 'Renamed',
		});
		expect(updated.json).toMatchObject({ name: 'Renamed', version: 2 });
		expect((await dashboard('PATCH', `/v1/dashboard/configurators/${created.json.id}`, session, { name: 'x' })).status).toBe(
			422,
		);
		expect((await dashboard('PATCH', '/v1/dashboard/configurators/cfg_none', session, { version: 1 })).status).toBe(404);
		expect((await dashboard('POST', '/v1/dashboard/configurators:check', session, PHONE)).json.valid).toBe(true);
		expect((await dashboard('POST', '/v1/dashboard/configurators:check', session, /** @type {any} */ ('x'))).status).toBe(422);
		const preview = await dashboard('POST', '/v1/dashboard/evaluations', session, {
			configurator: created.json.id,
			selection: { color: 'gold' },
			changed: 'color',
		});
		expect(preview.json.selection).toEqual({ storage: '512', color: 'gold' });
		expect((await dashboard('POST', '/v1/dashboard/evaluations', session, { configurator: 'nope' })).status).toBe(404);
		expect(
			(await dashboard('POST', '/v1/dashboard/evaluations', session, { configurator: 'phone-x', quantity: -1 })).status,
		).toBe(422);
		const overview = await dashboard('GET', '/v1/dashboard/overview', session);
		expect(overview.json).toEqual({ configurators: { published: 1 }, catalogItems: 0 });
		expect(
			(await dashboard('POST', '/v1/dashboard/rules:check', session, { source: "selection.size == 'M'" })).json,
		).toMatchObject({ ok: true, paths: ['selection.size'] });
		expect((await dashboard('POST', '/v1/dashboard/rules:check', session, {})).status).toBe(422);
	});

	it('answers "open the dashboard for a website" without a website and refuses demo writes', async () => {
		const unscoped = await h.session({ scope: { merchantId: MERCHANT } });
		/** @param {string} method @param {string} path @param {unknown} [body] */
		const bare = async (method, path, body) => {
			const response = await h.handle(
				new Request(`https://configurator.example.com${path}`, {
					method,
					headers: {
						cookie: `ss_session=${unscoped}`,
						'content-type': 'application/json',
						'idempotency-key': `idk-${Math.random()}`,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
			return response.status;
		};
		expect(await bare('GET', '/v1/dashboard/overview')).toBe(400);
		expect(await bare('POST', '/v1/dashboard/configurators', PHONE)).toBe(400);
		expect(await bare('PATCH', '/v1/dashboard/configurators/x', { version: 1 })).toBe(400);
		expect(await bare('POST', '/v1/dashboard/configurators:check', PHONE)).toBe(400);
		expect(await bare('POST', '/v1/dashboard/evaluations', { configurator: 'x' })).toBe(400);
		const demo = await h.session({ kind: 'demo' });
		const refused = await h.handle(
			new Request('https://configurator.example.com/v1/dashboard/configurators', {
				method: 'POST',
				headers: { cookie: `ss_session=${demo}`, 'content-type': 'application/json', 'idempotency-key': 'idk-demo' },
				body: JSON.stringify(PHONE),
			}),
		);
		expect(refused.status).toBe(403);
	});
});

describe('dashboard pages data (resolveDashboard)', () => {
	it('covers every session state', async () => {
		const { configurator } = h;
		expect(await resolveDashboard({ configurator, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ configurator, sessionId: 'ses_unknown' })).toEqual({ state: 'signin' });
		const demo = await resolveDashboard({ configurator, sessionId: await h.session({ kind: 'demo' }), now: T0 });
		expect(demo.state === 'ready' && demo.data.demo).toBe(true);
		const unscoped = await resolveDashboard({ configurator, sessionId: await h.session({ scope: { merchantId: MERCHANT } }) });
		expect(unscoped.state).toBe('pick_website');
		const other = await resolveDashboard({
			configurator,
			sessionId: await h.session({ scope: { merchantId: MERCHANT, websiteIds: [WEBSITE_2] } }),
		});
		expect(other.state).toBe('not_subscribed');
		const live = await resolveDashboard({ configurator, sessionId: await h.session(), website: WEBSITE });
		if (live.state !== 'ready') throw new Error(live.state);
		expect(live).toMatchObject({ data: { demo: false, canWrite: true, websiteId: WEBSITE } });
		expect(live.portalLink).toBe(`https://portal.test/websites/${WEBSITE}/subscriptions/sub_0123456789abcdefghjkmnpq`);
		const list = await live.data.list();
		expect(list.length).toBeGreaterThan(0);
		const one = await live.data.get(/** @type {any} */ (list[0]).id);
		expect(one?.preview?.schema.groups.length).toBe(3);
		expect(one?.problem).toBeNull();
		expect(await live.data.get('cfg_none')).toBeNull();
		expect(await live.data.overview()).toMatchObject({ catalogItems: 0 });
		expect(await live.data.items()).toEqual([]);
		const linked = await h.call('POST', '/v1/configurators', {
			body: { name: 'Linked', source: { type: 'catalog', itemId: 'itm_missing' }, groups: [{ key: 'size' }] },
		});
		const broken = await live.data.get(linked.json.id);
		expect(broken).toMatchObject({ preview: null, problem: 'catalog_item_unavailable' });
		await h.call('DELETE', `/v1/configurators/${linked.json.id}`);
		expect(await live.data.get(linked.json.id)).toMatchObject({ preview: null, problem: null });
	});

	it('builds the demo from the samples, read-only', async () => {
		const demo = demoDashboard({ now: T0 });
		expect(demo).toMatchObject({ demo: true, canWrite: false, websiteId: null });
		expect((await demo.list()).map((row) => row.key)).toEqual(['classic-tee', 'workstation', 'team-plan']);
		expect(await demo.overview()).toEqual({ configurators: { published: 3 }, catalogItems: 0 });
		expect((await demo.get('team-plan'))?.preview?.schema.groups.map((group) => group.key)).toEqual([
			'plan',
			'seats',
			'addons',
		]);
		expect(await demo.get('nope')).toBeNull();
		expect(await demo.items()).toEqual([]);
		expect(demo.settings.enabled('widget')).toBe(true);
	});
});

describe('helpers', () => {
	it('describe sessions, actors, settings, problems and strings', () => {
		expect(sessionView({ kind: 'admin', role: 'platform_admin', subject: 'stf_1', scope: { actor: 'stf_1' } })).toEqual({
			kind: 'admin',
			role: 'platform_admin',
			scope: { actor: 'stf_1' },
			user: 'stf_1',
			actor: 'stf_1',
		});
		expect(sessionView({ kind: 'demo', role: 'demo' })).toMatchObject({ user: null, actor: null, scope: {} });
		expect(actorOf({ actor: 'stf_1', kind: 'impersonate', user: 'usr_1' })).toEqual({ type: 'staff', id: 'stf_1' });
		expect(actorOf({ actor: null, kind: 'admin', user: null })).toEqual({ type: 'staff', id: 'unknown' });
		expect(actorOf({ actor: null, kind: 'merchant', user: 'usr_1' })).toEqual({ type: 'merchant', id: 'usr_1' });
		const settings = settingsFrom({
			can: () => false,
			config: () => null,
			website: { currency: 'JPY', timeZone: 'Asia/Tokyo', language: 'ja' },
		});
		expect(settings.website).toEqual({ currency: 'JPY', timeZone: 'Asia/Tokyo', language: 'ja' });
		expect(settings.resolver).toMatchObject({ inStock: 'prefer', timeZone: 'Asia/Tokyo', maxSteps: 20000 });
		expect(settingsFrom({ can: () => true, config: () => ({}) }).website).toEqual({
			currency: null,
			timeZone: 'UTC',
			language: null,
		});
		const t = createTranslator({ greeting: 'Hi {name}, {missing}' });
		expect(t('greeting', { name: 'Ada' })).toBe('Hi Ada, {missing}');
		expect(t('absent.key')).toBe('absent.key');
	});
});
