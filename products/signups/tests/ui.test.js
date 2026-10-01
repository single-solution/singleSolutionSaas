/** Mode A renderers (sign-in widget, account pages) on a fake DOM: structure, a11y attributes, tokens only, wiring. */
import { describe, expect, it, vi } from 'vitest';
import { render as renderAccount, styles as accountStyles } from '../ui/account.js';
import { render as renderSignIn, styles as signInStyles } from '../ui/signIn.js';
import en from '../strings/en.json' with { type: 'json' };
import { createFakeDom, findAll } from './helpers.js';

const dom = createFakeDom();
/** @param {any} root @param {string} tag */
const tags = (root, tag) => findAll(root, (node) => node.tag === tag);
/** @param {any} root @param {string} text */
const byText = (root, text) => findAll(root, (node) => node.tag === 'button' && node.textContent === text)[0];

/** @param {Partial<import('../headless/signIn.js').SignInState>} [over] */
const signInState = (over = {}) =>
	/** @type {import('../headless/signIn.js').SignInState} */ ({
		status: 'idle',
		method: 'otp',
		channel: 'email',
		channels: ['email', 'sms'],
		methods: ['otp', 'magic_link'],
		autofill: true,
		identifier: '',
		code: '',
		destination: null,
		challengeId: null,
		codeLength: 6,
		resendAt: 0,
		consents: [],
		customer: null,
		error: null,
		errorCode: null,
		...over,
	});

const actions = () => ({
	setChannel: vi.fn(),
	setMethod: vi.fn(),
	setIdentifier: vi.fn(),
	setCode: vi.fn(),
	requestCode: vi.fn(),
	verify: vi.fn(),
	requestLink: vi.fn(),
	toggleConsent: vi.fn(),
	acceptConsents: vi.fn(),
	reset: vi.fn(),
	signOut: vi.fn(),
	setPage: vi.fn(),
	revokeSession: vi.fn(),
	revokeAll: vi.fn(),
	exportData: vi.fn(),
	requestDeletion: vi.fn(),
	cancelDeletion: vi.fn(),
	acceptConsents2: vi.fn(),
});

describe('sign-in renderer', () => {
	it('uses design tokens only', () => {
		expect(signInStyles).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
		expect(accountStyles).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
		expect(signInStyles).toContain('prefers-reduced-motion');
	});

	it('renders the identifier step as a labelled form (modal dialog) and wires inputs and channels', () => {
		const a = actions();
		const slots = { before: dom.createTextNode('B'), after: dom.createTextNode('A') };
		const root = renderSignIn({ state: signInState(), actions: a, strings: en, theme: { variant: 'modal' }, slots, dom });
		expect(root.attributes).toMatchObject({
			role: 'dialog',
			'aria-modal': 'true',
			'aria-labelledby': 'ss-signin-title',
			class: 'ss-signin ss-signin--modal',
		});
		const input = tags(root, 'input')[0];
		expect(input.attributes).toMatchObject({ type: 'email', autocomplete: 'email', id: 'ss-signin-identifier' });
		expect(tags(root, 'label')[0].attributes.for).toBe('ss-signin-identifier');
		input.dispatch('input', { target: { value: 'a@b.com' } });
		expect(a.setIdentifier).toHaveBeenCalledWith('a@b.com');
		const prevent = vi.fn();
		tags(root, 'form')[0].dispatch('submit', { preventDefault: prevent });
		expect(prevent).toHaveBeenCalled();
		expect(a.requestCode).toHaveBeenCalled();
		const sms = byText(root, en['signin.channel.sms']);
		expect(sms.attributes['aria-pressed']).toBe('false');
		sms.dispatch('click');
		expect(a.setChannel).toHaveBeenCalledWith('sms');
		byText(root, en['signin.send_link']).dispatch('click');
		expect(a.setMethod).toHaveBeenCalledWith('magic_link');
		byText(root, en['signin.close']).dispatch('click');
		expect(a.reset).toHaveBeenCalled();
		expect(root.textContent).toContain('B');
		expect(root.textContent).toContain('A');
		const phone = renderSignIn({
			state: signInState({ channel: 'sms', status: 'sending', error: 'Nope' }),
			actions: a,
			strings: en,
			theme: { variant: 'inline' },
			dom,
		});
		expect(phone.attributes.role).toBe('region');
		expect(tags(phone, 'input')[0].attributes).toMatchObject({ type: 'tel', autocomplete: 'tel' });
		expect(findAll(phone, (n) => n.attributes?.role === 'alert')[0].textContent).toBe('Nope');
		expect(phone.textContent).toContain(en['signin.working']);
		const link = renderSignIn({ state: signInState({ method: 'magic_link' }), actions: a, strings: en, dom });
		tags(link, 'form')[0].dispatch('submit', {});
		expect(a.requestLink).toHaveBeenCalled();
	});

	it('renders the code step with one-time-code autofill, resend and change', () => {
		const a = actions();
		const root = renderSignIn({
			state: signInState({ status: 'code_sent', challengeId: 'otp_1', destination: 'a•••@b.com' }),
			actions: a,
			strings: en,
			dom,
		});
		expect(root.textContent).toContain('a•••@b.com');
		const input = tags(root, 'input')[0];
		expect(input.attributes).toMatchObject({ autocomplete: 'one-time-code', inputmode: 'numeric' });
		input.dispatch('input', { target: { value: '123456' } });
		expect(a.setCode).toHaveBeenCalledWith('123456');
		tags(root, 'form')[0].dispatch('submit', {});
		expect(a.verify).toHaveBeenCalled();
		byText(root, en['signin.code.resend']).dispatch('click');
		expect(a.requestCode).toHaveBeenCalled();
		byText(root, en['signin.code.change']).dispatch('click');
		expect(a.reset).toHaveBeenCalled();
		const off = renderSignIn({
			state: signInState({ status: 'verifying', challengeId: 'otp_1', autofill: false, code: 'AB' }),
			actions: a,
			strings: en,
			dom,
		});
		expect(tags(off, 'input')[0].attributes).toMatchObject({ autocomplete: 'off', inputmode: 'text' });
		expect(findAll(off, (n) => n.tag === 'button' && n.attributes.type === 'submit')[0].attributes.disabled).toBe('');
	});

	it('renders link sent, consent and signed-in states', () => {
		const a = actions();
		const sent = renderSignIn({
			state: signInState({ status: 'link_sent', destination: 'a•••@b.com' }),
			actions: a,
			strings: en,
			dom,
		});
		expect(sent.textContent).toContain('a•••@b.com');
		byText(sent, en['signin.code.change']).dispatch('click');
		const consent = renderSignIn({
			state: signInState({
				status: 'consent',
				consents: [
					{ key: 'terms', version: '2', title: 'Terms', url: 'https://x/terms', accepted: true },
					{ key: 'news', version: '1', accepted: false },
				],
			}),
			actions: a,
			strings: en,
			dom,
		});
		const boxes = tags(consent, 'input');
		expect(boxes[0].attributes).toMatchObject({ type: 'checkbox', checked: '' });
		boxes[1].dispatch('change', { target: { checked: true } });
		expect(a.toggleConsent).toHaveBeenCalledWith('news', true);
		expect(tags(consent, 'a')[0].attributes).toMatchObject({ href: 'https://x/terms', rel: 'noopener' });
		byText(consent, en['signin.consent.continue']).dispatch('click');
		expect(a.acceptConsents).toHaveBeenCalled();
		const signedIn = renderSignIn({
			state: signInState({ status: 'signed_in' }),
			actions: a,
			strings: en,
			slots: { signed_in: dom.createTextNode('Hi') },
			dom,
		});
		expect(signedIn.textContent).toContain('Hi');
		byText(signedIn, en['signin.sign_out']).dispatch('click');
		expect(a.signOut).toHaveBeenCalled();
		// actions may be partial (headless consumers can pass subsets)
		const bare = renderSignIn({ state: signInState(), actions: {}, strings: en, dom });
		tags(bare, 'form')[0].dispatch('submit', {});
		tags(bare, 'input')[0].dispatch('input', {});
	});
});

/** @param {Partial<import('../headless/account.js').AccountState>} [over] */
const accountState = (over = {}) =>
	/** @type {import('../headless/account.js').AccountState} */ ({
		status: 'ready',
		page: 'profile',
		pages: ['profile', 'addresses', 'sessions', 'orders', 'consents', 'data'],
		layout: 'tabs',
		customer: {
			id: 'cus_1',
			email: 'a@b.com',
			phone: '+14155550100',
			verified: { email: 'verified', phone: 'unverified' },
			profile: { name: 'Ada' },
			addresses: [{ id: 'adr_1', line1: '1 Way', city: 'Oslo', country: 'NO' }],
		},
		fields: [{ key: 'name', label: 'Name' }, { key: 'vip' }],
		sessions: [
			{ id: 'ses_1', current: true, device: { label: 'Safari on iOS' }, lastUsedAt: '2026-10-01T00:00:00Z' },
			{ id: 'ses_2', current: false, device: { label: 'Firefox on Linux' }, lastUsedAt: '2026-09-01T00:00:00Z' },
		],
		orders: [{ orderId: 'ord_1', number: '1001', status: 'completed', placedAt: '2026-09-02T00:00:00Z' }],
		consents: [
			{ key: 'terms', title: 'Terms', version: '2', accepted: { version: '2', acceptedAt: '2026-09-03T00:00:00Z' } },
			{ key: 'news', version: '1', accepted: null },
		],
		data: { export: true, delete: true, pendingDeletion: null },
		busy: false,
		notice: null,
		error: null,
		...over,
	});

describe('account renderer', () => {
	it('renders keyboard tabs and each section', () => {
		const a = actions();
		/** @param {string} page */
		const at = (page) => renderAccount({ state: accountState({ page }), actions: /** @type {any} */ (a), strings: en, dom });
		const profile = at('profile');
		const tablist = findAll(profile, (n) => n.attributes?.role === 'tablist')[0];
		const tabs = findAll(tablist, (n) => n.attributes?.role === 'tab');
		expect(tabs).toHaveLength(6);
		expect(tabs[0].attributes).toMatchObject({
			'aria-selected': 'true',
			tabindex: '0',
			'aria-controls': 'ss-account-panel-profile',
		});
		expect(tabs[1].attributes).toMatchObject({ 'aria-selected': 'false', tabindex: '-1' });
		tabs[2].dispatch('click');
		expect(a.setPage).toHaveBeenCalledWith('sessions');
		expect(profile.textContent).toContain('a@b.com');
		expect(profile.textContent).toContain(en['account.profile.verified']);
		expect(profile.textContent).toContain(en['account.profile.unverified']);
		expect(profile.textContent).toContain('Ada');
		expect(at('addresses').textContent).toContain('1 Way, Oslo, NO');
		const sessions = at('sessions');
		expect(sessions.textContent).toContain(en['account.sessions.current']);
		byText(sessions, en['account.sessions.revoke']).dispatch('click');
		expect(a.revokeSession).toHaveBeenCalledWith('ses_2');
		byText(sessions, en['account.sessions.revoke_all']).dispatch('click');
		expect(a.revokeAll).toHaveBeenCalled();
		expect(at('orders').textContent).toContain(en['account.orders.status.completed']);
		const consents = at('consents');
		expect(consents.textContent).toContain('2026-09-03');
		byText(consents, en['signin.consent.continue']).dispatch('click');
		expect(a.acceptConsents).toHaveBeenCalledWith([{ key: 'news', version: '1' }]);
		const data = at('data');
		byText(data, en['account.data.export']).dispatch('click');
		byText(data, en['account.data.delete']).dispatch('click');
		expect(a.exportData).toHaveBeenCalled();
		expect(a.requestDeletion).toHaveBeenCalled();
		const pending = renderAccount({
			state: accountState({
				page: 'data',
				data: { export: false, delete: true, pendingDeletion: { effectiveAt: '2026-10-15T00:00:00Z' } },
			}),
			actions: /** @type {any} */ (a),
			strings: en,
			dom,
		});
		expect(pending.textContent).toContain('2026-10-15');
		byText(pending, en['account.data.cancel']).dispatch('click');
		expect(a.cancelDeletion).toHaveBeenCalled();
		const nothing = renderAccount({
			state: accountState({ page: 'data', data: null }),
			actions: /** @type {any} */ (a),
			strings: en,
			dom,
		});
		expect(tags(nothing, 'button').filter((b) => b.attributes.role !== 'tab')).toHaveLength(0);
	});

	it('renders stacked sections, empty states, loading, errors and signed-out', () => {
		const a = actions();
		const stacked = renderAccount({
			state: accountState({ layout: 'stacked', customer: { id: 'c', verified: {} }, sessions: [], orders: [], consents: [] }),
			actions: /** @type {any} */ (a),
			strings: en,
			slots: { empty: dom.createTextNode('∅') },
			dom,
		});
		expect(stacked.attributes.class).toBe('ss-account ss-account--stacked');
		expect(tags(stacked, 'section')).toHaveLength(7); // the root and one per page
		expect(stacked.textContent).toContain('∅');
		const variant = renderAccount({
			state: accountState(),
			actions: /** @type {any} */ (a),
			strings: en,
			theme: { variant: 'stacked' },
			dom,
		});
		expect(variant.attributes.class).toContain('stacked');
		const loading = renderAccount({
			state: accountState({ status: 'loading', customer: null }),
			actions: /** @type {any} */ (a),
			strings: en,
			dom,
		});
		expect(loading.attributes['aria-busy']).toBe('true');
		expect(loading.textContent).toContain(en['account.loading']);
		const error = renderAccount({
			state: accountState({ status: 'error', customer: null, error: 'Broken' }),
			actions: /** @type {any} */ (a),
			strings: en,
			dom,
		});
		expect(findAll(error, (n) => n.attributes?.class === 'ss-account__error')[0].textContent).toBe('Broken');
		const out = renderAccount({
			state: accountState({ status: 'signed_out', customer: null }),
			actions: /** @type {any} */ (a),
			strings: en,
			slots: { before: dom.createTextNode('<'), after: dom.createTextNode('>') },
			dom,
		});
		expect(out.textContent).toContain(en['account.signin_required']);
		const notice = renderAccount({ state: accountState({ notice: 'Saved.' }), actions: {}, strings: en, dom });
		expect(findAll(notice, (n) => n.attributes?.role === 'status')[0].textContent).toBe('Saved.');
		const bare = renderAccount({ state: accountState({ page: 'sessions' }), actions: {}, strings: en, dom });
		for (const button of tags(bare, 'button')) button.dispatch('click');
	});
});
