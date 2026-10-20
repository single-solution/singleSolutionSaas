/**
 * What a merchant's server may do without a staff member (SEC follow-up): the server token alone runs the shop, so the
 * calls a website's own pages need are public flows or the shopper's own actions, never staff routes. Forgot password
 * is public (a person who is not signed in, staff included), My account (`/v1/me`) is the shopper's own with their
 * `SS-Sign-In`, and the custom field definitions sign-up and My account show are a public read of only the fields a
 * user may see. Everything that is staff work or configuration stays closed to the bare server token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const VISITOR = { 'ss-visitor-ip': '203.0.113.7' };
const RETURN_TO = `${ORIGIN}/reset`;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/**
 * A call from the merchant's server for a visitor: the server token and the visitor's address, no staff sign-in.
 * @param {string} method @param {string} path @param {unknown} [body] @param {string} [signIn]
 */
const fromServer = (method, path, body, signIn) =>
	env.call(method, path, {
		token: env.server,
		headers: VISITOR,
		...(body === undefined ? {} : { body }),
		...(signIn ? { signIn } : {}),
	});

/** Messages sent to an address. @param {string} email */
const sentTo = (email) => env.messages().filter((m) => m.to.email === email);

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'approval', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
	await env.setting('phone', 'defaultCallingCode', '+44');
	await env.setting('phone', 'trunkPrefix', '0');
	await env.setting('phone_password', 'selfReset', 'code');
	const cookie = await env.adminSession();
	const fields = `/v1/dashboard/websites/${env.websiteId}/fields`;
	await env.dashboard(cookie, 'PUT', `${fields}/city`, { label: 'City', type: 'text', help: 'Where you live' });
	await env.dashboard(cookie, 'PUT', `${fields}/tier`, { label: 'Tier', type: 'text', visibility: 'view' });
	await env.dashboard(cookie, 'PUT', `${fields}/risk`, { label: 'Risk note', type: 'text', visibility: 'staff' });
});
afterAll(async () => {
	await env.product.close();
});

describe('forgot password is public: the merchant’s server asks for a person who is not signed in', () => {
	it('by email, for a staff member too: the reset link goes through Notifications and sets a new password', async () => {
		const made = await env.serverCall('POST', '/v1/users', {
			name: 'Amna Manager',
			email: 'amna@shop.example.com',
			role: 'business_manager',
			password: 'staff pass 123456',
		});
		expect(made.status).toBe(201);
		const asked = await fromServer('POST', '/v1/password/forgot', { email: 'amna@shop.example.com', returnTo: RETURN_TO });
		expect([asked.status, asked.text]).toEqual([202, '']);
		const sent = sentTo('amna@shop.example.com');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ template: 'accounts.password_reset' });
		const link = String(sent[0].values.link);
		expect(link.startsWith(`${RETURN_TO}#`)).toBe(true);
		const token = new URLSearchParams(link.split('#')[1]).get('ss_accounts_reset');
		expect(token).toBeTruthy();

		// the page that holds the link sets the new password, again as a public call, and the staff member signs in with it
		const reset = await fromServer('POST', '/v1/password/reset', { token, password: 'new staff pass 654321' });
		expect(reset.status).toBe(204);
		const signedIn = await fromServer('POST', '/v1/sign-in/password', {
			email: 'amna@shop.example.com',
			password: 'new staff pass 654321',
		});
		expect(signedIn.json).toMatchObject({ status: 'signed_in', user: { role: 'business_manager' } });
	});

	it('the answer is the same for an address that is not a member, and nothing is sent', async () => {
		const asked = await fromServer('POST', '/v1/password/forgot', { email: 'nobody@shop.example.com', returnTo: RETURN_TO });
		expect([asked.status, asked.text]).toEqual([202, '']);
		expect(sentTo('nobody@shop.example.com')).toHaveLength(0);
	});

	it('by phone, for a staff member too: a code goes through Notifications and sets a new password', async () => {
		const made = await env.serverCall('POST', '/v1/users', {
			name: 'Sana Support',
			phone: '+447700900321',
			role: 'support_staff',
			password: 'staff pass 123456',
		});
		expect(made.status).toBe(201);
		const before = env.messages().length;
		expect((await fromServer('POST', '/v1/password/phone/forgot', { phone: '+447700900321' })).status).toBe(202);
		expect(env.messages().length).toBe(before + 1);
		const sent = env.messages().at(-1);
		expect(sent).toMatchObject({ template: 'accounts.phone_code', to: { phone: '+447700900321' } });
		const reset = await fromServer('POST', '/v1/password/phone/reset', {
			phone: '+447700900321',
			code: String(sent.values.code),
			password: 'new staff pass 654321',
		});
		expect(reset.status).toBe(204);
		const signedIn = await fromServer('POST', '/v1/sign-in/phone-password', {
			phone: '+447700900321',
			password: 'new staff pass 654321',
		});
		expect(signedIn.json).toMatchObject({ status: 'signed_in', user: { role: 'support_staff' } });
	});

	it('does not open the staff routes: the same server token still makes no reset link for someone else', async () => {
		const who = await env.serverCall('GET', '/v1/users?email=amna%40shop.example.com');
		const id = who.json.items[0].id;
		for (const [method, path] of /** @type {Array<[string, string]>} */ ([
			['POST', `/v1/users/${id}/setup-link`],
			['POST', `/v1/users/${id}/sign-in-code`],
			['PATCH', `/v1/users/${id}`],
			['GET', '/v1/fields'],
		])) {
			const refused = await env.call(method, path, {
				token: env.server,
				bare: true,
				...(method === 'PATCH' ? { body: { name: 'X' } } : {}),
			});
			expect([method, path, refused.status, code(refused)]).toEqual([method, path, 403, 'needs_signed_in_staff']);
		}
	});
});

describe('My account is the shopper’s own: /v1/me with their sign-in, from the merchant’s server', () => {
	/** @type {string} */
	let signIn;

	beforeAll(async () => {
		// the number is proven first: the code goes to it, and comes back with the sign-up
		expect((await fromServer('POST', '/v1/sign-in/phone/code', { phone: '+447700900555' })).status).toBe(202);
		const up = await fromServer('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900555',
			password: 'shopper pass 1',
			code: env.messages().at(-1)?.values.code,
		});
		expect(up.status).toBe(200);
		signIn = up.json.signIn;
	});

	it('changes the name, the editable custom field and the addresses; reads them back', async () => {
		const changed = await fromServer(
			'PATCH',
			'/v1/me',
			{
				name: 'Zara Khan',
				custom: { city: ' Leeds ' },
				addresses: [
					{ label: 'Home', name: 'Zara Khan', line1: '1 High Street', city: 'Leeds', postalCode: 'LS1 1AA', country: 'GB' },
				],
			},
			signIn,
		);
		expect(changed.status).toBe(200);
		expect(changed.json).toMatchObject({ name: 'Zara Khan', custom: { city: 'Leeds' }, role: 'customer' });
		expect(changed.json.addresses).toHaveLength(1);
		const again = await fromServer('GET', '/v1/me', undefined, signIn);
		expect(again.json).toMatchObject({ name: 'Zara Khan', custom: { city: 'Leeds' } });
		expect(again.json.addresses[0]).toMatchObject({ line1: '1 High Street', city: 'Leeds', default: true });
	});

	it('cannot set a field only staff change, the role, or anyone else’s record', async () => {
		expect(code(await fromServer('PATCH', '/v1/me', { custom: { tier: 'gold' } }, signIn))).toBe('validation_failed');
		expect(code(await fromServer('PATCH', '/v1/me', { custom: { risk: 'low' } }, signIn))).toBe('validation_failed');
		const sneaky = await fromServer('PATCH', '/v1/me', { role: 'owner', blocked: true, notes: 'x' }, signIn);
		expect(sneaky.json).toMatchObject({ role: 'customer' });
		expect(sneaky.json.notes).toBeUndefined();
	});

	it('needs the shopper’s sign-in: the server token alone, or a forged one, is refused', async () => {
		expect(code(await fromServer('PATCH', '/v1/me', { name: 'No One' }))).toBe('signed_out');
		const forged = await fromServer('PATCH', '/v1/me', { name: 'No One' }, `${signIn.slice(0, -4)}AAAA`);
		expect([forged.status, forged.json.type?.split('/').pop()]).toEqual([401, 'signed_out']);
	});
});

describe('the custom field definitions are a public read of the fields a user may see', () => {
	const shown = [
		{ key: 'city', label: 'City', type: 'text', options: [], required: false, visibility: 'edit', help: 'Where you live' },
		{ key: 'tier', label: 'Tier', type: 'text', options: [], required: false, visibility: 'view', help: '' },
	];

	it('answers the visitor and the merchant’s server alike, without the staff-only fields', async () => {
		const visitor = await env.visitor('GET', '/v1/fields/public');
		expect(visitor.status).toBe(200);
		expect(visitor.json.items).toEqual(shown);
		const server = await fromServer('GET', '/v1/fields/public');
		expect(server.status).toBe(200);
		expect(server.json.items).toEqual(shown);
		expect(JSON.stringify(server.json)).not.toContain('Risk note');
	});

	it('the full list with the staff-only fields stays a staff route', async () => {
		const bare = await env.call('GET', '/v1/fields', { token: env.server, bare: true });
		expect([bare.status, code(bare)]).toEqual([403, 'needs_signed_in_staff']);
		const staff = await env.serverCall('GET', '/v1/fields');
		expect(staff.json.items.map((/** @type {any} */ f) => f.key)).toEqual(['city', 'tier', 'risk']);
	});

	it('is off with the Custom fields feature, like the widgets', async () => {
		await env.switchOn(
			ALL.filter((key) => !['consents', 'approval', 'two_step', 'risk_checks', 'custom_fields'].includes(key)),
		);
		expect(code(await fromServer('GET', '/v1/fields/public'))).toBe('feature_off');
		await env.switchOn(ALL.filter((key) => !['consents', 'approval', 'two_step', 'risk_checks'].includes(key)));
		expect((await fromServer('GET', '/v1/fields/public')).status).toBe(200);
	});
});
