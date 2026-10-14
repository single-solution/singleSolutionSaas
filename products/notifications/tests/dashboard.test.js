// @vitest-environment jsdom
/**
 * Settings → Templates in the browser (jsdom), on a faked dashboard API (parity P1): every product's message by
 * channel with its state — the product's default words, the merchant's edited version, switched off, or WhatsApp not set
 * up — and Edit (from the default words), Reset to default and Switch off, never for Accounts' sign-in messages.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render } from '@ss/ui/testing';
import { TemplatesSection } from '../app/dashboard/templates.js';
import { TEXTS } from '../app/dashboard/texts.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;
const T = TEXTS.settings.template;

/** The products' messages as `GET …/messages` answers them. */
const CATALOG = {
	items: [
		{
			productId: 'accounts',
			key: 'accounts.password_reset',
			name: 'Password reset link',
			values: ['link', 'minutes', 'business'],
			required: true,
			urgent: true,
			sensitive: true,
			channels: { email: { subject: 'Reset your password for {business}', text: 'Choose a new password: {link}' } },
		},
		{
			productId: 'chat',
			key: 'chat.staff_new_message',
			name: 'New chat message',
			values: ['visitor', 'preview', 'link', 'business'],
			required: true,
			channels: {
				email: { subject: 'New chat message from {visitor}', text: '{visitor}: {preview}' },
				sms: { text: 'New chat from {visitor}: {preview}' },
				whatsapp: null,
			},
		},
	],
	off: [{ key: 'chat.staff_new_message', channel: 'sms' }],
	unavailable: ['ecommerce'],
};
/** The merchant's own templates: an edited Chat alert and a key of their own. */
const TEMPLATES = {
	items: [
		{
			key: 'chat.staff_new_message',
			channel: 'email',
			language: 'default',
			subject: 'Chat: {visitor}',
			text: 'Reply soon: {preview}',
			required: true,
			urgent: false,
			sensitive: false,
			providerTemplate: '',
			buttons: [],
		},
		{
			key: 'welcome',
			channel: 'sms',
			language: 'default',
			subject: '',
			text: 'Welcome!',
			required: false,
			urgent: false,
			sensitive: false,
			providerTemplate: '',
			buttons: [],
		},
	],
};

/** @type {Array<{ path: string, method: string, body: unknown }>} */
let calls = [];
const serve = () => {
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
			const body = path === `${BASE}/messages` ? CATALOG : path === `${BASE}/templates` ? TEMPLATES : {};
			return new Response(init.method === 'DELETE' ? null : JSON.stringify(body), {
				status: init.method === 'DELETE' ? 204 : 200,
				headers: { 'content-type': 'application/json' },
			});
		}),
	);
};
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Templates: the products’ messages (parity P1)', () => {
	it('lists each message by channel with its state, then the other templates', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		const rows = [...container.querySelectorAll('li')].map((li) => li.textContent ?? '');
		expect(rows).toHaveLength(5);
		expect(rows[0]).toContain('Password reset link');
		expect(rows[0]).toContain('accounts.password_reset · Reset your password for {business}');
		expect(rows[0]).toContain(T.states.default);
		expect(rows[1]).toContain('New chat message');
		expect(rows[1]).toContain('Chat: {visitor}');
		expect(rows[1]).toContain(T.states.edited);
		expect(rows[2]).toContain(T.states.off);
		expect(rows[3]).toContain(T.states.not_set_up);
		expect(rows[3]).toContain(T.setUp);
		expect(rows[4]).toContain('welcome');
		expect(container.textContent).toContain(T.unavailable.replace('{products}', 'Ecommerce'));
	});

	it('Edit starts from the default words; the key and channel of a product’s message stay fixed', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		const first = /** @type {HTMLElement} */ (container.querySelector('li'));
		await click(byText(first, T.edit, 'button'));
		await settle();
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.textContent).toContain('Password reset link');
		expect(dialog.textContent).toContain('Template accounts.password_reset by Email, in the default language.');
		expect(dialog.textContent).toContain('Values it can use: {link}, {minutes}, {business}.');
		expect(/** @type {HTMLTextAreaElement} */ (dialog.querySelector('textarea')).value).toBe('Choose a new password: {link}');
		expect(dialog.querySelector('select')).toBeNull();
	});

	it('More: Reset to default for an edited message, Switch off and on again, nothing to switch for Accounts', async () => {
		serve();
		const { container } = render(<TemplatesSection websiteId={WEBSITE} />);
		await settle();
		const items = [...container.querySelectorAll('li')];
		// Accounts' reset link has no More menu: it cannot be switched off and has no edited version
		expect(items[0]?.querySelector('[aria-haspopup]')).toBeNull();
		const openMenu = async (/** @type {Element | undefined} */ item) => {
			await click(/** @type {Element} */ (item?.querySelector('[aria-haspopup]')));
			await settle();
		};
		await openMenu(items[1]);
		expect(document.body.textContent).toContain(T.reset);
		await click(byText(document.body, T.switchOff, '[role="menuitem"]'));
		await settle();
		expect(calls.find((call) => call.method === 'PUT')).toEqual({
			path: `${BASE}/messages/chat.staff_new_message/email`,
			method: 'PUT',
			body: { off: true },
		});
		await openMenu([...container.querySelectorAll('li')][2]);
		expect(document.body.textContent).toContain(T.switchOn);
	});
});
