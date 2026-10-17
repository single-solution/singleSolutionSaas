import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT } from '@ss/contracts/format';
import { defineRoute } from '../src/index.js';
import { SETTINGS_READ_LIMIT, SETTINGS_WRITE_LIMIT } from '../src/server-api.js';
import { DOMAIN, openDb, productRoutes, setup } from './helpers.js';

const SITE = `https://${DOMAIN}`;
/** Alex, signed in at Accounts as an Owner (the test harness turns these into the sign-in's person). */
const ACTOR = { 'ss-actor-id': 'usr_1', 'ss-actor-name': 'Alex%20M.', 'ss-actor-role': 'Owner' };
/** The staff member every other call of the harness is signed in as. */
const STAFF = { kind: 'user', id: 'usr_test_staff', name: 'Test Staff', role: 'owner' };

/** A product list setting kept in memory (Chat's and Ecommerce's lists keep theirs in the product database). */
const memoryLists = () => {
	/** @type {Map<string, unknown>} */
	const saved = new Map();
	return {
		labels: {
			feature: 'inbox',
			title: 'Labels',
			get: async (/** @type {string} */ websiteId) => saved.get(websiteId) ?? [],
			save: async (/** @type {string} */ websiteId, /** @type {unknown} */ value) => {
				if (!Array.isArray(value)) return { ok: /** @type {const} */ (false), errors: ['The list is an array.'] };
				if (value.some((item) => typeof item !== 'string'))
					return { ok: /** @type {const} */ (false), errors: [{ path: '/value/0', message: 'Each label is text.' }] };
				if (new Set(value).size !== value.length)
					return {
						ok: /** @type {const} */ (false),
						errors: [{ path: '/value', message: 'A label is twice in the list.', code: 'duplicate' }],
					};
				saved.set(websiteId, value);
				return { ok: /** @type {const} */ (true), value };
			},
		},
	};
};

/** @param {Response} response */
const body = async (response) => ({ status: response.status, json: await response.json() });

describe('settings API for the merchant’s server (K1)', () => {
	it('lists features and the settings of switched-on features only', async () => {
		const { call, server, switchOn } = await setup();
		await switchOn(['notes']);
		const features = await body(await call('GET', '/v1/features', { token: server.token }));
		expect(features.status).toBe(200);
		expect(features.json.features).toEqual([
			{ key: 'notes', name: 'Notes', description: 'Visitors leave short notes.', on: true, millicreditsPerHour: 0 },
			{
				key: 'inbox',
				name: 'Notes inbox',
				description: 'Staff read the notes in their own admin.',
				on: false,
				millicreditsPerHour: 0,
			},
		]);
		const settings = await body(await call('GET', '/v1/settings', { token: server.token }));
		expect(settings.json.features[0]).toMatchObject({
			key: 'notes',
			on: true,
			values: { maxNotes: { value: 5, source: 'built-in' }, greeting: { value: 'Leave us a note', source: 'built-in' } },
		});
		expect(settings.json.features[0].schema.properties.maxNotes.maximum).toBe(50);
		expect(settings.json.features[1]).toMatchObject({ key: 'inbox', on: false, values: null });
		// server token only
		expect((await call('GET', '/v1/settings', { token: server.token, origin: SITE })).status).toBe(401);
	});

	it('saves, checks and resets settings as the acting user, and refuses switched-off features', async () => {
		const { call, server, switchOn, session, dash, websiteId, clock } = await setup();
		await switchOn(['notes']);
		clock.advance(1000);
		const saved = await body(
			await call('PUT', '/v1/settings/notes.maxNotes', { token: server.token, headers: ACTOR, body: { value: 9 } }),
		);
		expect(saved).toEqual({ status: 200, json: { key: 'notes.maxNotes', value: 9, source: 'website' } });
		const invalid = await body(await call('PUT', '/v1/settings/notes.maxNotes', { token: server.token, body: { value: 99 } }));
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.length).toBeGreaterThan(0);
		expect((await call('PUT', '/v1/settings/notes.maxNotes', { token: server.token, body: { value: null } })).status).toBe(422);
		expect((await call('PUT', '/v1/settings/notes.maxNotes', { token: server.token, body: {} })).status).toBe(422);
		expect((await call('PUT', '/v1/settings/notes.maxNotes', { token: server.token, body: [] })).status).toBe(400);
		const off = await body(await call('PUT', '/v1/settings/inbox.sort', { token: server.token, body: { value: 'oldest' } }));
		expect(off.status).toBe(403);
		expect(off.json.type).toMatch(/feature_off$/);
		expect((await call('PUT', '/v1/settings/notes.nope', { token: server.token, body: { value: 1 } })).status).toBe(404);
		expect((await call('PUT', '/v1/settings/nope', { token: server.token, body: { value: 1 } })).status).toBe(404);
		clock.advance(1000);
		const reset = await body(await call('DELETE', '/v1/settings/notes.maxNotes', { token: server.token }));
		expect(reset.json).toEqual({ key: 'notes.maxNotes', value: 5, source: 'built-in' });
		// Recent changes name the signed-in staff member
		const cookie = await session({ kind: 'merchant' });
		const overview = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		// (the harness pasted the Accounts token from an admin session first: not a change of these two)
		expect(
			overview.recentChanges.map((/** @type {any} */ c) => c.who).filter((/** @type {any} */ who) => who.kind === 'user'),
		).toEqual([STAFF, { kind: 'user', id: 'usr_1', name: 'Alex M.', role: 'Owner' }]);
	});

	it('edits widget texts, the theme and the Format', async () => {
		const { call, server, product, websiteId } = await setup();
		const texts = await body(await call('GET', '/v1/texts', { token: server.token }));
		expect(texts.json.texts[0]).toEqual({
			key: 'form.title',
			english: 'Leave a note',
			value: 'Leave a note',
			source: 'built-in',
		});
		const text = await body(
			await call('PUT', '/v1/texts/form.title', { token: server.token, body: { value: 'Écrivez-nous' } }),
		);
		expect(text.json).toEqual({ key: 'form.title', english: 'Leave a note', value: 'Écrivez-nous', source: 'website' });
		expect(
			(await call('PUT', '/v1/texts/form.count', { token: server.token, body: { value: 'No placeholders' } })).status,
		).toBe(422);
		expect((await call('PUT', '/v1/texts/nope', { token: server.token, body: { value: 'x' } })).status).toBe(404);
		expect((await body(await call('DELETE', '/v1/texts/form.title', { token: server.token }))).json.source).toBe('built-in');

		const theme = await body(await call('PUT', '/v1/theme', { token: server.token, body: { radius: 12, mode: 'dark' } }));
		expect(theme.json.theme).toMatchObject({ radius: 12, mode: 'dark' });
		expect(theme.json.sources).toMatchObject({ radius: 'website', fontFamily: 'built-in' });
		expect((await call('PUT', '/v1/theme', { token: server.token, body: { radius: 99 } })).status).toBe(422);
		expect((await body(await call('GET', '/v1/theme', { token: server.token }))).json.theme.radius).toBe(12);

		expect((await body(await call('GET', '/v1/format', { token: server.token }))).json.format).toEqual(DEFAULT_FORMAT);
		const format = await body(
			await call('PUT', '/v1/format', {
				token: server.token,
				body: {
					locale: 'en-GB',
					currencyDisplay: 'symbol',
					currencySymbols: { CHF: 'Fr.' },
					wholeUnits: true,
					times: 'business',
				},
			}),
		);
		expect(format.json).toEqual({
			format: {
				locale: 'en-GB',
				currencyDisplay: 'symbol',
				currencySymbols: { CHF: 'Fr.' },
				wholeUnits: true,
				times: 'business',
			},
			sources: {
				locale: 'website',
				currencyDisplay: 'website',
				currencySymbols: 'website',
				wholeUnits: 'website',
				times: 'website',
			},
		});
		const refused = await body(await call('PUT', '/v1/format', { token: server.token, body: { times: 'utc' } }));
		expect(refused.status).toBe(422);
		expect(refused.json.errors[0].path).toBe('/times');
		expect((await call('PUT', '/v1/format', { token: server.token, body: {} })).status).toBe(422);
		expect((await call('PUT', '/v1/format', { token: server.token, body: { locale: null } })).status).toBe(200);
		const formatted = await product.format(websiteId);
		expect(formatted.format.locale).toBe('');
		expect(formatted.timeZone).toBe('UTC');
		expect(formatted.money(1_250_050, 'CHF')).toBe('Fr. 12,501');
		expect(formatted.date('2026-03-12T19:30:00Z', 'date')).toBe('Mar 12, 2026');
		expect(formatted.date('2026-03-12T19:30:00Z')).toBe('Mar 12, 2026, 7:30 PM');
	});

	it('reads and saves whole lists with the product’s own check while their feature is on', async () => {
		const { call, server, switchOn, session, dash, websiteId, clock } = await setup({ lists: memoryLists() });
		expect((await body(await call('GET', '/v1/lists/labels', { token: server.token }))).json).toEqual({ value: [] });
		expect((await call('PUT', '/v1/lists/labels', { token: server.token, body: { value: ['a'] } })).status).toBe(403);
		await switchOn(['notes', 'inbox']);
		clock.advance(1000);
		const saved = await body(
			await call('PUT', '/v1/lists/labels', { token: server.token, headers: ACTOR, body: { value: ['vip', 'late'] } }),
		);
		expect(saved).toEqual({ status: 200, json: { value: ['vip', 'late'] } });
		expect((await body(await call('GET', '/v1/lists/labels', { token: server.token }))).json.value).toEqual(['vip', 'late']);
		const invalid = await body(await call('PUT', '/v1/lists/labels', { token: server.token, body: { value: [1] } }));
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors).toEqual([{ path: '/value/0', message: 'Each label is text.' }]);
		expect(
			(await body(await call('PUT', '/v1/lists/labels', { token: server.token, body: { value: 'x' } }))).json.errors,
		).toEqual([{ path: '/value', message: 'The list is an array.' }]);
		// an error's code the product gave is answered as given
		const twice = await body(await call('PUT', '/v1/lists/labels', { token: server.token, body: { value: ['a', 'a'] } }));
		expect(twice.json.errors).toEqual([{ path: '/value', message: 'A label is twice in the list.', code: 'duplicate' }]);
		expect((await call('GET', '/v1/lists/nope', { token: server.token })).status).toBe(404);
		const cookie = await session({ kind: 'merchant' });
		const overview = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		expect(overview.recentChanges[0]).toMatchObject({
			what: 'settings',
			detail: 'Labels: changed',
			who: { kind: 'user', name: 'Alex M.' },
		});
	});

	it('serves the dashboard twin of the lists with the same rules; Owner and Support may prepare a switched-off one', async () => {
		const { call, session, dash, websiteId, switchOn, clock, settle } = await setup({ lists: memoryLists() });
		const path = `/v1/dashboard/websites/${websiteId}/lists/labels`;
		const merchant = await session({ kind: 'merchant' });
		expect(await body(await dash(merchant, 'GET', path))).toEqual({ status: 200, json: { value: [] } });
		expect(await body(await dash(merchant, 'PUT', path, { value: ['vip'] }))).toMatchObject({
			status: 403,
			json: { detail: 'The feature inbox is off: its lists cannot be changed.' },
		});
		const owner = await session({ kind: 'admin', role: 'owner' });
		clock.advance(1000);
		expect(await body(await dash(owner, 'PUT', path, { value: ['prepared'] }))).toEqual({
			status: 200,
			json: { value: ['prepared'] },
		});
		await switchOn(['notes', 'inbox']);
		clock.advance(1000);
		expect(await body(await dash(merchant, 'PUT', path, { value: ['vip', 'late'] }))).toEqual({
			status: 200,
			json: { value: ['vip', 'late'] },
		});
		const invalid = await body(await dash(merchant, 'PUT', path, { value: [1] }));
		expect(invalid).toMatchObject({ status: 422, json: { errors: [{ path: '/value/0', message: 'Each label is text.' }] } });
		const twice = await body(await dash(merchant, 'PUT', path, { value: ['a', 'a'] }));
		expect(twice).toMatchObject({ status: 422, json: { errors: [{ path: '/value', code: 'duplicate' }] } });
		expect((await dash(merchant, 'PUT', path, { items: [] })).status).toBe(422);
		expect((await dash(merchant, 'GET', `/v1/dashboard/websites/${websiteId}/lists/nope`)).status).toBe(404);
		// a session is needed, and writes come from the product's own address
		expect((await call('GET', path)).status).toBe(401);
		expect((await call('PUT', path, { cookie: merchant, body: { value: [] } })).status).toBe(403);
		await settle();
		const overview = await (await dash(owner, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		expect(overview.recentChanges.slice(0, 2)).toMatchObject([
			{ what: 'settings', detail: 'Labels: changed', who: { kind: 'merchant' } },
			{ what: 'settings', detail: 'Labels: changed', who: { kind: 'admin', role: 'owner' } },
		]);
	});

	it('takes at most 60 dashboard list saves per minute per website, in a window of their own', async () => {
		const { session, dash, websiteId, switchOn, call, server } = await setup({ lists: memoryLists() });
		await switchOn(['notes', 'inbox']);
		const merchant = await session({ kind: 'merchant' });
		const path = `/v1/dashboard/websites/${websiteId}/lists/labels`;
		for (let i = 0; i < 60; i += 1) expect((await dash(merchant, 'PUT', path, { value: [] })).status).toBe(200);
		expect((await dash(merchant, 'PUT', path, { value: [] })).status).toBe(429);
		expect((await call('PUT', '/v1/lists/labels', { token: server.token, body: { value: [] } })).status).toBe(200);
	});

	it('manages connections without ever answering secrets', async () => {
		const { call, server } = await setup({
			connections: {
				ai: {
					label: 'AI provider key',
					kind: 'secret',
					neededBy: ['notes'],
					test: async (/** @type {any} */ value) =>
						value === 'bad-key-0000' ? { ok: false, message: 'Key refused' } : { ok: true },
				},
			},
		});
		const listed = await body(await call('GET', '/v1/connections', { token: server.token }));
		expect(listed.json.connections.find((/** @type {any} */ c) => c.name === 'ai')).toEqual({
			name: 'ai',
			label: 'AI provider key',
			kind: 'secret',
			neededBy: ['notes'],
			set: false,
			state: 'not_connected',
			message: null,
			testedAt: null,
		});
		const saved = await body(
			await call('PUT', '/v1/connections/ai', { token: server.token, body: { value: 'sk-secret-1234' } }),
		);
		expect(saved.json).toMatchObject({ name: 'ai', state: 'connected', set: true, message: null });
		// the value never comes back, not even its last characters
		expect(JSON.stringify(saved.json)).not.toContain('sk-secret');
		expect(JSON.stringify(saved.json)).not.toContain('1234');
		const failed = await body(
			await call('PUT', '/v1/connections/ai', { token: server.token, body: { value: 'bad-key-0000' } }),
		);
		expect(failed.json).toMatchObject({ state: 'test_failed', message: 'Key refused' });
		expect((await body(await call('POST', '/v1/connections/ai/test', { token: server.token }))).json.state).toBe('test_failed');
		expect((await call('PUT', '/v1/connections/nope', { token: server.token, body: { value: 'x' } })).status).toBe(404);
		expect((await call('POST', '/v1/connections/nope/test', { token: server.token })).status).toBe(404);
		expect((await call('DELETE', '/v1/connections/ai', { token: server.token })).status).toBe(204);
		expect((await call('DELETE', '/v1/connections/nope', { token: server.token })).status).toBe(404);
		expect((await call('POST', '/v1/connections/ai/test', { token: server.token })).status).toBe(404);
	});

	it('writes every settings save to the activity log, by who saved it (parity: the Activity screen shows them)', async () => {
		const { call, server, switchOn, connectDatabase, session, dash, websiteId, clock, settle } = await setup({
			lists: memoryLists(),
		});
		await switchOn(['notes', 'inbox']);
		await connectDatabase();
		/** @type {Array<[string, string, Record<string, unknown> | undefined]>} */
		const saves = [
			['PUT', '/v1/settings/notes.maxNotes', { value: 9 }],
			['DELETE', '/v1/settings/notes.maxNotes', undefined],
			['PUT', '/v1/texts/form.title', { value: 'Write to us' }],
			['PUT', '/v1/theme', { radius: 4, mode: 'dark' }],
			['PUT', '/v1/format', { wholeUnits: true }],
			['PUT', '/v1/lists/labels', { value: ['vip'] }],
		];
		for (const [method, path, sent] of saves) {
			clock.advance(1000);
			const headers = method === 'DELETE' ? {} : ACTOR;
			expect((await call(method, path, { token: server.token, headers, ...(sent ? { body: sent } : {}) })).status).toBe(200);
		}
		// a save from the dashboard names the dashboard's person
		clock.advance(1000);
		const merchant = await session({ kind: 'merchant' });
		expect(
			(await dash(merchant, 'PUT', `/v1/dashboard/websites/${websiteId}/settings/notes.greeting`, { value: 'Hi' })).status,
		).toBe(204);
		await settle();
		const log = (await body(await call('GET', '/v1/activity?action=settings.changed', { token: server.token }))).json;
		const user = { kind: 'user', id: 'usr_1', name: 'Alex M.', role: 'Owner' };
		expect(log.items.map((/** @type {any} */ e) => [e.actor, e.target, e.label, e.detail])).toEqual([
			[
				{ kind: 'merchant', id: expect.any(String), name: expect.any(String) },
				'settings.notes.greeting',
				'Notes › Greeting',
				'changed',
			],
			[user, 'list.labels', 'Labels', 'changed'],
			[user, 'format', 'Format', 'wholeUnits changed'],
			[user, 'theme', 'Theme', 'radius, mode changed'],
			[user, 'texts.form.title', 'Text form.title', 'changed'],
			[
				{ kind: 'user', id: 'usr_test_staff', name: 'Test Staff', role: 'owner' },
				'settings.notes.maxNotes',
				'Notes › Notes per visitor per day',
				'reset to default',
			],
			[user, 'settings.notes.maxNotes', 'Notes › Notes per visitor per day', 'changed'],
		]);
	});

	it('takes 3,000 reads per minute per route and website (the SEO read window)', async () => {
		const { call, server, clock } = await setup();
		expect(SETTINGS_READ_LIMIT).toEqual({ limit: 3000, windowSeconds: 60, per: 'website' });
		for (let i = 0; i < SETTINGS_READ_LIMIT.limit; i += 1)
			expect((await call('GET', '/v1/theme', { token: server.token })).status).toBe(200);
		expect((await call('GET', '/v1/theme', { token: server.token })).status).toBe(429);
		// each route has its own window
		expect((await call('GET', '/v1/texts', { token: server.token })).status).toBe(200);
		clock.advance(60_000);
		expect((await call('GET', '/v1/theme', { token: server.token })).status).toBe(200);
	}, 60_000);

	it('takes at most 60 writes per minute per website', async () => {
		const { call, server, clock } = await setup();
		expect(SETTINGS_WRITE_LIMIT).toMatchObject({ limit: 60, windowSeconds: 60, per: 'website' });
		for (let i = 0; i < 30; i += 1) {
			expect((await call('PUT', '/v1/theme', { token: server.token, body: { radius: i % 20 } })).status).toBe(200);
			expect((await call('PUT', '/v1/format', { token: server.token, body: { wholeUnits: i % 2 === 0 } })).status).toBe(200);
		}
		expect((await call('DELETE', '/v1/texts/form.title', { token: server.token })).status).toBe(429);
		expect((await call('GET', '/v1/theme', { token: server.token })).status).toBe(200);
		clock.advance(60_000);
		expect((await call('DELETE', '/v1/texts/form.title', { token: server.token })).status).toBe(200);
	});
});

describe('shared settings (several features use one setting)', () => {
	const sharedSettings = {
		layout: {
			name: 'Layout',
			features: ['notes', 'inbox'],
			settings: {
				type: 'object',
				additionalProperties: false,
				properties: { columns: { type: 'integer', title: 'Columns', default: 2, minimum: 1, maximum: 4 } },
			},
		},
	};

	it('stores one value under the group, shown and editable while any of its features is on', async () => {
		const { call, server, switchOn, session, dash, websiteId, product } = await setup({ sharedSettings });
		const merchant = await session({ kind: 'merchant' });
		const listed = async () =>
			(await (await dash(merchant, 'GET', `/v1/dashboard/websites/${websiteId}/settings`)).json()).features.map(
				(/** @type {{ key: string }} */ f) => f.key,
			);
		expect(await listed()).toEqual([]);
		const refused = await dash(merchant, 'PUT', `/v1/dashboard/websites/${websiteId}/settings/layout.columns`, { value: 3 });
		expect(refused.status).toBe(403);
		expect((await call('PUT', '/v1/settings/layout.columns', { token: server.token, body: { value: 3 } })).status).toBe(403);
		await switchOn(['notes']);
		expect(await listed()).toEqual(['notes', 'layout']);
		const saved = await dash(merchant, 'PUT', `/v1/dashboard/websites/${websiteId}/settings/layout.columns`, { value: 3 });
		expect(saved.status).toBe(204);
		expect(await product.settings.values(websiteId, 'layout')).toEqual({ columns: 3 });
		const api = await (await call('GET', '/v1/settings', { token: server.token })).json();
		expect(api.features.at(-1)).toMatchObject({ key: 'layout', name: 'Layout', on: true, values: { columns: { value: 3 } } });
		const put = await call('PUT', '/v1/settings/layout.columns', { token: server.token, body: { value: 4 } });
		expect(await put.json()).toEqual({ key: 'layout.columns', value: 4, source: 'website' });
		await switchOn(['notes', 'inbox']);
		expect(await listed()).toEqual(['notes', 'inbox', 'layout']);
		await switchOn([]);
		expect(await listed()).toEqual([]);
		expect(await product.settings.values(websiteId, 'layout')).toEqual({ columns: 4 });
		const admin = await session();
		const defaults = await (await dash(admin, 'GET', '/v1/dashboard/defaults')).json();
		expect(defaults.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(['notes', 'inbox', 'layout']);
		expect((await dash(admin, 'PUT', '/v1/dashboard/defaults/layout.columns', { value: 1 })).status).toBe(204);
	});

	it('refuses shared settings that clash with a feature or name unknown features', async () => {
		const settings = { type: 'object', properties: {} };
		await expect(setup({ sharedSettings: { notes: { name: 'x', features: ['inbox'], settings } } })).rejects.toThrow(
			/shared settings/,
		);
		await expect(setup({ sharedSettings: { other: { name: 'x', features: ['nope'], settings } } })).rejects.toThrow(
			/shared settings/,
		);
		await expect(setup({ sharedSettings: { other: { name: 'x', features: [], settings } } })).rejects.toThrow(
			/shared settings/,
		);
		// a shape the settings contract refuses (here a text pattern) is refused for shared settings too
		const patterned = {
			type: 'object',
			properties: { code: { type: 'string', title: 'Code', default: '', pattern: '^[0-9]+$' } },
		};
		await expect(setup({ sharedSettings: { other: { name: 'x', features: ['inbox'], settings: patterned } } })).rejects.toThrow(
			/not a valid settings schema/,
		);
	});
});

describe('Format in the dashboard and the widgets (K7)', () => {
	it('is edited per website and as a global default, and reaches the widget config with the time zone', async () => {
		const { session, dash, websiteId, call, browser, switchOn, connectDatabase } = await setup();
		const cookie = await session({ kind: 'merchant' });
		const path = `/v1/dashboard/websites/${websiteId}/format`;
		expect((await (await dash(cookie, 'GET', path)).json()).format).toEqual(DEFAULT_FORMAT);
		expect((await dash(cookie, 'PUT', path, { currencyDisplay: 'symbol' })).status).toBe(200);
		expect((await dash(cookie, 'PUT', path, { currencyDisplay: 'name' })).status).toBe(422);
		const owner = await session({ kind: 'admin', role: 'owner', websiteId: null });
		expect((await dash(owner, 'PUT', '/v1/dashboard/defaults/format', { value: { wholeUnits: true } })).status).toBe(204);
		expect((await dash(owner, 'PUT', '/v1/dashboard/defaults/format', { value: { wholeUnits: 'x' } })).status).toBe(422);
		const defaults = await (await dash(owner, 'GET', '/v1/dashboard/defaults')).json();
		expect(defaults.format.format.wholeUnits).toBe(true);
		expect(defaults.format.sources.wholeUnits).toBe('default');
		const merged = await (await dash(cookie, 'GET', path)).json();
		expect(merged.format).toMatchObject({ currencyDisplay: 'symbol', wholeUnits: true });
		expect(merged.sources).toMatchObject({ currencyDisplay: 'website', wholeUnits: 'default', times: 'built-in' });
		await switchOn(['notes']);
		await connectDatabase();
		const config = await (await call('GET', '/v1/widget/config', { token: browser.token, origin: SITE })).json();
		expect(config.format).toMatchObject({ currencyDisplay: 'symbol', wholeUnits: true });
		expect(config.timeZone).toBe('UTC');
	});
});

describe('activity reads (K9)', () => {
	/** @type {{ product: any }} */
	const holder = { product: null };
	const routes = () => [
		...productRoutes(),
		defineRoute({
			method: 'POST',
			path: '/v1/log',
			auth: 'server',
			runtime: true,
			handler: async (ctx) => {
				const body = /** @type {any} */ (ctx.body);
				await holder.product.activity.record(ctx, body);
				return { logged: true };
			},
		}),
	];

	it('serves the log newest first with filters, paging and counts; copies carry label, detail and role', async () => {
		const ctx = await setup({
			routes: routes(),
			connections: { accounts: { label: 'Accounts token', kind: 'token', productId: 'accounts', neededBy: [] } },
		});
		holder.product = ctx.product;
		const { call, server, connectDatabase, clock, settle, session, dash, websiteId, portal, accounts } = ctx;
		await connectDatabase();
		const cookie = await session({ kind: 'merchant' });
		await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, {
			value: (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token,
		});
		const sam = { kind: 'user', id: 'usr_1', name: 'Sam', role: 'Support staff' };
		const tia = { kind: 'staff', id: 'stf_2', name: 'Tia' };
		const entries = [
			{ actor: sam, action: 'order.status_changed', target: 'ord_1', label: 'SH-2026-0001', detail: 'placed → confirmed' },
			{ actor: tia, action: 'order.status_changed', target: 'ord_2', label: 'SH-2026-0002', detail: 'confirmed → packed' },
			{ actor: sam, action: 'order.refunded', target: 'ord_1', label: 'SH-2026-0001', detail: 'x'.repeat(2100) },
			{
				actor: { kind: 'server', id: 'server', name: 'Server' },
				action: 'catalog.changed',
				target: 'prd_9',
				label: 'L'.repeat(300),
			},
		];
		for (const entry of entries) {
			expect((await call('POST', '/v1/log', { token: server.token, body: entry })).status).toBe(200);
			clock.advance(60 * 60_000);
		}
		await settle();
		expect(accounts.copies[0]?.copy).toMatchObject({
			actor: sam,
			action: 'order.status_changed',
			label: 'SH-2026-0001',
			detail: 'placed → confirmed',
		});
		const all = await body(await call('GET', '/v1/activity', { token: server.token }));
		expect(all.json.items.map((/** @type {any} */ e) => e.action)).toEqual([
			'catalog.changed',
			'order.refunded',
			'order.status_changed',
			'order.status_changed',
		]);
		expect(all.json.items[0]).toMatchObject({ actor: { kind: 'server' }, label: 'L'.repeat(200), detail: null });
		expect(all.json.items[1].detail).toHaveLength(2000);
		expect(all.json.items[0].id).toMatch(/^act_/);
		const page1 = await call('GET', '/v1/activity?limit=3', { token: server.token });
		expect(page1.headers.get('link')).toMatch(/rel="next"/);
		const first = await page1.json();
		expect(first.items).toHaveLength(3);
		const page2 = await body(await call('GET', `/v1/activity?limit=3&cursor=${first.nextCursor}`, { token: server.token }));
		expect(page2.json.items.map((/** @type {any} */ e) => e.label)).toEqual(['SH-2026-0001']);
		expect(page2.json.hasMore).toBe(false);
		const filtered = async (/** @type {string} */ query) =>
			(await body(await call('GET', `/v1/activity?${query}`, { token: server.token }))).json;
		expect((await filtered('actor=usr_1')).items).toHaveLength(2);
		expect((await filtered('target=ord_1&action=order.refunded')).items).toHaveLength(1);
		expect((await filtered('action=order.refunded,catalog.changed')).items).toHaveLength(2);
		expect((await filtered('q=sh-2026-0002')).items.map((/** @type {any} */ e) => e.target)).toEqual(['ord_2']);
		expect((await filtered('q=Tia')).items).toHaveLength(1);
		// the search holds on every page (the cursor's keyset does not replace it)
		const searched = await filtered('q=sh-2026-0001&limit=1');
		expect(searched.items.map((/** @type {any} */ e) => e.action)).toEqual(['order.refunded']);
		const searchedNext = await filtered(`q=sh-2026-0001&limit=1&cursor=${searched.nextCursor}`);
		expect(searchedNext.items.map((/** @type {any} */ e) => e.label)).toEqual(['SH-2026-0001']);
		expect(searchedNext.hasMore).toBe(false);
		expect((await filtered('from=2026-10-01T11:30:00Z&to=2026-10-01T12:30:00Z')).items).toHaveLength(1);
		expect((await filtered('from=2026-10-01&to=2026-10-01')).items).toHaveLength(4);
		expect((await filtered('from=2026-10-02')).items).toHaveLength(0);
		for (const query of [
			'from=yesterday',
			'to=2026-13-01',
			'action=Bad Action',
			`actor=${'a'.repeat(300)}`,
			`target=${'t'.repeat(300)}`,
		])
			expect((await call('GET', `/v1/activity?${query}`, { token: server.token })).status).toBe(422);
		expect((await body(await call('GET', '/v1/activity/count?actor=usr_1', { token: server.token }))).json).toEqual({
			count: 2,
			capped: false,
		});
		expect((await body(await call('GET', '/v1/activity/counts?by=action', { token: server.token }))).json).toEqual({
			total: 4,
			groups: { 'order.status_changed': 2, 'catalog.changed': 1, 'order.refunded': 1 },
		});
		expect((await body(await call('GET', '/v1/activity/counts?by=kind', { token: server.token }))).json.groups).toEqual({
			user: 2,
			server: 1,
			staff: 1,
		});
		expect((await call('GET', '/v1/activity/counts?by=nope', { token: server.token })).status).toBe(422);
	});

	it('needs the merchant database', async () => {
		const { call, server } = await setup();
		expect((await call('GET', '/v1/activity', { token: server.token })).status).toBe(403);
		const dbless = await setup();
		const dbName = await dbless.connectDatabase();
		expect((await dbless.call('GET', '/v1/activity', { token: dbless.server.token })).status).toBe(200);
		const { client, db } = await openDb(dbName);
		expect((await db.collection('ss_notes_activity').indexes()).map((index) => index.name)).toEqual(
			expect.arrayContaining(['kit_activity_newest', 'kit_activity_actor', 'kit_activity_target', 'kit_activity_copies']),
		);
		await client.close();
	});
});
