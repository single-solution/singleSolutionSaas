/**
 * A City on a member's profile with the custom fields feature (P4 item 16 of audit/parity-plan.md): the merchant adds
 * the field in the dashboard; the member sets and clears it in My account; staff see it on the user and in the list,
 * set it when they add a user and edit it; the data export carries it; a required field is never left empty. No store
 * value is built in: "City" is the merchant's own field.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();
/** @param {string} method @param {string} path @param {unknown} [body] */
const server = (method, path, body) => env.serverCall(method, path, body);

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'approval', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.setting('phone', 'defaultCallingCode', '+44');
	await env.setting('phone', 'trunkPrefix', '0');
});
afterAll(async () => {
	await env.product.close();
});

describe('a City on the member profile (custom fields)', () => {
	it('the member sets it in My account; staff see, add and edit it; the export carries it; required stays filled', async () => {
		const cookie = await env.adminSession();
		const fields = `/v1/dashboard/websites/${env.websiteId}/fields`;
		await env.dashboard(cookie, 'PUT', `${fields}/city`, { label: 'City', type: 'text' });
		const city = { key: 'city', label: 'City', type: 'text', options: [], required: false, visibility: 'edit', help: '' };
		// the widgets get it: sign-up, My account and the Users widget
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.customFields).toEqual([city]);

		// a member who joined with a setup link sets it in My account
		const sam = await server('POST', '/v1/users', { name: 'Sam Lee', phone: '07700 900600', role: 'customer' });
		const link = await server('POST', `/v1/users/${sam.json.id}/setup-link`);
		const joined = await env.visitor('POST', '/v1/setup-links/accept', {
			code: new URL(link.json.url).searchParams.get('ss_setup'),
			password: 'sam pass 1234',
		});
		const signIn = joined.json.signIn;
		const set = await env.visitor('PATCH', '/v1/me', { custom: { city: ' London ' } }, signIn);
		expect(set.json.custom).toEqual({ city: 'London' });
		expect((await env.visitor('GET', '/v1/me', undefined, signIn)).json.custom).toEqual({ city: 'London' });
		expect(code(await env.visitor('PATCH', '/v1/me', { custom: { city: 'x'.repeat(1001) } }, signIn))).toBe(
			'validation_failed',
		);

		// staff see it on the user and in the list, and edit it (the activity log names the field, never its value)
		expect((await server('GET', `/v1/users/${sam.json.id}`)).json.custom).toEqual({ city: 'London' });
		const ticket = await env.ticket();
		const listed = await env.admin(ticket, 'GET', `/v1/admin/users?phone=${encodeURIComponent('+447700900600')}`);
		expect(listed.json.items.map((/** @type {any} */ u) => u.custom)).toEqual([{ city: 'London' }]);
		const edited = await env.admin(ticket, 'PATCH', `/v1/admin/users/${sam.json.id}`, { custom: { city: 'Paris' } });
		expect(edited.json.custom).toEqual({ city: 'Paris' });
		const logged = (await server('GET', '/v1/activity?action=user.custom_changed')).json.items[0];
		expect(logged).toMatchObject({ target: sam.json.id, values: { fields: 'city' } });
		expect(JSON.stringify(logged)).not.toContain('Paris');
		// staff add a user with it
		const kai = await server('POST', '/v1/users', { name: 'Kai Ito', phone: '07700 900601', custom: { city: 'Tokyo' } });
		expect(kai.json.custom).toEqual({ city: 'Tokyo' });
		expect(code(await server('POST', '/v1/users', { name: 'Ann', phone: '07700 900602', custom: { town: 'x' } }))).toBe(
			'validation_failed',
		);

		// the member clears it; the data export carries what is set
		expect((await env.visitor('PATCH', '/v1/me', { custom: { city: '' } }, signIn)).json.custom).toEqual({});
		await env.visitor('PATCH', '/v1/me', { custom: { city: 'New York' } }, signIn);
		const asked = await env.visitor('POST', '/v1/me/export', {}, signIn);
		const file = await env.call('GET', new URL(asked.json.url).pathname);
		expect(file.json.records.accounts.user.custom).toEqual({ city: 'New York' });

		// a required City is never left empty once asked; a change that does not send it leaves it alone
		await env.dashboard(cookie, 'PUT', `${fields}/city`, { label: 'City', type: 'text', required: true });
		expect(code(await env.visitor('PATCH', '/v1/me', { custom: { city: '' } }, signIn))).toBe('validation_failed');
		expect((await env.visitor('PATCH', '/v1/me', { name: 'Sam Lee' }, signIn)).json.custom).toEqual({ city: 'New York' });
		expect(code(await env.admin(ticket, 'PATCH', `/v1/admin/users/${sam.json.id}`, { custom: { city: null } }))).toBe(
			'validation_failed',
		);

		// with the feature off, My account cannot change it and the widgets show none; staff keep what is stored
		await env.switchOn(
			ALL.filter((key) => !['consents', 'approval', 'two_step', 'risk_checks', 'custom_fields'].includes(key)),
		);
		expect(code(await env.visitor('PATCH', '/v1/me', { custom: { city: 'Rome' } }, signIn))).toBe('feature_off');
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.customFields).toEqual([]);
		expect((await server('GET', `/v1/users/${sam.json.id}`)).json.custom).toEqual({ city: 'New York' });
	});
});
