/**
 * SR-4-8b: a single-use sign-in code (phone code, email code, magic link, a sign-in code from staff in the code screens
 * or in the password box, the code of a phone + password sign-up) signs in once even when two requests with it arrive at
 * the same moment: it is used up before the session is issued, and only the call that used it up goes on. A refusal a
 * retry can fix (a consent to accept) still leaves the code for the retry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const OFF = ['consents', 'approval', 'two_step', 'risk_checks'];

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();
/** The code Notifications was last asked to send. */
const lastValues = () => env.messages().at(-1)?.values;
/** @param {string} method @param {string} path @param {unknown} [body] */
const server = (method, path, body) => env.call(method, path, { token: env.server, ...(body === undefined ? {} : { body }) });
/** A user made by staff (its address or number counts as proven). @param {Record<string, unknown>} body */
const create = async (body) => (await server('POST', '/v1/users', body)).json;
/** @param {string} id */
const staffCodeOf = async (id) => String((await server('POST', `/v1/users/${id}/sign-in-code`)).json.code);
/** Ask for a code to a number and return it. @param {string} phone */
const askPhone = async (phone) => {
	env.advance(61_000);
	expect((await env.visitor('POST', '/v1/sign-in/phone/code', { phone })).status).toBe(202);
	return String(lastValues()?.code);
};
/** Ask for a code (and a link) to an address. @param {string} email */
const askEmail = async (email) => {
	env.advance(61_000);
	const asked = await env.visitor('POST', '/v1/sign-in/email/code', { email, returnTo: 'http://localhost:3000/login' });
	expect(asked.status).toBe(202);
	return { code: String(lastValues()?.code), link: String(lastValues()?.link).split('#ss_accounts_link=')[1] };
};
/** The same request twice at the same moment. @param {string} path @param {unknown} body */
const twice = (path, body) => Promise.all([env.visitor('POST', path, body), env.visitor('POST', path, body)]);
/** How many sessions a user has: a session is made before the answer, so one the answer never carried would show here. @param {string} userId */
const sessionsOf = async (userId) => (await (await env.store()).sessions.ofUser(userId)).length;
/**
 * Exactly one of two answers signed in and the other was refused; the user has one session (the refused call made
 * none). In the password box the refused call may have looked after the code was used up: then it is a wrong password.
 * @param {{ json: any }[]} pair @param {string} userId @param {string[]} [refusals]
 */
const expectOneSignIn = async (pair, userId, refusals = ['code_invalid']) => {
	expect(pair.filter((res) => res.json?.status === 'signed_in')).toHaveLength(1);
	expect(pair.filter((res) => refusals.includes(String(code(res))))).toHaveLength(1);
	expect(await sessionsOf(userId)).toBe(1);
};
/**
 * Exactly one of two sign-ups made the account and signed in; the other was refused (the code, or the taken address).
 * @param {{ json: any }[]} pair @param {string} [status]
 */
const expectOneSignUp = async (pair, status = 'signed_in') => {
	const done = pair.filter((res) => res.json?.status === status);
	expect(done).toHaveLength(1);
	expect(pair.filter((res) => res !== done[0] && ['code_invalid', 'already_exists'].includes(String(code(res))))).toHaveLength(
		1,
	);
	if (status === 'signed_in') expect(await sessionsOf(String(done[0]?.json.user.id))).toBe(1);
};

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !OFF.includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
	await env.setting('phone', 'defaultCallingCode', '+44');
	await env.setting('phone', 'trunkPrefix', '0');
});
afterAll(async () => {
	await env.product.close();
});

describe('SR-4-8b: a sign-in code signs in once, even when used twice at the same moment', () => {
	it('a phone code', async () => {
		const user = await create({ name: 'Pia Phone', phone: '+447700900801' });
		const sent = await askPhone('+447700900801');
		await expectOneSignIn(await twice('/v1/sign-in/phone', { phone: '+447700900801', code: sent }), user.id);
		expect(code(await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900801', code: sent }))).toBe('code_invalid');
	});

	it('an email code', async () => {
		const user = await create({ name: 'Emma Email', email: 'emma.race@example.com' });
		const sent = await askEmail('emma.race@example.com');
		await expectOneSignIn(await twice('/v1/sign-in/email', { email: 'emma.race@example.com', code: sent.code }), user.id);
		expect(code(await env.visitor('POST', '/v1/sign-in/email', { email: 'emma.race@example.com', code: sent.code }))).toBe(
			'code_invalid',
		);
	});

	it('a magic link', async () => {
		const user = await create({ name: 'Mia Magic', email: 'mia.race@example.com' });
		const sent = await askEmail('mia.race@example.com');
		await expectOneSignIn(await twice('/v1/sign-in/email', { link: sent.link }), user.id);
		expect(code(await env.visitor('POST', '/v1/sign-in/email', { link: sent.link }))).toBe('code_invalid');
	});

	it('a sign-in code from staff, in the phone code screen and in the email code screen', async () => {
		const phoneUser = await create({ name: 'Sol Staffphone', phone: '+447700900802' });
		const forPhone = await staffCodeOf(phoneUser.id);
		await expectOneSignIn(await twice('/v1/sign-in/phone', { phone: '+447700900802', code: forPhone }), phoneUser.id);
		const emailUser = await create({ name: 'Sue Staffmail', email: 'sue.race@example.com' });
		const forEmail = await staffCodeOf(emailUser.id);
		await expectOneSignIn(await twice('/v1/sign-in/email', { email: 'sue.race@example.com', code: forEmail }), emailUser.id);
	});

	it('a sign-in code from staff typed in the password box of Phone + password', async () => {
		const user = await create({ name: 'Pam Password', phone: '+447700900803', password: 'long enough pass 1' });
		const staffCode = await staffCodeOf(user.id);
		await expectOneSignIn(await twice('/v1/sign-in/phone-password', { phone: '+447700900803', password: staffCode }), user.id, [
			'code_invalid',
			'sign_in_failed',
		]);
		expect(code(await env.visitor('POST', '/v1/sign-in/phone-password', { phone: '+447700900803', password: staffCode }))).toBe(
			'sign_in_failed',
		);
		// the password itself is no single-use code: it signs in as often as it is typed
		const again = await twice('/v1/sign-in/phone-password', { phone: '+447700900803', password: 'long enough pass 1' });
		expect(again.map((res) => res.json?.status)).toEqual(['signed_in', 'signed_in']);
	});

	it('the code of a phone + password sign-up (a new account is made once, with one session)', async () => {
		const sent = await askPhone('+447700900804');
		const pair = await twice('/v1/sign-up/phone-password', {
			phone: '+447700900804',
			password: 'new account pass 1',
			name: 'Nora New',
			code: sent,
		});
		await expectOneSignUp(pair);
		expect(
			code(
				await env.visitor('POST', '/v1/sign-up/phone-password', {
					phone: '+447700900804',
					password: 'x pass 12345',
					name: 'Z',
					code: sent,
				}),
			),
		).toBe('code_invalid');
	});

	it('a new user of a phone code or an email code is made once, with one session', async () => {
		const sentPhone = await askPhone('+447700900805');
		const phonePair = await twice('/v1/sign-in/phone', { phone: '+447700900805', code: sentPhone });
		await expectOneSignUp(phonePair);
		const sentEmail = await askEmail('newbie.race@example.com');
		const emailPair = await twice('/v1/sign-in/email', { email: 'newbie.race@example.com', code: sentEmail.code });
		await expectOneSignUp(emailPair);
		const linkSent = await askEmail('linkie.race@example.com');
		const linkPair = await twice('/v1/sign-in/email', { link: linkSent.link });
		await expectOneSignUp(linkPair);
	});
});

describe('SR-4-8b: a refusal a retry can fix leaves the code alive; the retry signs in once', () => {
	beforeAll(async () => {
		await env.switchOn(ALL.filter((key) => !OFF.filter((off) => off !== 'consents').includes(key)));
	});
	afterAll(async () => {
		await env.switchOn(ALL.filter((key) => !OFF.includes(key)));
	});

	it('a phone code of a user who has not accepted the consents yet', async () => {
		const user = await create({ name: 'Cora Consent', phone: '+447700900806' });
		const sent = await askPhone('+447700900806');
		const asked = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900806', code: sent });
		expect(code(asked)).toBe('consent_required');
		await expectOneSignIn(
			await twice('/v1/sign-in/phone', { phone: '+447700900806', code: sent, consents: { terms: true } }),
			user.id,
		);
	});

	it('a magic link of a user who has not accepted the consents yet', async () => {
		const user = await create({ name: 'Lee Link', email: 'lee.race@example.com' });
		const sent = await askEmail('lee.race@example.com');
		expect(code(await env.visitor('POST', '/v1/sign-in/email', { link: sent.link }))).toBe('consent_required');
		await expectOneSignIn(await twice('/v1/sign-in/email', { link: sent.link, consents: { terms: true } }), user.id);
	});

	it('a sign-in code from staff typed in the password box', async () => {
		const user = await create({ name: 'Stan Staffbox', phone: '+447700900807', password: 'long enough pass 2' });
		const staffCode = await staffCodeOf(user.id);
		const body = { phone: '+447700900807', password: staffCode };
		expect(code(await env.visitor('POST', '/v1/sign-in/phone-password', body))).toBe('consent_required');
		await expectOneSignIn(await twice('/v1/sign-in/phone-password', { ...body, consents: { terms: true } }), user.id, [
			'code_invalid',
			'sign_in_failed',
		]);
	});

	it('a phone + password sign-up that has not accepted the consents yet makes no account and keeps the code', async () => {
		const sent = await askPhone('+447700900808');
		const body = { phone: '+447700900808', password: 'new account pass 2', name: 'Nick New', code: sent };
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', body))).toBe('consent_required');
		const done = await env.visitor('POST', '/v1/sign-up/phone-password', { ...body, consents: { terms: true } });
		expect(done.json).toMatchObject({ status: 'signed_in', user: { phone: '+447700900808', phoneVerified: true } });
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { ...body, consents: { terms: true } }))).toBe(
			'code_invalid',
		);
	});
});

describe('SR-4-8b: a new user waiting for approval uses the code up', () => {
	beforeAll(async () => {
		await env.switchOn(ALL.filter((key) => !OFF.filter((off) => off !== 'approval').includes(key)));
		await env.setting('approval', 'mode', 'approval');
	});
	afterAll(async () => {
		await env.setting('approval', 'mode', 'open');
		await env.switchOn(ALL.filter((key) => !OFF.includes(key)));
	});

	it('a phone code sign-up and a phone + password sign-up answer pending once and the code is spent', async () => {
		const sentPhone = await askPhone('+447700900809');
		const phonePair = await twice('/v1/sign-in/phone', { phone: '+447700900809', code: sentPhone, name: 'Pen Pending' });
		await expectOneSignUp(phonePair, 'pending');
		expect(code(await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900809', code: sentPhone, name: 'Pen' }))).toBe(
			'code_invalid',
		);
		const sentPassword = await askPhone('+447700900810');
		const body = { phone: '+447700900810', password: 'pending pass 123', name: 'Pip Pending', code: sentPassword };
		const passwordPair = await twice('/v1/sign-up/phone-password', body);
		await expectOneSignUp(passwordPair, 'pending');
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', body))).toBe('code_invalid');
	});
});
