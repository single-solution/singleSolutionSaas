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

/** The random value the widget of the browser that started a sign-in keeps in its sessionStorage. */
const BROWSER = 'Zk3-_a9QpLm0Xv7TcRw2Ys4HdUe6NfBj1GiOqAtK5Mx';
const OTHER_BROWSER = 'Qw8-_e5RtYu1Io3PaSd7FgHj9KlZx2CvBn4MmA6LpOk';

let counter = 0;
/**
 * Start a Facebook sign-in, let the provider send the person back, and return the hand-over code.
 * @param {Record<string, unknown>} [extra] what the start also gets (the browser's own value by default)
 */
const handoff = async (extra = {}) => {
	counter += 1;
	const started = await env.visitor('POST', '/v1/sign-in/facebook/start', {
		returnTo: `${ORIGIN}/account`,
		binding: BROWSER,
		...extra,
	});
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
			env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: BROWSER }),
			env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: BROWSER }),
		]);
		const signedIn = [one, two].filter((res) => res.json?.status === 'signed_in');
		expect(signedIn).toHaveLength(1);
		expect([one, two].filter((res) => code(res) === 'code_invalid')).toHaveLength(1);
		expect(code(await env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: BROWSER }))).toBe('code_invalid');
	});

	it('a refusal a retry can fix (a consent to accept) leaves the code alive; the retry signs in once', async () => {
		await env.switchOn(['email_password', 'facebook', 'consents']);
		const value = await handoff();
		const asked = await env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: BROWSER });
		expect(code(asked)).toBe('consent_required');
		const [one, two] = await Promise.all([
			env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: BROWSER, consents: { terms: true } }),
			env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: BROWSER, consents: { terms: true } }),
		]);
		expect([one, two].filter((res) => res.json?.status === 'signed_in')).toHaveLength(1);
		expect([one, two].filter((res) => code(res) === 'code_invalid')).toHaveLength(1);
		await env.switchOn(['email_password', 'facebook']);
	});
});

describe('SR-4-4: a social sign-in is tied to the browser that started it', () => {
	it('a hand-over link finished by another browser (or by one with no value) signs nobody in; the browser that started it still can', async () => {
		// the attacker starts and finishes a sign-in with their own account, then sends the link to the victim
		const value = await handoff();
		expect(code(await env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: OTHER_BROWSER }))).toBe(
			'code_invalid',
		);
		expect(code(await env.visitor('POST', '/v1/sign-in/exchange', { code: value }))).toBe('code_invalid');
		expect(code(await env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: 'short' }))).toBe('code_invalid');
		// the refusals did not use the code up
		const done = await env.visitor('POST', '/v1/sign-in/exchange', { code: value, binding: BROWSER });
		expect(done.json.status).toBe('signed_in');
	});

	it('the start needs the browser value (32 to 128 letters, digits, - and _)', async () => {
		const start = (/** @type {Record<string, unknown>} */ extra) =>
			env.visitor('POST', '/v1/sign-in/facebook/start', { returnTo: `${ORIGIN}/account`, ...extra });
		expect(code(await start({}))).toBe('validation_failed');
		expect(code(await start({ binding: 'short' }))).toBe('validation_failed');
		expect(code(await start({ binding: 'x'.repeat(129) }))).toBe('validation_failed');
		expect(code(await start({ binding: `${'x'.repeat(40)} !` }))).toBe('validation_failed');
		expect(code(await start({ binding: 42 }))).toBe('validation_failed');
		expect((await start({ binding: BROWSER })).status).toBe(200);
	});

	it('the hand-over record keeps only a hash of the browser value', async () => {
		const value = await handoff();
		const store = await env.store();
		const record = await store.codes.get(String(value).split('.')[0] ?? '');
		expect(JSON.stringify(record)).not.toContain(BROWSER);
		expect(String(record?.data.binding)).toMatch(/^[0-9a-f]{64}$/);
	});
});
