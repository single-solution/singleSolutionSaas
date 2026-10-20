/**
 * Growth's staff routes and its kit configuration routes: the server token alone changes nothing (SEC). The redirect rules
 * are written by a staff member's verified sign-in with `redirects.edit`; the website's server still reads them
 * (`match`, `all`) with the server token alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
});
afterAll(async () => {
	await env.close();
});

/** @param {Response} response */
const typeOf = async (response) =>
	String((await response.json()).type ?? '')
		.split('/')
		.pop();

const RULE = { from: '/old-sec', to: '/new-sec' };

describe('every connection of the product (database, storage, provider keys, pasted product tokens)', () => {
	it('cannot be saved, removed or tested with the server token alone: 403, and the list stays as it was', async () => {
		const listed = await (await env.call('GET', '/v1/connections', { token: env.server })).json();
		const names = listed.connections.map((/** @type {{ name: string }} */ c) => c.name);
		expect(names).toContain('database');
		for (const name of names) {
			for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
				['PUT', `/v1/connections/${name}`, { value: 'attacker-value' }],
				['DELETE', `/v1/connections/${name}`, undefined],
				['POST', `/v1/connections/${name}/test`, undefined],
			])) {
				const refused = await env.call(method, path, {
					token: env.server,
					bare: true,
					...(body === undefined ? {} : { body }),
				});
				expect([
					name,
					method,
					refused.status,
					String((await refused.json()).type)
						.split('/')
						.pop(),
				]).toEqual([name, method, 403, 'needs_signed_in_staff']);
			}
		}
		const after = await (await env.call('GET', '/v1/connections', { token: env.server })).json();
		expect(after.connections).toEqual(listed.connections);
	});
});

describe('Growth’s writes with the server token', () => {
	it('alone: refused 403 needs_signed_in_staff (rules, settings, texts)', async () => {
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['POST', '/v1/redirects', RULE],
			['PATCH', '/v1/redirects/rdr_none', { to: '/x' }],
			['DELETE', '/v1/redirects/rdr_none', undefined],
			['POST', '/v1/redirects/csv', undefined],
			['POST', '/v1/seo/checks', { paths: ['/'] }],
			['PUT', '/v1/texts/consent.title', { value: 'x' }],
		])) {
			const refused = await env.call(method, path, { token: env.server, bare: true, ...(body === undefined ? {} : { body }) });
			expect([method, path, refused.status]).toEqual([method, path, 403]);
		}
		const refused = await env.call('POST', '/v1/redirects', { token: env.server, bare: true, body: RULE });
		expect([refused.status, await typeOf(refused)]).toEqual([403, 'needs_signed_in_staff']);
	});

	it('still serves the website: the rules are read, one address or all', async () => {
		const match = await env.call('GET', '/v1/redirects/match?path=/nothing', { token: env.server, bare: true });
		expect([200, 204]).toContain(match.status);
		expect((await env.call('GET', '/v1/redirects/all', { token: env.server, bare: true })).status).toBe(200);
	});

	it('with a staff sign-in that has redirects.edit: made, and logged with that person', async () => {
		const staff = { id: 'usr_sec1', name: 'Rita Redirect', permissions: ['growth:redirects.edit'] };
		const made = await env.call('POST', '/v1/redirects', { token: env.server, staff, body: RULE });
		expect(made.status).toBe(201);
		const logged = await (
			await env.merchantDb()
		)
			.collection('ss_growth_activity')
			.find({ action: 'redirect.created' })
			.toArray();
		expect(logged.at(-1)?.actor).toMatchObject({ kind: 'user', id: 'usr_sec1', name: 'Rita Redirect' });
	});

	it('with a staff sign-in without it (other permission, customer): refused 403 forbidden', async () => {
		for (const permissions of [[], ['growth:analytics.read'], ['ecommerce:redirects.edit']]) {
			const refused = await env.call('POST', '/v1/redirects', {
				token: env.server,
				staff: { permissions },
				body: { from: '/other', to: '/else' },
			});
			expect([JSON.stringify(permissions), refused.status, await typeOf(refused)]).toEqual([
				JSON.stringify(permissions),
				403,
				'forbidden',
			]);
		}
	});

	it('with the sign-in of another website: refused 401 invalid_sign_in', async () => {
		await env.staffHeaders(); // the website's Accounts token is pasted
		const other = await env.accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_x', permissions: ['*'] });
		const refused = await env.call('POST', '/v1/redirects', {
			token: env.server,
			bare: true,
			headers: { 'ss-sign-in': other },
			body: RULE,
		});
		expect([refused.status, await typeOf(refused)]).toEqual([401, 'invalid_sign_in']);
	});

	it('the dashboard session’s writes are unchanged', async () => {
		const cookie = await env.adminSession();
		const saved = await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/texts/consent.title`, {
			value: 'Your choice',
		});
		expect(saved.status).toBe(204);
	});
});

describe('custom scripts need their own permission, scripts.manage (SR-7-10)', () => {
	const EVIL = '<script src="https://evil.example/x.js"></script>';
	const settingsOnly = { id: 'usr_theme', name: 'Tess Theme', permissions: ['growth:settings.manage'] };
	const scripter = { id: 'usr_owner', name: 'Olga Owner', permissions: ['growth:settings.manage', 'growth:scripts.manage'] };
	const putCategories = (/** @type {Record<string, any>} */ staff, /** @type {unknown} */ value) =>
		env.call('PUT', '/v1/lists/consent_categories', { token: env.server, staff, body: { value } });
	const readCategories = async () =>
		(await (await env.call('GET', '/v1/lists/consent_categories', { token: env.server })).json()).value;

	it('a staff member with only settings.manage cannot put a script in, change one or remove one: 403, nothing saved', async () => {
		const before = await readCategories();
		const added = before.map((/** @type {any} */ c) => (c.key === 'marketing' ? { ...c, scripts: EVIL } : c));
		const refused = await putCategories(settingsOnly, added);
		expect([refused.status, await typeOf(refused)]).toEqual([403, 'forbidden']);
		expect(await readCategories()).toEqual(before);
		// the same for the people who can only name things: a ticket without it
		expect((await putCategories({ id: 'usr_none', permissions: [] }, added)).status).toBe(403);
	});

	it('still changes everything else of the categories (names, modes, signals, order)', async () => {
		const before = await readCategories();
		const renamed = before.map((/** @type {any} */ c) => (c.key === 'marketing' ? { ...c, name: 'Promotions' } : c));
		expect((await putCategories(settingsOnly, renamed)).status).toBe(200);
		expect((await readCategories()).find((/** @type {any} */ c) => c.key === 'marketing').name).toBe('Promotions');
	});

	it('with scripts.manage: saved, and the activity log names who changed the scripts', async () => {
		const before = await readCategories();
		const added = before.map((/** @type {any} */ c) =>
			c.key === 'analytics' ? { ...c, scripts: '<script>track()</script>' } : c,
		);
		expect((await putCategories(scripter, added)).status).toBe(200);
		const saved = await readCategories();
		expect(saved.find((/** @type {any} */ c) => c.key === 'analytics').scripts).toBe('<script>track()</script>');
		const logged = await (
			await env.merchantDb()
		)
			.collection('ss_growth_activity')
			.find({ action: 'settings.changed' })
			.toArray();
		expect(logged.at(-1)).toMatchObject({
			actor: { kind: 'user', id: 'usr_owner', name: 'Olga Owner' },
			target: 'list.consent_categories',
			detail: 'changed (scripts)',
		});
		// the scripts it saved cannot be removed or edited by who lacks it
		const wiped = saved.map((/** @type {any} */ c) => ({ ...c, scripts: '' }));
		expect((await putCategories(settingsOnly, wiped)).status).toBe(403);
		expect(await readCategories()).toEqual(saved);
	});

	it('the dashboard of a Support admin cannot change them and is told the field is locked; the Owner can', async () => {
		const path = `/v1/dashboard/websites/${env.websiteId}/lists/consent_categories`;
		const support = await env.adminSession('support');
		const read = await (await env.dashboard(support, 'GET', path)).json();
		expect(read.locked).toEqual(['scripts']);
		const refused = await env.dashboard(support, 'PUT', path, {
			value: read.value.map((/** @type {any} */ c) => (c.key === 'necessary' ? { ...c, scripts: EVIL } : c)),
		});
		expect(refused.status).toBe(403);
		const owner = await env.adminSession('owner');
		expect((await (await env.dashboard(owner, 'GET', path)).json()).locked).toEqual([]);
		expect((await env.dashboard(owner, 'PUT', path, { value: read.value })).status).toBe(200);
	});
});
