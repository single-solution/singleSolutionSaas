/**
 * Notifications' staff routes and configuration routes: the server token alone changes no template, setting or
 * connection, and reads no delivery log (SEC). Sending a message is what the website's server does at runtime: it keeps
 * working with the server token alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email', 'sms', 'send_api', 'webhooks']);
	await env.connectDatabase();
});

/** @param {Response} response */
const typeOf = async (response) =>
	String((await response.json()).type ?? '')
		.split('/')
		.pop();

const TEMPLATE = { key: 'sec.demo', channel: 'sms', text: 'Hello {name}' };

describe('Notifications with the server token alone', () => {
	it('changes no template, setting, theme or connection, and reads no delivery log', async () => {
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['PUT', '/v1/templates', TEMPLATE],
			['DELETE', '/v1/templates/sec.demo/sms/default', undefined],
			['PUT', '/v1/settings/send_limits.perDay', { value: 30 }],
			['PUT', '/v1/theme', { radius: 3 }],
			['PUT', '/v1/connections/email', { value: 'key' }],
			['GET', '/v1/templates', undefined],
			['GET', '/v1/messages', undefined],
			['GET', '/v1/messages/msg_none', undefined],
			['GET', '/v1/activity', undefined],
		])) {
			const refused = await env.call(method, path, { token: env.server, bare: true, ...(body === undefined ? {} : { body }) });
			expect([method, path, refused.status]).toEqual([method, path, 403]);
			expect(await typeOf(refused)).toBe('needs_signed_in_staff');
		}
	});

	it('still sends: the send API is the website’s runtime', async () => {
		const sent = await env.call('POST', '/v1/messages/sms', {
			token: env.server,
			bare: true,
			body: { to: '+447700900123', template: 'sec.none' },
		});
		// refused for its content (no such template), not for who asked
		expect([404, 422, 403]).toContain(sent.status);
		expect(await typeOf(sent)).not.toBe('needs_signed_in_staff');
	});
});

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

describe('a staff sign-in', () => {
	it('with templates.edit saves a template, logged with that person', async () => {
		const staff = { id: 'usr_sec2', name: 'Tess Template', permissions: ['notifications:templates.edit'] };
		const saved = await env.call('PUT', '/v1/templates', { token: env.server, staff, body: TEMPLATE });
		expect(saved.status).toBe(200);
		const overview = await (
			await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/overview`)
		).json();
		expect(overview.recentChanges).toContainEqual(
			expect.objectContaining({ who: expect.objectContaining({ id: 'usr_sec2', name: 'Tess Template' }), what: 'templates' }),
		);
	});

	it('without it is refused 403 forbidden', async () => {
		for (const permissions of [[], ['notifications:log.read'], ['chat:templates.edit']]) {
			const refused = await env.call('PUT', '/v1/templates', { token: env.server, staff: { permissions }, body: TEMPLATE });
			expect([refused.status, await typeOf(refused)]).toEqual([403, 'forbidden']);
		}
	});

	it('of another website is refused 401 invalid_sign_in', async () => {
		await env.staffHeaders();
		const other = await env.accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_x', permissions: ['*'] });
		const refused = await env.call('PUT', '/v1/templates', {
			token: env.server,
			bare: true,
			headers: { 'ss-sign-in': other },
			body: TEMPLATE,
		});
		expect([refused.status, await typeOf(refused)]).toEqual([401, 'invalid_sign_in']);
	});
});

afterAll(() => {});
