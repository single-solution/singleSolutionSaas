/**
 * The server token runs the website; it changes no configuration on its own (SEC). Every configuration write and every
 * staff route needs the server token AND the verified Accounts sign-in of a staff member whose role grants the
 * permission. Seen from the attacker's side: a stolen server token, a forged or replayed sign-in, a sign-in of another
 * website, headers that only claim a person.
 */
import { describe, expect, it } from 'vitest';
import { createAccountsDouble } from '../src/testing.js';
import { DOMAIN, productRoutes, setup } from './helpers.js';

const SITE = `https://${DOMAIN}`;
const PROBLEM = 'https://notes.example.dev/problems/';

/** A product list setting kept in memory. */
const memoryLists = () => {
	/** @type {Map<string, unknown>} */
	const saved = new Map();
	return {
		labels: {
			feature: 'inbox',
			title: 'Labels',
			get: async (/** @type {string} */ websiteId) => saved.get(websiteId) ?? [],
			save: async (/** @type {string} */ websiteId, /** @type {unknown} */ value) => {
				saved.set(websiteId, value);
				return { ok: /** @type {const} */ (true), value };
			},
		},
	};
};

const CONNECTIONS = { ai: { label: 'AI provider key', kind: /** @type {const} */ ('secret'), neededBy: ['notes'] } };

/** Every configuration write of the kit, with a body that is valid. @type {Array<[string, string, unknown]>} */
const WRITES = [
	['PUT', '/v1/settings/notes.maxNotes', { value: 9 }],
	['DELETE', '/v1/settings/notes.maxNotes', undefined],
	['PUT', '/v1/texts/form.title', { value: 'Write to us' }],
	['DELETE', '/v1/texts/form.title', undefined],
	['PUT', '/v1/lists/labels', { value: ['vip'] }],
	['PUT', '/v1/connections/ai', { value: 'sk-secret-1234' }],
	['POST', '/v1/connections/ai/test', undefined],
	['DELETE', '/v1/connections/ai', undefined],
];

/** Things only staff may read: connections' state, the activity log. @type {Array<[string, string]>} */
const STAFF_READS = [
	['GET', '/v1/connections'],
	['GET', '/v1/activity'],
	['GET', '/v1/activity/count'],
	['GET', '/v1/activity/counts?by=action'],
];

const prepared = async () => {
	const env = await setup({ lists: memoryLists(), connections: CONNECTIONS });
	await env.switchOn(['notes', 'inbox']);
	await env.connectDatabase();
	return env;
};

/** @param {Response} response */
const problemOf = async (response) => ({ status: response.status, ...(await response.json()) });

describe('a stolen server token alone (403 needs_signed_in_staff)', () => {
	it('changes no configuration: settings, texts, lists, connections', async () => {
		const { call, server, store, websiteId } = await prepared();
		for (const [method, path, body] of WRITES) {
			const refused = await problemOf(
				await call(method, path, { token: server.token, bare: true, ...(body === undefined ? {} : { body }) }),
			);
			expect([method, path, refused.status, refused.type]).toEqual([method, path, 403, `${PROBLEM}needs_signed_in_staff`]);
		}
		// nothing was written
		expect(await store.list('settings', { websiteId })).toEqual([]);
		expect((await store.list('connections', { websiteId })).some((/** @type {any} */ c) => c.name === 'ai')).toBe(false);
	});

	it('reads no staff data: the connections, the activity log, tickets for admin widgets', async () => {
		const { call, server } = await prepared();
		for (const [method, path] of STAFF_READS) {
			const refused = await call(method, path, { token: server.token, bare: true });
			expect([method, path, refused.status]).toEqual([method, path, 403]);
		}
		const ticket = await call('POST', '/v1/tickets', {
			token: server.token,
			bare: true,
			body: { permissions: [], origin: 'https://admin.shop.example.com' },
		});
		expect(ticket.status).toBe(403);
	});

	it('still runs the shop: reads of features, settings, texts, theme, Format and lists', async () => {
		const { call, server } = await prepared();
		for (const path of [
			'/v1/features',
			'/v1/settings',
			'/v1/texts',
			'/v1/theme',
			'/v1/format',
			'/v1/lists/labels',
			'/v1/permissions',
		]) {
			const read = await call('GET', path, { token: server.token, bare: true });
			expect([path, read.status]).toEqual([path, 200]);
		}
	});

	it('is not helped by headers that only name a person (SS-Actor-*, a user id, an email, a role)', async () => {
		const { call, server } = await prepared();
		const claims = {
			'ss-actor-id': 'usr_owner',
			'ss-actor-name': 'The%20Owner',
			'ss-actor-role': 'owner',
			'ss-actor-email': 'owner@shop.example.com',
			'ss-user-id': 'usr_owner',
			'x-user-role': 'owner',
		};
		for (const [method, path, body] of WRITES) {
			const refused = await call(method, path, {
				token: server.token,
				bare: true,
				headers: claims,
				...(body === undefined ? {} : { body }),
			});
			expect([method, path, refused.status]).toEqual([method, path, 403]);
		}
	});

	it('does not work from a browser: a server route refuses any Origin, and the browser token is no server token', async () => {
		const { call, server, browser } = await prepared();
		expect(
			(await call('PUT', '/v1/texts/form.title', { token: server.token, bare: true, origin: SITE, body: { value: 'Hi' } }))
				.status,
		).toBe(401);
		expect(
			(await call('PUT', '/v1/texts/form.title', { token: browser.token, origin: SITE, body: { value: 'Hi' } })).status,
		).toBe(401);
		expect((await call('PUT', '/v1/texts/form.title', { token: browser.token, body: { value: 'Hi' } })).status).toBe(401);
	});
});

describe('every kind of connection: database, storage, provider keys and pasted product tokens', () => {
	const CONNECTION_KINDS = {
		ai: { label: 'AI provider key', kind: /** @type {const} */ ('secret'), neededBy: ['notes'] },
		files: { label: 'Files', kind: /** @type {const} */ ('storage'), neededBy: ['notes'] },
		payments: { label: 'Payments token', kind: /** @type {const} */ ('token'), productId: 'payments', neededBy: [] },
	};
	/** A value of each kind (the shapes the connections take; none of them has to work: the call is refused first). */
	const VALUES = {
		database: 'mongodb://attacker.example.com/shop',
		ai: 'sk-attacker-9999',
		files: {
			endpoint: 'https://attacker.example.com',
			region: 'auto',
			bucket: 'x',
			accessKeyId: 'AKIA',
			secretAccessKey: 'attacker',
		},
		payments: 'a.b.c',
		accounts: 'a.b.c',
	};

	it('a bare server token cannot save, remove or test any of them: 403, and what is saved stays as it was', async () => {
		const env = await setup({ connections: CONNECTION_KINDS });
		await env.switchOn(['notes']);
		const database = await env.connectDatabase();
		const cookie = await env.session({ kind: 'merchant' });
		const dashboard = `/v1/dashboard/websites/${env.websiteId}/connections`;
		expect((await env.dash(cookie, 'PUT', `${dashboard}/ai`, { value: 'sk-owner-1111' })).status).toBe(200);
		const before = await (await env.dash(cookie, 'GET', dashboard)).json();
		const names = before.connections.map((/** @type {{ name: string }} */ c) => c.name);
		expect(names).toEqual(expect.arrayContaining(['database', 'ai', 'files', 'payments', 'accounts']));
		for (const name of names) {
			for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
				['PUT', `/v1/connections/${name}`, { value: VALUES[/** @type {keyof typeof VALUES} */ (name)] ?? 'x' }],
				['DELETE', `/v1/connections/${name}`, undefined],
				['POST', `/v1/connections/${name}/test`, undefined],
			])) {
				const refused = await env.call(method, path, {
					token: env.server.token,
					bare: true,
					...(body === undefined ? {} : { body }),
				});
				expect([method, path, refused.status, (await refused.json()).type.split('/').pop()]).toEqual([
					method,
					path,
					403,
					'needs_signed_in_staff',
				]);
			}
		}
		// nothing moved: the same states, the database still the one the merchant connected, the key still the merchant's
		const after = await (await env.dash(cookie, 'GET', dashboard)).json();
		expect(after.connections).toEqual(before.connections);
		expect(after.connections.find((/** @type {{ name: string }} */ c) => c.name === 'database')).toMatchObject({
			status: 'connected',
		});
		const store = await env.product.connections.value(env.websiteId, 'database');
		expect(String(store)).toContain(database);
		expect(await env.product.connections.value(env.websiteId, 'ai')).toBe('sk-owner-1111');
		// a staff member signed in with `connections.manage` can (their change is theirs); `settings.manage` alone cannot
		const settingsOnly = await env.call('PUT', '/v1/connections/ai', {
			token: env.server.token,
			staff: { permissions: ['notes:settings.manage'] },
			body: { value: 'sk-x' },
		});
		expect(settingsOnly.status).toBe(403);
		const manager = await env.call('PUT', '/v1/connections/ai', {
			token: env.server.token,
			staff: { id: 'usr_conn', name: 'Cora Connections', permissions: ['notes:connections.manage'] },
			body: { value: 'sk-staff-2222' },
		});
		expect(manager.status).toBe(200);
		expect(await env.product.connections.value(env.websiteId, 'ai')).toBe('sk-staff-2222');
	});
});

describe('a verified staff sign-in with the permission', () => {
	it('makes every configuration change and it is logged with that person', async () => {
		const { call, server, websiteId, settle, session, dash } = await prepared();
		const staff = { id: 'usr_9', name: 'Mia Manager', role: 'manager', email: 'mia@shop.example.com' };
		const grants = { ...staff, permissions: ['notes:settings.manage', 'notes:connections.manage', 'notes:audit.read'] };
		for (const [method, path, body] of WRITES) {
			const answered = await call(method, path, {
				token: server.token,
				staff: grants,
				...(body === undefined ? {} : { body }),
			});
			// a connection test of a value that was just deleted is 404, the others are fine
			expect([method, path, [200, 204, 404].includes(answered.status)]).toEqual([method, path, true]);
		}
		await settle();
		const log = await (
			await call('GET', '/v1/activity?action=settings.changed', { token: server.token, staff: grants })
		).json();
		const targets = log.items.map((/** @type {any} */ e) => e.target);
		expect(targets).toEqual(expect.arrayContaining(['settings.notes.maxNotes', 'texts.form.title', 'list.labels']));
		for (const entry of log.items)
			expect(entry.actor).toMatchObject({ kind: 'user', id: 'usr_9', name: 'Mia Manager', role: 'manager' });
		// and in Recent changes, with the same person
		const cookie = await session({ kind: 'merchant' });
		const overview = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		const people = overview.recentChanges
			.map((/** @type {any} */ c) => c.who)
			.filter((/** @type {any} */ who) => who.kind === 'user');
		expect(people.length).toBeGreaterThan(5);
		for (const who of people) expect(who).toMatchObject({ id: 'usr_9', name: 'Mia Manager' });
	});

	it('is a person of the sign-in only: a header naming another person changes nothing', async () => {
		const { call, server, websiteId, accounts, settle, staffHeaders } = await prepared();
		await staffHeaders(); // pastes the website's Accounts token
		const signIn = await accounts.signIn({
			websiteId,
			sub: 'usr_real',
			name: 'Real Rita',
			role: 'manager',
			permissions: ['notes:settings.manage', 'notes:audit.read'],
		});
		const saved = await call('PUT', '/v1/texts/form.title', {
			token: server.token,
			bare: true,
			body: { value: 'Write to us' },
			headers: { 'ss-sign-in': signIn, 'ss-actor-id': 'usr_boss', 'ss-actor-name': 'The%20Boss' },
		});
		expect(saved.status).toBe(200);
		await settle();
		const log = await (
			await call('GET', '/v1/activity?action=settings.changed', {
				token: server.token,
				bare: true,
				headers: { 'ss-sign-in': signIn },
			})
		).json();
		expect(log.items[0].actor).toMatchObject({ id: 'usr_real', name: 'Real Rita' });
	});

	it('is keyed by the permission of the right product: the Owner’s `*` does everything', async () => {
		const { call, server } = await prepared();
		const owner = { permissions: ['*'] };
		expect(
			(await call('PUT', '/v1/texts/form.title', { token: server.token, staff: owner, body: { value: 'Write to us' } }))
				.status,
		).toBe(200);
	});

	it('still reads connections as set or not, never as a value, not even its last characters', async () => {
		const { call, server } = await prepared();
		const staff = { permissions: ['notes:connections.manage'] };
		const saved = await problemOf(
			await call('PUT', '/v1/connections/ai', { token: server.token, staff, body: { value: 'sk-secret-1234' } }),
		);
		expect(saved).toMatchObject({ name: 'ai', set: true, state: 'connected' });
		const listed = JSON.stringify(await (await call('GET', '/v1/connections', { token: server.token, staff })).json());
		expect(listed).toContain('"set":true');
		for (const leak of ['sk-secret', '1234', 'last4']) expect(listed).not.toContain(leak);
	});
});

describe('a staff sign-in without the permission (403 forbidden)', () => {
	it('is refused: a role without it, with other products’ permissions, a customer, a role with none at all', async () => {
		const { call, server } = await prepared();
		const roles = [
			{ permissions: [] }, // a customer: signed in, no staff role
			{ permissions: ['notes:audit.read'] }, // another permission of this product
			{ permissions: ['notes:connections.manage'] }, // settings need their own
			{ permissions: ['ecommerce:settings.manage', 'chat:settings.manage'] }, // the same key of other products
			{ permissions: ['notes:settings.manage '] }, // not an exact match
			{ permissions: ['Notes:settings.manage'] },
			{ permissions: ['notes:*'] }, // only the whole `*` stands for everything
			{ permissions: ['notes:settings'] },
		];
		for (const staff of roles) {
			const refused = await problemOf(
				await call('PUT', '/v1/texts/form.title', { token: server.token, staff, body: { value: 'Write to us' } }),
			);
			expect([JSON.stringify(staff), refused.status, refused.type]).toEqual([
				JSON.stringify(staff),
				403,
				`${PROBLEM}forbidden`,
			]);
		}
		// settings only: connections stay out of reach
		const settings = { permissions: ['notes:settings.manage'] };
		expect(
			(await call('PUT', '/v1/connections/ai', { token: server.token, staff: settings, body: { value: 'x' } })).status,
		).toBe(403);
		expect((await call('GET', '/v1/activity', { token: server.token, staff: settings })).status).toBe(403);
	});

	it('is refused without a role claim at all', async () => {
		const { call, server, websiteId, accounts } = await prepared();
		await call('GET', '/v1/features', { token: server.token }); // pastes the Accounts token
		const plain = await accounts.signIn({ websiteId, sub: 'usr_plain', name: 'Plain' });
		const refused = await call('PUT', '/v1/texts/form.title', {
			token: server.token,
			bare: true,
			body: { value: 'Write to us' },
			headers: { 'ss-sign-in': plain },
		});
		expect(refused.status).toBe(403);
		expect((await refused.json()).type).toBe(`${PROBLEM}forbidden`);
	});
});

describe('a sign-in that is not valid for this website (401 invalid_sign_in)', () => {
	/** A call with a sign-in header. @param {Awaited<ReturnType<typeof prepared>>} env @param {string} signIn */
	const withSignIn = (env, signIn) =>
		env.call('PUT', '/v1/texts/form.title', {
			token: env.server.token,
			bare: true,
			body: { value: 'Write to us' },
			headers: { 'ss-sign-in': signIn },
		});

	it('is another website’s: it says who they are there, nothing here', async () => {
		const env = await prepared();
		await env.staffHeaders(); // the Accounts token is pasted
		const other = await env.accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_owner', permissions: ['*'] });
		const refused = await problemOf(await withSignIn(env, other));
		expect(refused).toMatchObject({ status: 401, type: `${PROBLEM}invalid_sign_in`, cause: 'audience' });
		// the same for every kind of call a staff route has
		for (const [method, path, body] of WRITES) {
			const answered = await env.call(method, path, {
				token: env.server.token,
				bare: true,
				headers: { 'ss-sign-in': other },
				...(body === undefined ? {} : { body }),
			});
			expect([method, path, answered.status]).toEqual([method, path, 401]);
		}
	});

	it('is expired or too old', async () => {
		const env = await prepared();
		const signIn = await env.accounts.signIn({
			websiteId: env.websiteId,
			sub: 'usr_owner',
			permissions: ['*'],
			ttlSeconds: 60,
		});
		await env.staffHeaders();
		expect((await withSignIn(env, signIn)).status).toBe(200);
		env.clock.advance(3 * 60_000);
		const late = await problemOf(await withSignIn(env, signIn));
		expect(late).toMatchObject({ status: 401, cause: 'expired' });
	});

	it('is forged: signed by another key, edited after signing, `alg: none`, junk', async () => {
		const env = await prepared();
		await env.staffHeaders();
		const forger = createAccountsDouble({ url: env.accounts.url, now: env.clock.now });
		const forged = await forger.signIn({ websiteId: env.websiteId, sub: 'usr_owner', permissions: ['*'] });
		expect(await problemOf(await withSignIn(env, forged))).toMatchObject({ status: 401, cause: 'signature' });
		// a real sign-in of a customer with the permissions edited in
		const real = await env.accounts.signIn({ websiteId: env.websiteId, sub: 'usr_customer', permissions: [] });
		const [head, , signature] = real.split('.');
		const claims = Buffer.from(
			JSON.stringify({
				aud: env.websiteId,
				sub: 'usr_customer',
				permissions: ['*'],
				iss: env.accounts.url,
				iat: 1,
				exp: 99999999999,
			}),
		).toString('base64url');
		expect(await problemOf(await withSignIn(env, `${head}.${claims}.${signature}`))).toMatchObject({
			status: 401,
			cause: 'signature',
		});
		const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${claims}.`;
		for (const junk of [none, 'junk', 'a.b.c', `${real}x`, '.'.repeat(2)])
			expect((await withSignIn(env, junk)).status).toBe(401);
	});

	it('is checked before the permission: a valid sign-in of another website never reads as "no permission"', async () => {
		const env = await prepared();
		await env.staffHeaders();
		const other = await env.accounts.signIn({ websiteId: 'web_other', sub: 'usr_x', permissions: [] });
		expect((await withSignIn(env, other)).status).toBe(401);
	});

	it('is not taken from the Accounts of another product: only the pasted Accounts token of this website names the keys', async () => {
		const env = await prepared();
		// no Accounts token pasted yet: sign-ins cannot be checked, so none is taken
		const signIn = await env.accounts.signIn({ websiteId: env.websiteId, sub: 'usr_owner', permissions: ['*'] });
		const refused = await problemOf(await withSignIn(env, signIn));
		expect(refused).toMatchObject({ status: 401, cause: 'accounts_not_connected' });
	});
});

describe('dashboard sessions are unchanged (the human’s own change)', () => {
	it('save settings, texts, lists and connections as before, with no sign-in', async () => {
		const { websiteId, session, dash, call } = await prepared();
		const cookie = await session({ kind: 'merchant' });
		const w = `/v1/dashboard/websites/${websiteId}`;
		expect((await dash(cookie, 'PUT', `${w}/settings/notes.greeting`, { value: 'Hi' })).status).toBe(204);
		expect((await dash(cookie, 'PUT', `${w}/lists/labels`, { value: ['vip'] })).status).toBe(200);
		expect((await dash(cookie, 'PUT', `${w}/connections/ai`, { value: 'sk-x-1234' })).status).toBe(200);
		// a write needs the product's own Origin (CSRF): another site's page cannot use the session
		const crossSite = await call('PUT', `${w}/settings/notes.greeting`, {
			cookie,
			origin: 'https://evil.example.com',
			body: { value: 'Evil' },
		});
		expect(crossSite.status).toBe(403);
		const noOrigin = await call('PUT', `${w}/settings/notes.greeting`, { cookie, body: { value: 'Evil' } });
		expect(noOrigin.status).toBe(403);
	});
});

describe('an ordinary server route is told apart by what it says it is', () => {
	it('runs a runtime route with the token alone, and a staff route only with the sign-in', async () => {
		const { call, server } = await setup({ routes: productRoutes() });
		expect((await call('GET', '/v1/server/open', { token: server.token, bare: true })).status).toBe(200);
		const bare = await call('GET', '/v1/inbox/open', { token: server.token, bare: true });
		expect(bare.status).toBe(403);
	});
});
