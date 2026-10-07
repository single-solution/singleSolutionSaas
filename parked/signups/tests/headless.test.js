/** Mode B headless cores (sign-in widget, account pages), the browser session store and the Mode C client adapter. */
import { describe, expect, it, vi } from 'vitest';
import { createAccount } from '../headless/account.js';
import { createSignupsClient } from '../headless/client.js';
import { createSessionStore, deviceIdOf } from '../headless/session.js';
import { createSignIn } from '../headless/signIn.js';
import en from '../strings/en.json' with { type: 'json' };

const T = Date.parse('2026-10-01T10:00:00Z');
const later = (/** @type {number} */ ms) => new Date(T + ms).toISOString();
const tokens = (/** @type {Partial<Record<string, string>>} */ over = {}) => ({
	accessToken: 'acc',
	expiresAt: later(15 * 60_000),
	refreshToken: 'rt1.ses_x.secret',
	refreshExpiresAt: later(30 * 86_400_000),
	sessionId: 'ses_x',
	...over,
});
/** @param {any} value */
const ok = (value) => ({ ok: /** @type {const} */ (true), value });
/** @param {string} code @param {any} [extra] */
const err = (code, extra = {}) => ({ ok: /** @type {const} */ (false), error: { code, ...extra } });

/** A storage double. */
const memory = () => {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		map,
		getItem: (/** @type {string} */ k) => map.get(k) ?? null,
		setItem: (/** @type {string} */ k, /** @type {string} */ v) => void map.set(k, v),
		removeItem: (/** @type {string} */ k) => void map.delete(k),
	};
};

describe('session store', () => {
	it('persists tokens, exposes the access token while valid and refreshes early (single flight)', async () => {
		let now = T;
		const storage = memory();
		const store = createSessionStore({ storage, now: () => now });
		expect(store.current()).toBeNull();
		const listener = vi.fn();
		const off = store.subscribe(listener);
		store.save(tokens());
		expect(listener).toHaveBeenCalledTimes(1);
		off();
		expect(store.token()).toBe('acc');
		expect(createSessionStore({ storage, now: () => now }).current()?.sessionId).toBe('ses_x');
		const refresh = vi.fn(async () => ok({ tokens: tokens({ accessToken: 'acc2', expiresAt: later(40 * 60_000) }) }));
		expect(await store.ensureFresh({ refresh })).toBe(true);
		expect(refresh).not.toHaveBeenCalled();
		now = T + 14.8 * 60_000;
		const [a, b] = await Promise.all([store.ensureFresh({ refresh }), store.ensureFresh({ refresh })]);
		expect(a && b).toBe(true);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(store.token()).toBe('acc2');
		now = T + 39.9 * 60_000;
		expect(await store.ensureFresh({ refresh: async () => err('network_error') })).toBe(true); // kept for a retry
		expect(await store.ensureFresh({ refresh: async () => err('refresh_reused') })).toBe(false);
		expect(store.current()).toBeNull();
		expect(storage.map.size).toBe(0);
		expect(await store.ensureFresh({ refresh })).toBe(false);
	});

	it('drops expired sessions and survives broken storage', async () => {
		let now = T;
		const store = createSessionStore({ now: () => now });
		store.save(tokens());
		now = T + 31 * 86_400_000;
		expect(store.current()).toBeNull();
		expect(store.token()).toBeNull();
		expect(await store.ensureFresh({ refresh: async () => ok({}) })).toBe(false);
		const broken = {
			getItem: () => '{bad',
			setItem: () => {
				throw new Error('full');
			},
			removeItem: () => {
				throw new Error('x');
			},
		};
		const resilient = createSessionStore({ storage: broken, now: () => T });
		expect(resilient.current()).toBeNull();
		resilient.save(tokens());
		expect(resilient.current()?.accessToken).toBe('acc');
		resilient.clear();
		expect(createSessionStore({ storage: { getItem: () => '{"x":1}', setItem() {}, removeItem() {} } }).current()).toBeNull();
	});

	it('keeps a stable device id', () => {
		const storage = memory();
		const id = deviceIdOf({ storage, random: () => 'abc$def_123456' });
		expect(id).toBe('abcdef_123456');
		expect(deviceIdOf({ storage, random: () => 'other-id-999' })).toBe(id);
		expect(deviceIdOf({ random: () => 'no-storage-1' })).toBe('no-storage-1');
		const broken = {
			getItem: () => {
				throw new Error('x');
			},
			setItem: () => {
				throw new Error('x');
			},
			removeItem() {},
		};
		expect(deviceIdOf({ storage: broken, random: () => 'fallback-01' })).toBe('fallback-01');
	});
});

describe('client adapter', () => {
	it('maps every operation onto the element API', async () => {
		/** @type {Array<[string, string, unknown]>} */
		const calls = [];
		const record = (/** @type {string} */ method) => async (/** @type {string} */ path, /** @type {unknown} */ body) => {
			calls.push([method, path, body]);
			return ok(null);
		};
		const client = createSignupsClient({
			api: { get: record('GET'), post: record('POST'), patch: record('PATCH'), delete: record('DELETE') },
		});
		await client.requestCode({ channel: 'email', to: 'a@b.com' });
		await client.verifyCode('otp/1', { code: '1' });
		await client.requestLink({ email: 'a@b.com' });
		await client.consumeLink({ token: 't' });
		await client.refresh('r');
		await client.logout('r');
		await client.account();
		await client.updateProfile({ profile: {} });
		await client.revokeSession('ses 1');
		await client.revokeAll();
		await client.requestData('export');
		await client.downloadExport('dsr_1');
		await client.cancelDataRequest('dsr_1');
		await client.acceptConsents([{ key: 'terms', version: '1' }]);
		expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
			'POST /v1/otp',
			'POST /v1/otp/otp%2F1/verify',
			'POST /v1/magic-links',
			'POST /v1/magic-links:consume',
			'POST /v1/sessions:refresh',
			'POST /v1/sessions:logout',
			'GET /v1/account',
			'PATCH /v1/profile',
			'DELETE /v1/sessions/ses%201',
			'POST /v1/sessions:revoke-all',
			'POST /v1/data-requests',
			'GET /v1/data-requests/dsr_1/export',
			'DELETE /v1/data-requests/dsr_1',
			'POST /v1/consents',
		]);
	});
});

/** A scripted sign-in client. */
const signInClient = (/** @type {Record<string, any>} */ over = {}) => ({
	requestCode: vi.fn(async () => ok({ challengeId: 'otp_1', destination: 'a•••@b.com', resendAfter: 60, codeLength: 6 })),
	verifyCode: vi.fn(async () => ok({ customer: { id: 'cus_1' }, created: true, tokens: tokens() })),
	requestLink: vi.fn(async () => ok({ challengeId: 'mlk_1', destination: 'a•••@b.com' })),
	consumeLink: vi.fn(async () => ok({ customer: { id: 'cus_1' }, created: false, tokens: tokens() })),
	logout: vi.fn(async () => ok(null)),
	...over,
});

describe('sign-in widget (headless)', () => {
	it('walks identifier → code → signed in, emitting events without personal data', async () => {
		let now = T;
		const session = createSessionStore({ now: () => now });
		const emit = vi.fn();
		const client = signInClient();
		const w = createSignIn({
			config: { channels: ['email', 'sms'], methods: ['otp', 'magic_link'], default_channel: 'sms' },
			strings: en,
			client: /** @type {any} */ (client),
			session,
			deviceId: 'device-1234',
			now: () => now,
			emit,
		});
		const states = /** @type {string[]} */ ([]);
		w.subscribe((s) => states.push(s.status));
		expect(w.state()).toMatchObject({
			status: 'idle',
			channel: 'sms',
			channels: ['email', 'sms'],
			methods: ['otp', 'magic_link'],
			autofill: true,
		});
		await w.actions.setChannel('fax');
		await w.actions.setChannel('email');
		expect(w.state().channel).toBe('email');
		await w.actions.setIdentifier('nope');
		expect((await w.actions.requestCode()).ok).toBe(false);
		expect(w.state().error).toBe(en['signin.error.identifier_invalid']);
		await w.actions.setIdentifier('a@b.com');
		const sent = await w.actions.requestCode();
		expect(sent.ok).toBe(true);
		expect(client.requestCode).toHaveBeenCalledWith({ channel: 'email', to: 'a@b.com', deviceId: 'device-1234', locale: 'en' });
		expect(w.state()).toMatchObject({ status: 'code_sent', destination: 'a•••@b.com', challengeId: 'otp_1' });
		expect(w.resendIn()).toBe(60);
		expect((await w.actions.requestCode()).ok).toBe(false); // cooldown known client-side
		expect(w.state().errorCode).toBe('too_soon');
		await w.actions.setCode('12');
		expect((await w.actions.verify()).ok).toBe(false);
		await w.actions.setCode('123 456');
		const done = await w.actions.verify();
		expect(done.ok).toBe(true);
		expect(w.state()).toMatchObject({ status: 'signed_in', customer: { id: 'cus_1' } });
		expect(session.current()?.accessToken).toBe('acc');
		expect(emit).toHaveBeenCalledWith('widget.code_requested', { channel: 'email' });
		expect(emit).toHaveBeenCalledWith('widget.signed_in', { method: 'otp', created: true });
		expect(JSON.stringify(emit.mock.calls)).not.toContain('a@b.com');
		await w.actions.signOut();
		expect(client.logout).toHaveBeenCalledWith('rt1.ses_x.secret');
		expect(w.state().status).toBe('idle');
		expect(states).toContain('verifying');
		now += 61_000;
		await w.actions.signOut(); // signed out already: no logout call
		expect(client.logout).toHaveBeenCalledTimes(1);
	});

	it('handles API failures, consent and magic links', async () => {
		const session = createSessionStore({ now: () => T });
		const client = signInClient({
			requestCode: vi.fn(async () => err('send_limit')),
			verifyCode: vi
				.fn()
				.mockResolvedValueOnce(
					err('consent_required', {
						errors: [
							{ path: '/consents/terms', code: 'required', message: '2' },
							{ path: '/consents/other', code: 'required', message: '1' },
						],
					}),
				)
				.mockResolvedValueOnce(ok({ customer: { id: 'cus_2' }, created: true, tokens: tokens() })),
			consumeLink: vi
				.fn()
				.mockResolvedValueOnce(err('link_invalid'))
				.mockResolvedValueOnce(
					err('consent_required', { errors: [{ path: '/consents/terms', code: 'required', message: '2' }] }),
				)
				.mockResolvedValueOnce(ok({ customer: { id: 'cus_3' }, created: false, tokens: tokens() })),
		});
		const w = createSignIn({
			config: { documents: [{ key: 'terms', version: '2', title: 'Terms', url: 'https://x/terms' }], methods: ['magic_link'] },
			strings: en,
			client: /** @type {any} */ (client),
			session,
		});
		expect(w.state()).toMatchObject({ method: 'magic_link', channels: ['email'] });
		await w.actions.setIdentifier('a@b.com');
		await w.actions.setMethod('otp'); // not offered
		expect(w.state().method).toBe('magic_link');
		const link = await w.actions.requestLink('https://shop.example.com/account');
		expect(link.ok).toBe(true);
		expect(w.state().status).toBe('link_sent');
		expect((await w.actions.consumeLink('ml1.bad')).ok).toBe(false);
		expect(w.state()).toMatchObject({ status: 'idle', error: en['signin.error.link_invalid'] });
		await w.actions.consumeLink('ml1.good');
		expect(w.state()).toMatchObject({
			status: 'consent',
			consents: [{ key: 'terms', version: '2', title: 'Terms', url: 'https://x/terms', accepted: false }],
		});
		expect((await w.actions.acceptConsents()).ok).toBe(false);
		await w.actions.toggleConsent('terms', true);
		const accepted = await w.actions.acceptConsents();
		expect(accepted.ok).toBe(true);
		expect(client.consumeLink).toHaveBeenLastCalledWith({ token: 'ml1.good', consents: [{ key: 'terms', version: '2' }] });
		await w.actions.reset();
		expect(w.state().status).toBe('signed_in');
		session.clear();

		const otp = createSignIn({
			config: { methods: ['otp'], code_length: 4 },
			strings: en,
			client: /** @type {any} */ (client),
			session,
		});
		await otp.actions.setIdentifier('a@b.com');
		expect((await otp.actions.requestCode()).ok).toBe(false);
		expect(otp.state()).toMatchObject({ status: 'idle', errorCode: 'send_limit', error: en['signin.error.send_limit'] });
		expect((await otp.actions.verify()).ok).toBe(false); // no challenge yet
		expect((await otp.actions.requestLink()).ok).toBe(true); // the API decides; magic_link is not in methods but the action exists
		expect(otp.validate({ identifier: '+44 20 7183 8750', channel: 'sms', code: '12 34' })).toEqual([]);
		expect(otp.validate({ identifier: 'x', channel: 'sms' })).toHaveLength(1);
		const failing = createSignIn({
			strings: en,
			client: /** @type {any} */ (signInClient({ requestLink: async () => err('weird') })),
			session,
		});
		await failing.actions.setIdentifier('a@b.com');
		expect((await failing.actions.requestLink()).ok).toBe(false);
		expect(failing.state().error).toBe(en['signin.error.request_failed']);
		await failing.actions.setIdentifier('bad');
		expect((await failing.actions.requestLink()).ok).toBe(false);
		failing.destroy();
		await failing.actions.setIdentifier('ignored');
		expect(failing.state().identifier).toBe('bad');
	});

	it('re-verifies a code with consents and keeps the code step on errors', async () => {
		const session = createSessionStore({ now: () => T });
		const client = signInClient({
			verifyCode: vi
				.fn()
				.mockResolvedValueOnce(err('code_invalid'))
				.mockResolvedValueOnce(
					err('consent_required', { errors: [{ path: '/consents/terms', code: 'required', message: '2' }] }),
				)
				.mockResolvedValueOnce(ok({ customer: { id: 'cus_4' }, created: true, tokens: tokens() })),
		});
		const w = createSignIn({
			config: {},
			strings: en,
			client: /** @type {any} */ (client),
			session,
			now: () => T + 10 * 60_000,
		});
		await w.actions.setIdentifier('a@b.com');
		await w.actions.requestCode();
		await w.actions.setCode('000000');
		expect((await w.actions.verify()).ok).toBe(false);
		expect(w.state()).toMatchObject({ status: 'code_sent', errorCode: 'code_invalid' });
		await w.actions.verify();
		expect(w.state().status).toBe('consent');
		expect(w.state().consents[0]).toMatchObject({ title: 'terms', url: '' });
		await w.actions.toggleConsent('terms', true);
		await w.actions.acceptConsents();
		expect(client.verifyCode).toHaveBeenLastCalledWith('otp_1', { code: '000000', consents: [{ key: 'terms', version: '2' }] });
		expect(w.state().status).toBe('signed_in');
	});
});

/** A scripted account client. */
const accountClient = (/** @type {Record<string, any>} */ over = {}) => ({
	refresh: vi.fn(async () => ok({ tokens: tokens() })),
	account: vi.fn(async () =>
		ok({
			layout: 'stacked',
			pages: ['profile', 'sessions', 'data'],
			customer: { id: 'cus_1', email: 'a@b.com' },
			fields: [
				{ key: 'name', type: 'text' },
				{ key: 'vip', type: 'boolean' },
				{ key: 'age', type: 'number' },
			],
			sessions: [{ id: 'ses_x', current: true }],
			data: { export: true, delete: true, pendingDeletion: { id: 'dsr_1', effectiveAt: later(86_400_000) } },
		}),
	),
	updateProfile: vi.fn(async () => ok({})),
	revokeSession: vi.fn(async () => ok(null)),
	revokeAll: vi.fn(async () => ok({ revoked: 2 })),
	requestData: vi.fn(async (/** @type {string} */ type) => ok({ id: type === 'export' ? 'dsr_e' : 'dsr_2' })),
	downloadExport: vi.fn(async () => ok({ customer: { id: 'cus_1' } })),
	cancelDataRequest: vi.fn(async () => ok({})),
	acceptConsents: vi.fn(async () => ok({})),
	...over,
});

describe('account pages (headless)', () => {
	it('loads the account, changes data and reloads, signs out everywhere', async () => {
		const session = createSessionStore({ now: () => T });
		session.save(tokens());
		const emit = vi.fn();
		const client = accountClient();
		const a = createAccount({
			config: { pages: ['profile', 'sessions'] },
			strings: en,
			client: /** @type {any} */ (client),
			session,
			emit,
		});
		expect(a.state()).toMatchObject({ status: 'idle', page: 'profile', layout: 'tabs' });
		await a.actions.load();
		expect(a.state()).toMatchObject({
			status: 'ready',
			layout: 'stacked',
			pages: ['profile', 'sessions', 'data'],
			customer: { id: 'cus_1' },
		});
		await a.actions.setPage('data');
		await a.actions.setPage('nope');
		expect(a.state().page).toBe('data');
		expect(a.validate({ profile: { name: 'x', vip: true, age: 3, other: 1 } })).toEqual([
			{ path: '/profile/other', code: 'unknown_field', message: 'other' },
		]);
		expect(a.validate({ profile: { vip: 'x', age: 'y', name: null } }).map((p) => p.path)).toEqual([
			'/profile/vip',
			'/profile/age',
		]);
		expect(a.validate(/** @type {any} */ (null))).toEqual([]);
		await a.actions.saveProfile({ profile: { name: 'Ada' } });
		expect(a.state().notice).toBe(en['account.profile.saved']);
		await a.actions.revokeSession('ses_y');
		expect(client.revokeSession).toHaveBeenCalledWith('ses_y');
		const exported = await a.actions.exportData();
		expect(exported).toEqual({ ok: true, value: { customer: { id: 'cus_1' } } });
		await a.actions.requestDeletion();
		await a.actions.cancelDeletion();
		expect(client.cancelDataRequest).toHaveBeenCalledWith('dsr_1');
		await a.actions.acceptConsents([{ key: 'terms', version: '1' }]);
		await a.actions.revokeAll();
		expect(a.state().status).toBe('signed_out');
		expect(session.current()).toBeNull();
		expect(emit).toHaveBeenCalledWith('account_pages.signed_out_everywhere', {});
		expect((await a.actions.load()).ok).toBe(false);
		expect(a.state()).toMatchObject({ status: 'signed_out', error: en['account.signin_required'] });
		a.destroy();
	});

	it('reports failures and missing pending deletions', async () => {
		const session = createSessionStore({ now: () => T });
		session.save(tokens());
		const a = createAccount({
			strings: en,
			client: /** @type {any} */ (
				accountClient({
					account: async () => err('internal_error'),
					revokeAll: async () => err('internal_error'),
					requestData: async () => err('not_allowed'),
				})
			),
			session,
		});
		expect((await a.actions.load()).ok).toBe(false);
		expect(a.state()).toMatchObject({ status: 'error', error: en['account.error.request_failed'] });
		expect((await a.actions.cancelDeletion()).ok).toBe(false);
		expect((await a.actions.exportData()).ok).toBe(false);
		expect((await a.actions.revokeAll()).ok).toBe(false);
		expect((await a.actions.saveProfile({})).ok).toBe(true);
		const b = createAccount({
			strings: en,
			client: /** @type {any} */ (accountClient({ account: async () => err('identity_invalid') })),
			session,
		});
		await b.actions.load();
		expect(b.state().status).toBe('signed_out');
		const c = createAccount({
			strings: en,
			client: /** @type {any} */ (accountClient({ updateProfile: async () => err('validation_failed') })),
			session: createSessionStore({ now: () => T }),
		});
		expect((await c.actions.saveProfile({})).ok).toBe(false);
		const d = createAccount({
			strings: en,
			client: /** @type {any} */ (accountClient({ downloadExport: async () => err('gone') })),
			session,
		});
		expect((await d.actions.exportData()).ok).toBe(false);
	});
});
