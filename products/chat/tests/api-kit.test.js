/**
 * Chat on the kit: statuses and notices, tokens and origins, the widget settings, the dashboard's lists and tool
 * signing secret, data rights, the AI connection test, the public docs and widget script.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, AI, AI_KEY, BASE, ORIGIN, STORAGE_KEY, ready, setup } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});
/** @param {string[]} on */
const start = async (on) => {
	const sys = await ready(on);
	systems.push(sys);
	return sys;
};

describe('statuses, tokens and notices', () => {
	it('obeys every status; tokens from other origins and server tokens with an Origin are refused', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox']);
		const v = sys.visitor();
		expect((await v('GET', '/v1/chat')).status).toBe(200);
		const elsewhere = await sys.call('GET', '/v1/chat', { token: sys.browser, origin: 'https://elsewhere.example.org' });
		expect(elsewhere.status).toBe(401);
		const local = await sys.call('GET', '/v1/chat', { token: sys.browser, origin: 'http://localhost:5173' });
		expect(local.status).toBe(200);
		const withOrigin = await sys.call('GET', '/v1/conversations', { token: sys.server, origin: ORIGIN });
		expect(withOrigin.status).toBe(401);
		sys.advance(1000);
		sys.portal.setStatus(sys.websiteId, { status: 'grace', graceEndsAt: new Date(sys.now() + 86_400_000).toISOString() });
		await sys.portal.sendNotice('chat', { type: 'status.changed', websiteId: sys.websiteId });
		expect((await v('GET', '/v1/chat')).status).toBe(200);
		for (const status of /** @type {const} */ (['stopped', 'suspended', 'removed'])) {
			sys.portal.setStatus(sys.websiteId, { status });
			sys.advance(1000);
			await sys.portal.sendNotice('chat', { type: 'status.changed', websiteId: sys.websiteId });
			const refused = await v('GET', '/v1/chat');
			expect(refused.status).toBe(403);
			expect(refused.json.reason).toBe(status);
			if (status !== 'removed')
				expect(
					(
						await sys.serverCall('POST', '/v1/tickets', {
							user: { id: 'u', name: 'U', email: 'u@x.co' },
							permissions: ['inbox.read'],
							origin: ADMIN_ORIGIN,
						})
					).status,
				).toBe(403);
		}
	});

	it('a feature that is off answers feature_off; without the database, database_not_connected', async () => {
		const sys = await setup();
		systems.push(sys);
		await sys.switchOn(['visitor_chat']);
		const v = sys.visitor();
		expect((await v('GET', '/v1/chat')).json.type).toMatch(/database_not_connected$/);
		await sys.connectDatabase();
		const off = await v('POST', '/v1/chat/rating', { score: 1 });
		expect(off.status).toBe(403);
		expect(off.json.type).toMatch(/feature_off$/);
	});

	it('website.deleted removes the lists with the rest of the website’s product data', async () => {
		const sys = await start(['visitor_chat', 'proactive_pages']);
		await sys.list('page_rules', [{ path: '/', delay: 3, message: 'Hi' }]);
		await sys.portal.sendNotice('chat', { type: 'website.deleted', websiteId: sys.websiteId });
		expect(await sys.product.lists.get(sys.websiteId, 'page_rules')).toEqual([]);
	});
});

describe('widgets and docs', () => {
	it('answers the widget settings with lists and no secrets', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'signed_in_chat',
			'leads_flows',
			'proactive_pages',
			'custom_fields',
			'attachments',
		]);
		await sys.setting('visitor_chat', 'avatarUrl', 'http://not-https.example.com/a.png');
		await sys.list('page_rules', [{ path: '/products/**', delay: 10, message: 'Need help choosing?' }]);
		await sys.list('flows', [
			{ id: 'w', name: 'W', start: { kind: 'page', path: '/', delay: 0 }, steps: [{ kind: 'end' }] },
			{ id: 'k', name: 'K', start: { kind: 'keyword', keywords: ['x'] }, steps: [{ kind: 'end' }] },
		]);
		await sys.connect('storage', STORAGE_KEY);
		const config = await sys.call('GET', '/v1/widget/config', { token: sys.browser, origin: ORIGIN });
		expect(config.status).toBe(200);
		expect(config.json.texts['chat.aiUnavailable']).toBe('Sorry, I cannot answer right now.');
		expect(config.json.settings).toMatchObject({
			look: { botName: 'Assistant', avatarUrl: '', launcherPosition: 'bottom-right' },
			guests: { messageLimit: 5, rememberDays: 90, contactCapture: 'never' },
			signInUrl: '',
			proactive: {
				idleMinutes: 7,
				dismissDays: 7,
				pageRules: [{ path: '/products/**', delay: 10, message: 'Need help choosing?' }],
			},
			flows: [{ id: 'w', name: 'W', start: { kind: 'page', path: '/', delay: 0 } }],
			attachments: { visitors: 'off', maxBytes: 5 * 1024 * 1024, storage: true },
			ratings: { scale: 5, askWhen: 'on_resolve', comment: true },
			queuePosition: true,
		});
		expect(JSON.stringify(config.json)).not.toContain('secretAccessKey');
	});

	it('serves the widget script and the public docs', async () => {
		const sys = await start(['visitor_chat']);
		const script = await sys.call('GET', '/widget.js');
		expect(script.headers.get('content-type')).toContain('javascript');
		const docs = await sys.call('GET', '/docs');
		expect(docs.text).toContain('Chat docs');
		expect(docs.text).toContain('chat.needs_you');
		expect(docs.text).toContain(`${BASE}/v1/tickets`);
		expect(docs.text).toContain('search_catalog');
		// the kit's routes for the merchant's server, and Chat's lists and counts
		for (const id of ['server-settings', 'acting-user', 'server-visitors', 'counts', 'activity', 'format'])
			expect(docs.text).toContain(`<h2 id="${id}">`);
		expect(docs.text).toContain('GET /v1/conversations/counts?by=status|waiting|guest|unread');
		expect(docs.text).toContain('<code>GET /v1/admin/conversations/count</code>');
	});
});

describe('dashboard', () => {
	it('checks and saves the list settings; merchants only for switched-on features', async () => {
		const sys = await start(['visitor_chat', 'webhook_tools', 'ai_replies']);
		const owner = await sys.adminSession();
		const base = `/v1/dashboard/websites/${sys.websiteId}`;
		const bad = await sys.dashboard(owner, 'PUT', `${base}/lists/tools`, { items: [{ name: 'Bad Name', url: 'http://x' }] });
		expect(bad.status).toBe(422);
		expect(bad.json.errors.length).toBeGreaterThan(0);
		expect((await sys.dashboard(owner, 'GET', `${base}/lists/nope`)).status).toBe(404);
		// admins prepare lists of features that are off
		expect(
			(
				await sys.dashboard(owner, 'PUT', `${base}/lists/custom_fields`, {
					items: [{ key: 'size', label: 'Size', type: 'text' }],
				})
			).status,
		).toBe(200);
		const merchant = await sys.merchantSession();
		expect((await sys.dashboard(merchant, 'PUT', `${base}/lists/custom_fields`, { items: [] })).status).toBe(403);
		expect((await sys.dashboard(merchant, 'GET', `${base}/lists/custom_fields`)).json.items).toEqual([
			{ key: 'size', label: 'Size', type: 'text', options: [] },
		]);
		const saved = await sys.dashboard(merchant, 'PUT', `${base}/lists/tools`, {
			items: [{ name: 'lookup', description: 'Looks up', url: 'https://tools.example.dev/x', parameters: [] }],
		});
		expect(saved.json.items[0]).toMatchObject({ name: 'lookup', includeVisitor: false });
		const overview = await sys.dashboard(merchant, 'GET', `${base}/overview`);
		expect(overview.json.recentChanges.map((/** @type {any} */ c) => c.detail)).toContain('Webhook tools: changed');
	});

	it('reveals and regenerates the tool signing secret (sealed with ENCRYPTION_KEY)', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'webhook_tools']);
		const owner = await sys.adminSession();
		const path = `/v1/dashboard/websites/${sys.websiteId}/tool-secret`;
		const first = await sys.dashboard(owner, 'GET', path);
		expect(first.json.secret).toMatch(/^whsec_/);
		expect((await sys.dashboard(owner, 'GET', path)).json.secret).toBe(first.json.secret);
		const next = await sys.dashboard(owner, 'POST', path);
		expect(next.json.secret).not.toBe(first.json.secret);
		expect((await sys.dashboard(owner, 'GET', path)).json.secret).toBe(next.json.secret);
		const stored = JSON.stringify(await sys.product.counters.get('settings', `${sys.websiteId}|chat|tool-secret`));
		expect(stored).not.toContain(next.json.secret);
		const merchant = await sys.merchantSession();
		await sys.switchOn(['visitor_chat']);
		expect((await sys.dashboard(merchant, 'GET', path)).status).toBe(403);
	});

	it('tests the AI connection when it is saved', async () => {
		const sys = await start(['visitor_chat', 'ai_replies']);
		const owner = await sys.adminSession();
		const path = `/v1/dashboard/websites/${sys.websiteId}/connections/ai`;
		const shape = await sys.dashboard(owner, 'PUT', path, { value: { provider: 'openai', apiKey: 'short', model: 'x' } });
		expect(shape.json).toMatchObject({ status: 'test_failed', message: 'Enter the API key.' });
		sys.responders.set(`${AI}/v1/models`, () => ({ status: 401, body: {} }));
		const refused = await sys.dashboard(owner, 'PUT', path, { value: AI_KEY });
		expect(refused.json).toMatchObject({ status: 'test_failed', message: 'The provider refused the key.' });
		sys.responders.delete(`${AI}/v1/models`);
		expect((await sys.dashboard(owner, 'PUT', path, { value: AI_KEY })).json).toMatchObject({
			status: 'connected',
			last4: '6789',
		});
	});
});

describe('data rights', () => {
	it('exports and deletes one person’s conversations, messages, attachments and leads', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat', 'leads_flows', 'inbox']);
		await sys.paste('accounts');
		const guest = sys.visitor();
		await guest('POST', '/v1/chat/messages', { text: 'guest hello' });
		await guest('POST', '/v1/chat/contact', { email: 'ann@example.com' });
		const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub: 'usr_ann', email: 'ann@example.com' });
		const user = sys.visitor({ guestKey: guest.state.guestKey, signIn });
		await user('POST', '/v1/chat/messages', { text: 'now signed in' });
		const other = sys.visitor();
		await other('POST', '/v1/chat/messages', { text: 'someone else' });
		const exported = await sys.accounts.exportUser({
			handler: sys.product.handler([]),
			baseUrl: BASE,
			token: sys.server,
			user: { id: 'usr_ann' },
		});
		expect(exported.status).toBe(200);
		expect(exported.body.records.conversations).toHaveLength(1);
		expect(exported.body.records.conversations[0].messages.map((/** @type {any} */ m) => m.text)).toEqual([
			'guest hello',
			'now signed in',
		]);
		expect(exported.body.records.leads).toHaveLength(1);
		const handler = sys.product.handler([]);
		const deleted = await sys.accounts.deleteUser({
			handler,
			baseUrl: BASE,
			token: sys.server,
			user: { id: 'usr_ann', email: 'ann@example.com' },
		});
		expect(deleted.body).toEqual({ deleted: 5, anonymised: 0 });
		expect((await sys.serverCall('GET', '/v1/conversations')).json.items.map((/** @type {any} */ c) => c.preview)).toEqual([
			'someone else',
		]);
		const nobody = await sys.accounts.exportUser({
			handler,
			baseUrl: BASE,
			token: sys.server,
			user: { phone: '+15550000000' },
		});
		expect(nobody.body.records).toEqual({ conversations: [], leads: [] });
	});
});
