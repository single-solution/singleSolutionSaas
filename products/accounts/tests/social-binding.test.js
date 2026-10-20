/**
 * SR-4-8: a social hand-over code is single use even when two exchanges arrive at the same moment (only the call that
 * used it up signs in). SR-4-4: a social sign-in is tied to the browser that started it, so a hand-over link finished
 * by someone else's browser signs nobody in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email_password', 'facebook']);
	await env.connectDatabase();
	expect((await env.connect('facebook', { appId: '123', appSecret: 'fbsecret-9876' })).status).toBe('connected');
});
afterAll(async () => {
	await env.product.close();
});

let counter = 0;
/**
 * Start a Facebook sign-in, let the provider send the person back, and return the hand-over code.
 * @param {Record<string, unknown>} [extra] what the start also gets
 */
const handoff = async (extra = {}) => {
	counter += 1;
	const started = await env.visitor('POST', '/v1/sign-in/facebook/start', { returnTo: `${ORIGIN}/account`, ...extra });
	expect(started.status).toBe(200);
	const state = new URL(started.json.url).searchParams.get('state');
	env.responders.set('https://graph.facebook.com/v21.0/oauth/access_token', () => ({
		status: 200,
		body: { access_token: 'fb-token' },
	}));
	env.responders.set('https://graph.facebook.com/v21.0/me', () => ({
		status: 200,
		body: { id: `fb-${counter}`, name: 'Fay', email: `fay${counter}@example.com` },
	}));
	const back = await env.call('GET', `/oauth/facebook/callback?state=${state}&code=fb`);
	expect(back.status).toBe(303);
	return String(back.headers.get('location')).split('#ss_accounts_code=')[1];
};

describe('SR-4-8: a hand-over code signs in once, even when used twice at the same moment', () => {
	it('two exchanges at once give one session', async () => {
		const value = await handoff();
		const [one, two] = await Promise.all([
			env.visitor('POST', '/v1/sign-in/exchange', { code: value }),
			env.visitor('POST', '/v1/sign-in/exchange', { code: value }),
		]);
		const signedIn = [one, two].filter((res) => res.json?.status === 'signed_in');
		expect(signedIn).toHaveLength(1);
		expect([one, two].filter((res) => code(res) === 'code_invalid')).toHaveLength(1);
		expect(code(await env.visitor('POST', '/v1/sign-in/exchange', { code: value }))).toBe('code_invalid');
	});

	it('a refusal a retry can fix (a consent to accept) leaves the code alive; the retry signs in once', async () => {
		await env.switchOn(['email_password', 'facebook', 'consents']);
		const value = await handoff();
		const asked = await env.visitor('POST', '/v1/sign-in/exchange', { code: value });
		expect(code(asked)).toBe('consent_required');
		const [one, two] = await Promise.all([
			env.visitor('POST', '/v1/sign-in/exchange', { code: value, consents: { terms: true } }),
			env.visitor('POST', '/v1/sign-in/exchange', { code: value, consents: { terms: true } }),
		]);
		expect([one, two].filter((res) => res.json?.status === 'signed_in')).toHaveLength(1);
		expect([one, two].filter((res) => code(res) === 'code_invalid')).toHaveLength(1);
		await env.switchOn(['email_password', 'facebook']);
	});
});
