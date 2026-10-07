import { describe, expect, it } from 'vitest';
import { createNotifyMe, notifyMeClient } from '../headless/notifyMe.js';
import { createTranslator } from '../headless/strings.js';
import en from '../strings/en.json' with { type: 'json' };
import { createNotifyMeClient } from './helpers.js';

const config = { itemId: 'itm_1', variantId: 'v1', item: { name: 'Phone' }, price: { amount: 1000, currency: 'EUR' } };

describe('createNotifyMe (Mode B)', () => {
	it('has the standard element shape and loads the website types', async () => {
		const client = createNotifyMeClient();
		const element = createNotifyMe({ config, strings: en, client });
		expect(Object.keys(element).sort()).toEqual(['actions', 'destroy', 'state', 'strings', 'subscribe', 't', 'validate']);
		expect(element.state().status).toBe('idle');
		/** @type {string[]} */
		const seen = [];
		const off = element.subscribe((state) => seen.push(state.status));
		await element.actions.load();
		expect(element.state()).toMatchObject({
			status: 'ready',
			types: ['back_in_stock', 'price_drop'],
			type: 'back_in_stock',
			channels: ['email', 'sms'],
			allowTarget: true,
		});
		expect(seen).toEqual(['loading', 'ready']);
		off();
		expect(Object.isFrozen(element.state())).toBe(true);
	});

	it('validates the form and subscribes', async () => {
		const client = createNotifyMeClient();
		/** @type {Array<[string, any]>} */
		const events = [];
		const element = createNotifyMe({
			config: { ...config, lang: 'en' },
			strings: en,
			client,
			emit: (name, data) => events.push([name, data]),
		});
		await element.actions.load();
		const refused = await element.actions.subscribe();
		expect(refused.ok).toBe(false);
		expect(element.state().errors).toMatchObject({
			'/email': en['capture.error.required'],
			'/consent': en['capture.error.consent_required'],
		});
		await element.actions.setEmail('not-an-email');
		expect(element.validate({}).map((p) => p.code)).toEqual(['contact_invalid', 'consent_required']);
		await element.actions.setEmail('jane@example.com');
		await element.actions.setConsent(true);
		await element.actions.setType('price_drop');
		await element.actions.setTarget('abc');
		expect(element.validate({}).map((p) => p.code)).toEqual(['invalid']);
		await element.actions.setTarget('800');
		const done = await element.actions.subscribe();
		expect(done.ok).toBe(true);
		expect(client.bodies[0]).toEqual({
			type: 'price_drop',
			itemId: 'itm_1',
			variantId: 'v1',
			channel: 'email',
			email: 'jane@example.com',
			consent: true,
			lang: 'en',
			item: { name: 'Phone' },
			price: { amount: 1000, currency: 'EUR' },
			threshold: { targetAmount: 800 },
		});
		expect(element.state()).toMatchObject({ status: 'subscribed', message: 'Done — we will tell you at j•••@example.com.' });
		expect(events).toEqual([['capture.subscribed', { type: 'price_drop', channel: 'email', created: true }]]);
	});

	it('uses phones on sms, the login address when signed in, positions and confirmations', async () => {
		const client = createNotifyMeClient({ fail: { position: 4 } });
		const element = createNotifyMe({
			config: { itemId: 'itm_1', types: ['price_drop', 'availability'] },
			strings: en,
			client,
			identity: { signedIn: true },
		});
		await element.actions.load();
		expect(element.state().types).toEqual(['price_drop']);
		await element.actions.setChannel('sms');
		await element.actions.setConsent(true);
		expect(element.validate({})).toEqual([]);
		await element.actions.setPhone('12');
		expect(element.validate({}).map((p) => p.code)).toEqual(['contact_invalid']);
		await element.actions.setPhone('+44 20 7946 0958');
		await element.actions.subscribe();
		expect(client.bodies[0]).toMatchObject({ channel: 'sms', phone: '+44 20 7946 0958', lang: 'en' });
		expect(element.state().message).toBe('Done — we will tell you at j•••@example.com. You are number 4 on the waitlist.');
		const unsubscribed = await element.actions.unsubscribe();
		expect(unsubscribed.ok).toBe(true);
		expect(element.state()).toMatchObject({ status: 'unsubscribed', message: en['capture.unsubscribed'] });

		const unconfirmed = createNotifyMe({
			config,
			strings: en,
			client: createNotifyMeClient({ fail: { unconfirmed: true } }),
			identity: { signedIn: true },
		});
		await unconfirmed.actions.load();
		await unconfirmed.actions.setConsent(true);
		await unconfirmed.actions.subscribe();
		expect(unconfirmed.state().message).toBe('Check j•••@example.com and confirm your alert.');
	});

	it('maps problems to catalog messages', async () => {
		const failing = createNotifyMe({
			config,
			strings: en,
			client: createNotifyMeClient({ fail: { alertTypes: { code: 'element_disabled' } } }),
		});
		expect((await failing.actions.load()).ok).toBe(false);
		expect(failing.state()).toMatchObject({ status: 'error', message: en['capture.error.unavailable'] });

		const limited = createNotifyMe({
			config,
			strings: en,
			client: createNotifyMeClient({
				requireConsent: false,
				fail: { subscribe: { code: 'rate_limited', errors: [{ path: '/email', code: 'contact_invalid' }] } },
			}),
		});
		await limited.actions.load();
		await limited.actions.setEmail('a@b.co');
		await limited.actions.subscribe();
		expect(limited.state()).toMatchObject({
			status: 'ready',
			message: en['capture.error.rate_limited'],
			errors: { '/email': en['capture.error.contact_invalid'] },
		});

		const odd = createNotifyMe({
			config,
			strings: en,
			client: createNotifyMeClient({
				requireConsent: false,
				fail: { subscribe: { code: 'boom' }, unsubscribe: { code: 'x' } },
			}),
		});
		await odd.actions.load();
		await odd.actions.setEmail('a@b.co');
		await odd.actions.subscribe();
		expect(odd.state().message).toBe(en['capture.error.request_failed']);
		expect((await odd.actions.unsubscribe()).ok).toBe(false);
		const none = createNotifyMe({ config, strings: {}, client: createNotifyMeClient() });
		expect(none.validate({ channel: 'fax', type: null }).map((p) => p.path)).toEqual(['/type', '/email', '/consent']);
		none.destroy();
		await none.actions.load();
		expect(none.state().status).toBe('idle');
	});

	it('adapts an @ss/web element API client', async () => {
		/** @type {string[]} */
		const calls = [];
		const api = {
			get: async (/** @type {string} */ path) => (calls.push(`GET ${path}`), { ok: true, value: { items: [], capture: {} } }),
			post: async (/** @type {string} */ path) => (calls.push(`POST ${path}`), { ok: false, error: { code: 'rate_limited' } }),
			delete: async (/** @type {string} */ path) => (calls.push(`DELETE ${path}`), { ok: false }),
		};
		const client = notifyMeClient(api);
		expect(await client.alertTypes()).toEqual({ ok: true, value: { items: [], capture: {} } });
		expect(await client.subscribe({})).toEqual({ ok: false, problem: { code: 'rate_limited' } });
		expect(await client.unsubscribe('als 1')).toEqual({ ok: false, problem: { code: 'request_failed' } });
		expect(calls).toEqual(['GET /v1/alert-types', 'POST /v1/subscriptions', 'DELETE /v1/subscriptions/als%201']);
	});

	it('translates with placeholders', () => {
		const t = createTranslator({ hi: 'Hi {name} {other}' });
		expect(t('hi', { name: 'Ann' })).toBe('Hi Ann {other}');
		expect(t('missing')).toBe('missing');
	});
});
