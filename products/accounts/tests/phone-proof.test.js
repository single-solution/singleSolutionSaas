/**
 * SR-4-1: a phone number nobody proved is no way into an account, like an address nobody proved. Phone code sign-in and
 * the phone password reset open only an account whose number was proven; a code that proves the number takes it off an
 * account that held it unproven; a phone + password sign-up proves the number first, so no account is made with one nobody
 * proved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const VICTIM = '+447700900700';
const OFF = ['consents', 'approval', 'two_step', 'risk_checks'];

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();
/** The code Notifications was last asked to send to a number. */
const lastCode = () => String(env.messages().at(-1)?.values.code);
/** @param {string} phone */
const askCode = async (phone) => {
	env.advance(61_000);
	const asked = await env.visitor('POST', '/v1/sign-in/phone/code', { phone });
	expect(asked.status).toBe(202);
	return lastCode();
};
/** The user as the staff list shows it. @param {string} id */
const userOf = async (id) => (await env.serverCall('GET', `/v1/users/${id}`)).json;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => ![...OFF, 'phone_code'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
	await env.setting('phone', 'defaultCallingCode', '+44');
	await env.setting('phone', 'trunkPrefix', '0');
	await env.setting('phone_password', 'selfReset', 'code');
});
afterAll(async () => {
	await env.product.close();
});

describe('phone + password sign-up proves the number first (Phone code is off)', () => {
	it('asks for the code of the number; the sign-up needs it, once, and makes the number proven', async () => {
		const body = { phone: '07700 900701', password: 'first pass 123', name: 'Una' };
		// no code, a wrong code: no account
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', body))).toBe('code_invalid');
		const sent = await askCode('+447700900701');
		expect(env.messages().at(-1)).toMatchObject({ template: 'accounts.phone_code', to: { phone: '+447700900701' } });
		const wrong = sent === '000000' ? '111111' : '000000';
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { ...body, code: wrong }))).toBe('code_invalid');
		expect(
			code(await env.visitor('POST', '/v1/sign-in/phone-password', { phone: '+447700900701', password: body.password })),
		).toBe('sign_in_failed');
		// the right code: a proven number
		const up = await env.visitor('POST', '/v1/sign-up/phone-password', { ...body, code: sent });
		expect(up.json).toMatchObject({ status: 'signed_in', user: { phone: '+447700900701', phoneVerified: true, name: 'Una' } });
		// used up, and a code of another number is no proof of this one
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { ...body, code: sent }))).toBe('code_invalid');
		await askCode('+447700900702');
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { ...body, phone: '+447700900702', code: sent }))).toBe(
			'code_invalid',
		);
		// a fresh code for a number that has its account: the account exists
		expect(
			code(await env.visitor('POST', '/v1/sign-up/phone-password', { ...body, code: await askCode('+447700900701') })),
		).toBe('already_exists');
		// the number and password sign in as before
		expect(
			(await env.visitor('POST', '/v1/sign-in/phone-password', { phone: '+447700900701', password: body.password })).json
				.status,
		).toBe('signed_in');
	});

	it('a number held by someone else cannot be signed up by guessing: the code goes to the number’s owner', async () => {
		await askCode(VICTIM);
		const stolen = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: VICTIM,
			password: 'attacker pass 12',
			name: 'Mallory',
			code: '123456' === lastCode() ? '654321' : '123456',
		});
		expect(code(stolen)).toBe('code_invalid');
		expect(code(await env.visitor('POST', '/v1/sign-in/phone-password', { phone: VICTIM, password: 'attacker pass 12' }))).toBe(
			'sign_in_failed',
		);
	});

	it('a sign-in code from staff proves nothing about a number at sign-up, and still opens its user', async () => {
		const typed = await env.typedPhoneSignUp({ phone: '+447700900703', name: 'Tess Typed', password: 'typed pass 123' });
		const issued = await env.serverCall('POST', `/v1/users/${typed.json.user.id}/sign-in-code`);
		expect(issued.json.code).toMatch(/^\d{6}$/);
		expect(
			code(
				await env.visitor('POST', '/v1/sign-up/phone-password', {
					phone: '+447700900703',
					password: 'taker pass 1234',
					name: 'Taker',
					code: issued.json.code,
				}),
			),
		).toBe('code_invalid');
		// today's behavior: the staff code opens the account it was made for, in the password box
		const opened = await env.visitor('POST', '/v1/sign-in/phone-password', {
			phone: '+447700900703',
			password: issued.json.code,
		});
		expect(opened.json).toMatchObject({ status: 'signed_in', user: { id: typed.json.user.id } });
	});

	it('a code that proves the number takes it off an account that held it unproven', async () => {
		const typed = await env.typedPhoneSignUp({ phone: '+447700900704', name: 'Ivy Typed', password: 'typed pass 123' });
		expect(typed.json.user).toMatchObject({ phone: '+447700900704', phoneVerified: false });
		const sent = await askCode('+447700900704');
		const up = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900704',
			password: 'owner pass 1234',
			name: 'Ivy Owner',
			code: sent,
		});
		expect(up.json).toMatchObject({ status: 'signed_in', user: { phone: '+447700900704', phoneVerified: true } });
		expect(up.json.user.id).not.toBe(typed.json.user.id);
		const old = await userOf(typed.json.user.id);
		expect(old).toMatchObject({ phone: null, phoneVerified: false, email: 'ivy.typed@example.com' });
		const entry = (await env.serverCall('GET', '/v1/activity?action=user.phone_removed')).json.items[0];
		expect(entry).toMatchObject({ target: typed.json.user.id, label: 'Ivy Typed', values: { reason: 'proven_by_another' } });
	});
});

describe('phone code sign-in and the phone password reset open only a proven number', () => {
	beforeAll(async () => {
		await env.switchOn(ALL.filter((key) => !OFF.includes(key)));
	});

	it('the attack: an account made with the victim’s number and the attacker’s password is not the victim’s way in', async () => {
		// the attacker signs up by email, typing the victim's number (no code goes to it)
		const attacker = await env.typedPhoneSignUp({ phone: VICTIM, name: 'Mallory', password: 'attacker pass 12' });
		expect(attacker.json.user).toMatchObject({ phone: VICTIM, phoneVerified: false });
		const attackerId = attacker.json.user.id;
		// the victim signs in with the code that went to their phone
		const sent = await askCode(VICTIM);
		const victim = await env.visitor('POST', '/v1/sign-in/phone', { phone: VICTIM, code: sent, name: 'Vic' });
		expect(victim.json).toMatchObject({ status: 'signed_in', user: { phone: VICTIM, phoneVerified: true } });
		// a new account of their own, not the attacker's
		expect(victim.json.user.id).not.toBe(attackerId);
		const mine = await userOf(attackerId);
		expect(mine).toMatchObject({ phone: null, phoneVerified: false });
		// the attacker's password opens neither the victim's account nor, by the number, their own
		expect(code(await env.visitor('POST', '/v1/sign-in/phone-password', { phone: VICTIM, password: 'attacker pass 12' }))).toBe(
			'sign_in_failed',
		);
		const own = await env.visitor('POST', '/v1/sign-in/password', {
			email: 'mallory@example.com',
			password: 'attacker pass 12',
		});
		expect(own.json).toMatchObject({ status: 'signed_in', user: { id: attackerId } });
		expect((await env.visitor('GET', '/v1/me', undefined, own.json.signIn)).json.phone).toBeNull();
		// the victim's session is theirs: the attacker's account shows none of it
		expect((await env.visitor('GET', '/v1/me', undefined, victim.json.signIn)).json.id).toBe(victim.json.user.id);
	});

	it('a proven number still signs in by code, and the code asked before the account exists works at once', async () => {
		const first = await env.visitor('POST', '/v1/sign-in/phone', {
			phone: '+447700900705',
			code: await askCode('+447700900705'),
			name: 'Pam',
		});
		expect(first.json).toMatchObject({ status: 'signed_in', user: { phoneVerified: true } });
		const again = await env.visitor('POST', '/v1/sign-in/phone', {
			phone: '+447700900705',
			code: await askCode('+447700900705'),
		});
		expect(again.json).toMatchObject({ status: 'signed_in', user: { id: first.json.user.id } });
	});

	it('a sign-in code from staff still opens the account it was made for, unproven number or not', async () => {
		const typed = await env.typedPhoneSignUp({ phone: '+447700900706', name: 'Sid Typed', password: 'typed pass 123' });
		const issued = await env.serverCall('POST', `/v1/users/${typed.json.user.id}/sign-in-code`);
		const opened = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900706', code: issued.json.code });
		expect(opened.json).toMatchObject({ status: 'signed_in', user: { id: typed.json.user.id, phoneVerified: true } });
	});

	it('Forgot password treats an unproven number as unknown: the same answer, no code, nothing to reset', async () => {
		const typed = await env.typedPhoneSignUp({ phone: '+447700900707', name: 'Rex Typed', password: 'typed pass 123' });
		const before = env.messages().length;
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '+447700900707' })).status).toBe(202);
		expect(env.messages()).toHaveLength(before);
		// a code asked for the number from the sign-in screen cannot reset the account either
		const sent = await askCode('+447700900707');
		expect(
			code(
				await env.visitor('POST', '/v1/password/phone/reset', {
					phone: '+447700900707',
					code: sent,
					password: 'new pass 123456',
				}),
			),
		).toBe('code_invalid');
		expect(
			(await env.visitor('POST', '/v1/sign-in/password', { email: 'rex.typed@example.com', password: 'typed pass 123' })).json
				.user.id,
		).toBe(typed.json.user.id);
	});
});
