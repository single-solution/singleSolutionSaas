/**
 * The merchant's own choices while sending (fixed-choices N2, N5–N9, N12): retry presets and custom waits, quiet
 * hours per weekday and channel, what send limits count, fallback channels in order (push too), unsubscribe topics
 * with recipients' choices on the hosted page, staff one-off messages as transactional or marketing (push too), and
 * the limits of webhook URLs and templates as settings. The lists are served by the kit (`/v1/lists/<name>`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, HOOK_URL, PUSH_ORIGIN, browserSubscription, pushKeys, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const ALL = [
	'email',
	'sms',
	'whatsapp',
	'browser_push',
	'staff_push',
	'webhooks',
	'fallback',
	'quiet_hours',
	'send_limits',
	'send_api',
];
const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };
const TWILIO = { provider: 'twilio', accountSid: `AC${'a'.repeat(32)}`, secret: 'twilio-token-9876', from: '+15550001111' };
const META = { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-5555' };
const MIN = 60_000;

/** Save a list with the server token. @param {string} name @param {unknown} value */
const saveList = async (name, value) => {
	const response = await env.call('PUT', `/v1/lists/${name}`, { token: env.server, body: { value } });
	return { status: response.status, json: await response.json() };
};
/** A message as the delivery log has it now. @param {string} id */
const messageOf = async (id) => (await env.call('GET', `/v1/messages/${id}`, { token: env.server })).json();
/** A use of the website: due messages and events go right after it. */
const use = () => env.call('GET', '/v1/messages?limit=1', { token: env.server });

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
	await env.connect('email', RESEND);
	await env.connect('sms', TWILIO);
	await env.connect('whatsapp', META);
	await env.connect('push_keys', pushKeys());
	await env.connect('webhook_secret', 'whsec-0123456789abcdefghijklmnop');
	await env.template({ key: 'promo', channel: 'email', subject: 'Sale', text: 'Sale {pct}. Leave: {unsubscribeUrl}' });
	await env.template({ key: 'promo', channel: 'sms', text: 'Sale {pct}' });
	await env.template({ key: 'promo', channel: 'whatsapp', text: 'Sale {pct}' });
	await env.template({ key: 'promo', channel: 'push', subject: 'Sale', text: 'Sale {pct}' });
	await env.template({ key: 'restock', channel: 'email', subject: 'Back', text: '{item} is back' });
	await env.template({ key: 'news', channel: 'email', subject: 'News', text: 'Our news' });
	await env.template({ key: 'receipt', channel: 'email', subject: 'Receipt', text: 'Paid', required: true, urgent: true });
	await env.template({ key: 'receipt', channel: 'sms', text: 'Paid', required: true, urgent: true });
	// no quiet time while the other cases run
	expect((await saveList('quiet_hours', [])).status).toBe(200);
});
afterAll(async () => {
	await env.product.close();
});

describe('the lists (kit routes)', () => {
	it('read as their defaults until saved: today’s quiet hours, no topics, no fallback channels', async () => {
		const fresh = await setup();
		try {
			await fresh.switchOn(ALL);
			await fresh.connectDatabase();
			/** @param {string} name */
			const read = async (name) =>
				(await (await fresh.call('GET', `/v1/lists/${name}`, { token: fresh.server })).json()).value;
			expect(await read('quiet_hours')).toEqual([
				{ days: [0, 1, 2, 3, 4, 5, 6], from: '21:00', until: '08:00', channels: [] },
			]);
			expect(await read('topics')).toEqual([]);
			expect(await read('template_settings')).toEqual([]);
			expect(await read('fallback_chains')).toEqual([]);
			// the dashboard twin takes the same lists
			const cookie = await fresh.adminSession();
			const path = `/v1/dashboard/websites/${fresh.websiteId}/lists/topics`;
			const saved = await fresh.dashboard(cookie, 'PUT', path, { value: [{ name: 'Promotions' }] });
			expect(await saved.json()).toEqual({ value: [{ id: 'promotions', name: 'Promotions' }] });
			const refused = await fresh.dashboard(cookie, 'PUT', path, { value: [{ name: '' }] });
			expect(refused.status).toBe(422);
			expect((await refused.json()).errors[0]).toMatchObject({ path: '/value/0/name' });
		} finally {
			await fresh.product.close();
		}
	});
});

describe('retries (N8)', () => {
	it('custom waits are kept by the message it was sent with', async () => {
		await env.setting('whatsapp', 'retryPlan', 'custom');
		await env.setting('whatsapp', 'retryWaits', [2, 10]);
		env.providers.respond('https://graph.facebook.com', () => ({ status: 503 }));
		const first = await env.send('whatsapp', { template: 'promo', to: { phone: '+15550100001' }, values: { pct: '5' } });
		expect(first.json).toMatchObject({ status: 'retrying', dueAt: new Date(env.now() + 2 * MIN).toISOString() });
		// a later change of the setting does not change a waiting message
		await env.setting('whatsapp', 'retryPlan', 'short');
		env.advance(2 * MIN + 1000);
		await use();
		const second = await messageOf(first.json.id);
		expect(second).toMatchObject({ status: 'retrying', dueAt: new Date(env.now() + 10 * MIN).toISOString() });
		env.advance(10 * MIN + 1000);
		await use();
		expect((await messageOf(first.json.id)).status).toBe('failed');
		expect((await messageOf(first.json.id)).attempts).toHaveLength(3);
		env.providers.reset('https://graph.facebook.com');
	});

	it('webhook events retry by their own setting (standard by default)', async () => {
		await saveList('webhook_urls', [{ url: HOOK_URL, events: ['message.sent'] }]);
		env.providers.respond('https://hooks.example.org', () => ({ status: 500 }));
		await env.setting('webhooks', 'retryPlan', 'custom');
		await env.setting('webhooks', 'retryWaits', [3]);
		await env.send('email', { template: 'news', to: { email: 'hook@example.com' } });
		const events = await env.merchantCollection('webhook_events');
		const event = await events.findOne({ websiteId: env.websiteId, status: 'pending' });
		expect(event?.attempts).toBe(1);
		expect(event?.dueAt.getTime()).toBe(Math.floor(env.now()) + 3 * MIN);
		env.advance(3 * MIN + 1000);
		await use();
		expect((await events.findOne({ websiteId: env.websiteId, id: event?.id }))?.status).toBe('failed');
		env.providers.reset('https://hooks.example.org');
		await saveList('webhook_urls', []);
		await env.setting('webhooks', 'retryPlan', 'standard');
	});
});

describe('quiet hours per weekday, with minutes, per channel (N6)', () => {
	it('holds only the channels and days a window names', async () => {
		// Thursday 12:10 UTC (the website's time zone is UTC without business.json)
		env.advance(Date.parse('2026-10-08T12:10:00Z') - env.now());
		const lunch = [{ days: [4], from: '12:00', until: '13:30', channels: ['sms'] }];
		expect((await saveList('quiet_hours', lunch)).json.value).toEqual(lunch);
		const sms = await env.send('sms', { template: 'promo', to: { phone: '+15550100002' }, values: { pct: '1' } });
		expect(sms.json).toMatchObject({ status: 'queued', dueAt: '2026-10-08T13:30:00.000Z' });
		const email = await env.send('email', { template: 'promo', to: { email: 'q@example.com' }, values: { pct: '1' } });
		expect(email.json.status).toBe('sent');
		// urgent messages are never held
		expect((await env.send('sms', { template: 'receipt', to: { phone: '+15550100002' } })).json.status).toBe('sent');
		await saveList('quiet_hours', []);
	});
});

describe('what send limits count (N5)', () => {
	it('counts and holds back optional messages only by default; a template can say otherwise', async () => {
		await env.setting('send_limits', 'perHour', 1);
		const to = { email: 'cap@example.com' };
		expect((await env.send('email', { template: 'news', to })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'news', to })).json).toMatchObject({ status: 'skipped', reason: 'limited' });
		// required messages always go and are not counted
		expect((await env.send('email', { template: 'receipt', to })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'receipt', to })).json.status).toBe('sent');
		// a template counted on purpose
		await saveList('template_settings', [{ key: 'receipt', capped: true }]);
		const capped = { email: 'cap2@example.com' };
		expect((await env.send('email', { template: 'receipt', to: capped })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'receipt', to: capped })).json.status).toBe('skipped');
		// a template never counted
		await saveList('template_settings', [{ key: 'news', capped: false }]);
		const free = { email: 'cap3@example.com' };
		expect((await env.send('email', { template: 'news', to: free })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'news', to: free })).json.status).toBe('sent');
		// "all": every message is counted, as before
		await saveList('template_settings', []);
		await env.setting('send_limits', 'counts', 'all');
		const every = { email: 'cap4@example.com' };
		expect((await env.send('email', { template: 'receipt', to: every })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'receipt', to: every })).json.status).toBe('skipped');
		await env.setting('send_limits', 'counts', 'optional');
		await env.setting('send_limits', 'perHour', 100);
	});
});

describe('fallback channels in order, push included (N7)', () => {
	it('moves through the website’s chain, then a template’s own chain wins', async () => {
		expect((await saveList('fallback_chains', [{ channel: 'whatsapp', then: ['sms', 'email'] }])).json.value).toEqual([
			{ channel: 'whatsapp', then: ['sms', 'email'] },
		]);
		env.providers.respond('https://graph.facebook.com', () => ({ status: 400, body: '{"error":{"code":1}}' }));
		env.providers.respond('https://api.twilio.com', () => ({ status: 400, body: '{"code":21211}' }));
		const to = { phone: '+15550100003', email: 'chain@example.com' };
		const sent = await env.send('whatsapp', { template: 'promo', to, values: { pct: '2' } });
		expect(sent.json.status).toBe('sent');
		expect(sent.json.channel).toBe('email');
		expect(sent.json.attempts.map((/** @type {any} */ a) => `${a.channel}:${a.outcome}`)).toEqual([
			'whatsapp:failed',
			'sms:failed',
			'email:sent',
		]);
		// the template's own chain: push only
		const browser = browserSubscription();
		const subscribed = await env.call('POST', '/v1/push/subscriptions', {
			token: env.browser,
			origin: 'https://shop.example.com',
			body: { subscription: browser.subscription },
		});
		const { subscriberId } = await subscribed.json();
		await saveList('template_settings', [{ key: 'promo', fallback: ['push'] }]);
		const pushed = await env.send('whatsapp', { template: 'promo', to: { ...to, subscriberId }, values: { pct: '3' } });
		expect(pushed.json).toMatchObject({ status: 'sent', channel: 'push' });
		expect(env.providers.callsTo(PUSH_ORIGIN).length).toBeGreaterThan(0);
		// staff push is no customer's fallback
		expect((await saveList('fallback_chains', [{ channel: 'sms', then: ['staff_push'] }])).status).toBe(422);
		env.providers.reset('https://graph.facebook.com');
		env.providers.reset('https://api.twilio.com');
		await saveList('template_settings', []);
		await saveList('fallback_chains', []);
	});
});

describe('unsubscribe topics (N2)', () => {
	it('recipients choose per topic; required messages stay required', async () => {
		await saveList('topics', [{ name: 'Promotions' }, { name: 'Back in stock' }]);
		expect((await saveList('template_settings', [{ key: 'promo', topic: 'nope' }])).status).toBe(422);
		await saveList('template_settings', [
			{ key: 'promo', topic: 'promotions' },
			{ key: 'restock', topic: 'back_in_stock' },
		]);
		const to = { email: 'topics@example.com' };
		const promo = await env.send('email', { template: 'promo', to, values: { pct: '9' } });
		expect(promo.json.status).toBe('sent');
		const mail = JSON.parse(env.providers.callsTo('https://api.resend.com').at(-1)?.body ?? '{}');
		const link = /\/unsubscribe\/[^>]+/.exec(mail.headers['List-Unsubscribe'])?.[0] ?? '';
		expect(link).toMatch(/\?topic=promotions$/);
		expect(mail.text).toContain(link);
		// the page lists the topics; opening it changes nothing
		const page = await (await env.call('GET', link)).text();
		expect(page).toContain('Promotions');
		expect(page).toContain('Back in stock');
		expect(page).toContain('name="topic" value="back_in_stock" checked');
		expect(page).not.toContain('name="topic" value="promotions" checked');
		// one-click unsubscribes from the link's topic only
		expect((await env.call('POST', link, { raw: 'List-Unsubscribe=One-Click' })).status).toBe(200);
		expect((await env.send('email', { template: 'promo', to, values: { pct: '9' } })).json).toMatchObject({
			status: 'skipped',
			reason: 'unsubscribed',
		});
		expect((await env.send('email', { template: 'restock', to, values: { item: 'Hat' } })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'news', to })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'receipt', to })).json.status).toBe('sent');
		// the page's form: keep Promotions after all, drop Back in stock
		const base = link.replace(/\?.*$/, '');
		expect((await env.call('POST', base, { raw: 'action=save&topic=promotions' })).status).toBe(200);
		expect((await env.send('email', { template: 'promo', to, values: { pct: '9' } })).json.status).toBe('sent');
		expect((await env.send('email', { template: 'restock', to, values: { item: 'Hat' } })).json.status).toBe('skipped');
		// unsubscribe from every optional message
		await env.call('POST', base, { raw: 'action=all' });
		expect((await env.send('email', { template: 'news', to })).json.status).toBe('skipped');
		expect((await env.send('email', { template: 'receipt', to })).json.status).toBe('sent');
		// choosing topics again lifts "every optional message"
		await env.call('POST', base, { raw: 'action=save&topic=promotions&topic=back_in_stock' });
		expect((await env.send('email', { template: 'news', to })).json.status).toBe('sent');
		await saveList('template_settings', []);
	});
});

describe('staff one-off messages (N9)', () => {
	it('are transactional by default, or marketing (optional, held by quiet hours and limits); push is allowed', async () => {
		const ticket = await env.ticket();
		/** @param {Record<string, unknown>} body */
		const oneOff = async (body) => {
			const response = await env.call('POST', '/v1/admin/messages', {
				token: ticket,
				origin: ADMIN_ORIGIN,
				body,
				headers: { 'idempotency-key': `k-${Math.random()}` },
			});
			return { status: response.status, json: await response.json() };
		};
		// an address unsubscribed from every optional message
		await env.send('email', { template: 'news', to: { email: 'staff1@example.com' } });
		const mail = JSON.parse(env.providers.callsTo('https://api.resend.com').at(-1)?.body ?? '{}');
		const link = /\/unsubscribe\/[^>?]+/.exec(mail.headers['List-Unsubscribe'])?.[0] ?? '';
		await env.call('POST', link, { raw: 'action=all' });
		const words = { channel: 'email', to: 'staff1@example.com', subject: 'Hello', text: 'Hi there' };
		expect((await oneOff(words)).json.status).toBe('sent');
		expect((await oneOff({ ...words, kind: 'marketing' })).json).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
		expect((await oneOff({ ...words, kind: 'weekly' })).status).toBe(422);
		// marketing waits for quiet hours
		await saveList('quiet_hours', [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', until: '23:59', channels: ['email'] }]);
		const held = await oneOff({ ...words, to: 'staff2@example.com', kind: 'marketing' });
		expect(held.json.status).toBe('queued');
		expect((await oneOff({ ...words, to: 'staff2@example.com' })).json.status).toBe('sent');
		await saveList('quiet_hours', []);
		// push to a subscriber
		const browser = browserSubscription(`${PUSH_ORIGIN}/push/staff-one-off`);
		const subscribed = await env.call('POST', '/v1/push/subscriptions', {
			token: env.browser,
			origin: 'https://shop.example.com',
			body: { subscription: browser.subscription },
		});
		const { subscriberId } = await subscribed.json();
		const push = await oneOff({ channel: 'push', to: subscriberId, subject: 'Hello', text: 'Your order is ready' });
		expect(push.json).toMatchObject({ status: 'sent', channel: 'push' });
		expect((await oneOff({ channel: 'push', to: 'not an id', subject: 'Hello', text: 'Hi' })).status).toBe(422);
	});
});

describe('limits as settings (N12)', () => {
	it('webhook URLs and templates follow their settings, within the system caps', async () => {
		await env.setting('webhooks', 'maxUrls', 1);
		const two = [
			{ url: 'https://hooks.example.org/a', events: [] },
			{ url: 'https://hooks.example.org/b', events: [] },
		];
		const refused = await saveList('webhook_urls', two);
		expect(refused.status).toBe(422);
		expect(refused.json.detail).toBe('Add at most 1 URLs.');
		await env.setting('webhooks', 'maxUrls', 2);
		expect((await saveList('webhook_urls', two)).status).toBe(200);
		await saveList('webhook_urls', []);
		// the schema's maximum is the system cap
		const cookie = await env.adminSession();
		const tooMany = await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/settings/webhooks.maxUrls`, {
			value: 21,
		});
		expect(tooMany.status).toBe(422);
		const count = (await (await env.call('GET', '/v1/templates', { token: env.server })).json()).items.length;
		await env.setting('templates', 'maxTemplates', count);
		const full = await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/templates`, {
			key: 'one_more',
			channel: 'sms',
			text: 'Hi',
		});
		expect(full.status).toBe(422);
		expect((await full.json()).detail).toBe(`A website can have at most ${count} templates (Settings → Templates).`);
		// replacing a saved template still works at the limit
		await env.template({ key: 'news', channel: 'email', subject: 'News', text: 'Our latest news' });
		await env.setting('templates', 'maxTemplates', 1000);
	});
});

describe('replies from any gateway and keywords per language (N4)', () => {
	it('maps a gateway’s incoming request by the merchant’s paths, checked by its token, and reads keywords in any language', async () => {
		const gateway = {
			provider: 'http',
			url: 'https://gateway.example.org/send',
			body: '{"to":"{to}","text":"{text}"}',
			inboundToken: 'in-token-0123456789abcdef',
			inboundFrom: 'message.sender',
			inboundText: 'message.body',
		};
		await env.connect('sms', gateway);
		// the keywords per language: today's English ones by default, any language added
		const read = await env.call('GET', '/v1/lists/stop_keywords', { token: env.server });
		expect((await read.json()).value).toEqual([{ language: 'en', words: ['STOP', 'UNSUBSCRIBE'] }]);
		await saveList('stop_keywords', [
			{ language: 'en', words: ['STOP'] },
			{ language: 'es', words: ['BAJA', 'CANCELAR'] },
		]);
		const path = `/v1/inbound/${env.websiteId}/sms`;
		/** @param {unknown} body @param {string} [token] */
		const reply = (body, token = gateway.inboundToken) =>
			env.call('POST', `${path}?token=${encodeURIComponent(token)}`, { raw: JSON.stringify(body), type: 'application/json' });
		// a wrong token is refused
		expect((await reply({ message: { sender: '+15550101001', body: 'BAJA' } }, 'nope')).status).toBe(401);
		expect(
			(await env.send('sms', { template: 'promo', to: { phone: '+15550101001' }, values: { pct: '1' } })).json.status,
		).toBe('sent');
		expect((await reply({ message: { sender: '+15550101001', body: ' baja ' } })).status).toBe(204);
		expect(
			(await env.send('sms', { template: 'promo', to: { phone: '+15550101001' }, values: { pct: '1' } })).json,
		).toMatchObject({
			status: 'skipped',
			reason: 'unsubscribed',
		});
		// a reply that is no keyword changes nothing; a form body is read by field names
		await env.connect('sms', { ...gateway, inboundFrom: 'from', inboundText: 'msg' });
		await env.call('POST', `${path}?token=${gateway.inboundToken}`, { raw: 'from=%2B15550101002&msg=hola' });
		expect(
			(await env.send('sms', { template: 'promo', to: { phone: '+15550101002' }, values: { pct: '1' } })).json.status,
		).toBe('sent');
		await env.call('POST', `${path}?token=${gateway.inboundToken}`, { raw: 'from=%2B15550101002&msg=Cancelar' });
		expect(
			(await env.send('sms', { template: 'promo', to: { phone: '+15550101002' }, values: { pct: '1' } })).json.status,
		).toBe('skipped');
		// a gateway without an inbound token takes no replies
		await env.connect('sms', { provider: 'http', url: 'https://gateway.example.org/send', body: '{"t":"{text}"}' });
		expect((await reply({ message: { sender: '+15550101003', body: 'STOP' } })).status).toBe(401);
		// the keywords list is checked
		expect((await saveList('stop_keywords', [{ language: 'Spanish', words: ['BAJA'] }])).status).toBe(422);
		expect((await saveList('stop_keywords', [{ language: 'es', words: [] }])).status).toBe(422);
		await env.connect('sms', TWILIO);
	});
});
