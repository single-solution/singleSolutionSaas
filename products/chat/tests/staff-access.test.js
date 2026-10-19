/**
 * Chat's staff routes and configuration routes: the server token alone replies to no chat, reads no conversation,
 * edits no knowledge and changes no setting (SEC). A reply, a note, an answer in the knowledge base is a verified staff
 * member's.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ready } from './helpers.js';

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

/** @param {{ json: any }} response */
const typeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

const ON = ['visitor_chat', 'guest_chat', 'inbox', 'ai_replies', 'knowledge_base', 'internal_notes', 'reports'];
const ENTRY = { kind: 'faq', title: 'Opening hours', text: 'Nine to five.' };

describe('Chat with the server token alone', () => {
	it('answers no chat, reads none, edits no knowledge, changes no setting: 403 needs_signed_in_staff', async () => {
		const sys = await start(ON);
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['GET', '/v1/conversations', undefined],
			['GET', '/v1/conversations/count', undefined],
			['GET', '/v1/conversations/conv_none', undefined],
			['POST', '/v1/conversations/conv_none/messages', { text: 'hi' }],
			['POST', '/v1/conversations/conv_none/notes', { text: 'hi' }],
			['DELETE', '/v1/conversations/conv_none', undefined],
			['GET', '/v1/knowledge/entries', undefined],
			['POST', '/v1/knowledge/entries', ENTRY],
			['DELETE', '/v1/knowledge/entries/kb_none', undefined],
			['GET', '/v1/reports', undefined],
			['GET', '/v1/staff', undefined],
			['POST', '/v1/data/delete-all', { scope: 'leads', confirm: 'shop.example.com' }],
			['PUT', '/v1/settings/inbox.pauseNeeds', { value: 'reply' }],
			['PUT', '/v1/texts/chat.staff', { value: 'Team' }],
			['PUT', '/v1/lists/tools', { value: [] }],
			['PUT', '/v1/connections/ai', { value: 'sk-x' }],
			['GET', '/v1/activity', undefined],
		])) {
			const refused = await sys.call(method, path, { token: sys.server, bare: true, ...(body === undefined ? {} : { body }) });
			expect([method, path, refused.status, typeOf(refused)]).toEqual([method, path, 403, 'needs_signed_in_staff']);
		}
	});
});

describe('every connection of the product (database, storage, provider keys, pasted product tokens)', () => {
	it('cannot be saved, removed or test-called with the server token alone: 403, and the list stays as it was', async () => {
		const sys = await start(ON);
		const listed = await sys.call('GET', '/v1/connections', { token: sys.server });
		const names = listed.json.connections.map((/** @type {{ name: string }} */ c) => c.name);
		expect(names).toContain('database');
		for (const name of names) {
			for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
				['PUT', `/v1/connections/${name}`, { value: 'attacker-value' }],
				['DELETE', `/v1/connections/${name}`, undefined],
				['POST', `/v1/connections/${name}/test`, undefined],
			])) {
				const refused = await sys.call(method, path, {
					token: sys.server,
					bare: true,
					...(body === undefined ? {} : { body }),
				});
				expect([name, method, refused.status, String(refused.json?.type).split('/').pop()]).toEqual([
					name,
					method,
					403,
					'needs_signed_in_staff',
				]);
			}
		}
		const after = await sys.call('GET', '/v1/connections', { token: sys.server });
		expect(after.json.connections).toEqual(listed.json.connections);
	});
});

describe('a staff sign-in', () => {
	it('with knowledge.edit edits the knowledge base, logged with that person', async () => {
		const sys = await start(ON);
		const staff = { id: 'usr_sec3', name: 'Kai Knowledge', permissions: ['chat:knowledge.edit'] };
		const made = await sys.call('POST', '/v1/knowledge/entries', { token: sys.server, staff, body: ENTRY });
		expect(made.status).toBe(201);
	});

	it('without it, or with a customer’s role, is refused 403 forbidden', async () => {
		const sys = await start(ON);
		for (const permissions of [[], ['chat:inbox.read'], ['ecommerce:knowledge.edit']]) {
			const refused = await sys.call('POST', '/v1/knowledge/entries', {
				token: sys.server,
				staff: { permissions },
				body: ENTRY,
			});
			expect([refused.status, typeOf(refused)]).toEqual([403, 'forbidden']);
		}
		// reading is not replying
		const read = await sys.call('POST', '/v1/conversations/conv_none/messages', {
			token: sys.server,
			staff: { permissions: ['chat:inbox.read'] },
			body: { text: 'hi' },
		});
		expect([read.status, typeOf(read)]).toEqual([403, 'forbidden']);
	});

	it('of another website is refused 401 invalid_sign_in', async () => {
		const sys = await start(ON);
		await sys.staffHeaders();
		const other = await sys.accounts.signIn({ websiteId: 'web_someone_else', sub: 'usr_x', permissions: ['*'] });
		const refused = await sys.call('POST', '/v1/knowledge/entries', {
			token: sys.server,
			bare: true,
			headers: { 'ss-sign-in': other },
			body: ENTRY,
		});
		expect([refused.status, typeOf(refused)]).toEqual([401, 'invalid_sign_in']);
	});

	it('the dashboard session’s settings are unchanged', async () => {
		const sys = await start(ON);
		const saved = await sys.dashboard(
			await sys.adminSession(),
			'PUT',
			`/v1/dashboard/websites/${sys.websiteId}/texts/chat.title`,
			{
				value: 'Talk to us',
			},
		);
		expect(saved.status).toBe(204);
	});
});
