import { validateManifest, validateProductBlueprint } from '@ss/contracts';
import { describe, expect, it } from 'vitest';
import guide from '../docs/guide.json' with { type: 'json' };
import nextConfig from '../next.config.js';
import openapi from '../openapi.json' with { type: 'json' };
import { manifest } from '../adapters/product.js';
import { BASE, setup } from './helpers.js';

const build = /** @type {Record<string, string>} */ (guide.build);

/** Chat's part of the website Setup sheet, checked against the contract. @param {Awaited<ReturnType<typeof setup>>} env */
const partOf = async (env) => {
	const response = await env.portal.callAsPortal('chat', 'GET', `/v1/blueprint?websiteId=${env.websiteId}`);
	const body = await response.json();
	await env.flush();
	expect(response.status).toBe(200);
	expect(validateProductBlueprint(body).ok).toBe(true);
	return body;
};

/** The summary of each list of a part, by list name. @param {any} part */
const listSummaries = (part) =>
	Object.fromEntries(
		part.features.flatMap((/** @type {any} */ feature) =>
			feature.lists.map((/** @type {any} */ list) => [list.name, list.summary]),
		),
	);

/** @param {any} part */
const whoAnswers = (part) => part.summaries.find((/** @type {any} */ summary) => summary.title === 'Who answers')?.text;

/** The documented operation a route of a build text names (`<id>` and other placeholders fill path parameters). */
const documented = Object.entries(/** @type {Record<string, Record<string, unknown>>} */ (openapi.paths)).flatMap(
	([path, methods]) =>
		Object.keys(methods).map((method) => ({
			method: method.toUpperCase(),
			pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
		})),
);

describe('the website Setup sheet', () => {
	it('tags features with business profile answers and says what the website builds for each one', () => {
		expect(validateManifest(manifest).ok).toBe(true);
		// one text per feature, in the manifest's order
		expect(Object.keys(build)).toEqual(manifest.features.map((feature) => feature.key));
		for (const text of Object.values(build)) expect(text.length).toBeLessThanOrEqual(1000);
		expect(manifest.features.find((feature) => feature.key === 'shop_my_orders')?.recommendFor).toEqual([
			'chat.ai+signIn.*+sells.physical',
			'chat.ai+signIn.*+sells.digital',
		]);
		expect(manifest.features.find((feature) => feature.key === 'reports')?.recommendFor).toBeUndefined();
		// AI cost alerts go to the Staff alerts recipients, so they cannot be on without Staff alerts
		expect(manifest.features.find((feature) => feature.key === 'ai_cost_alerts')?.dependsOn).toEqual([
			'ai_caps',
			'staff_alerts',
		]);
		// every route a build text names is one Chat serves
		const named = Object.values(build).flatMap((text) =>
			[...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/v1\/[^\s?,;)]+)/g)].map(([, method, path]) => ({
				method,
				path: String(path)
					.replace(/<[^>]+>/g, 'x')
					.replace(/\.$/, ''),
			})),
		);
		expect(named.length).toBeGreaterThan(30);
		for (const route of named)
			expect(
				documented.some((operation) => operation.method === route.method && operation.pattern.test(route.path)),
				`${route.method} ${route.path}`,
			).toBe(true);
	});

	it('answers its part: the OpenAPI document, its lists in its own words, who answers and what to build for each feature on', async () => {
		const env = await setup();
		const off = await partOf(env);
		expect(off.docs).toEqual({ guide: `${BASE}/docs`, openapi: `${BASE}/openapi.json` });
		expect(off.events).toEqual([]);
		expect(off.summaries).toEqual([{ title: 'Who answers', text: 'Nobody answers yet: switch on AI replies or the inbox.' }]);
		expect(off.build).toEqual([]);
		expect(off.features.find((/** @type {any} */ f) => f.key === 'handoff').recommendFor).toEqual(['chat.people+chat.ai']);

		const on = ['visitor_chat', 'ai_replies', 'fallback_answers', 'webhook_tools', 'leads_flows', 'custom_fields'];
		await env.switchOn([...on, 'proactive_pages']);
		const empty = await partOf(env);
		expect(listSummaries(empty)).toEqual({
			tools: 'No tools yet.',
			flows: 'No flows yet.',
			custom_fields: 'No fields yet.',
			page_rules: 'No page rules yet.',
			fallback_answers: 'No answers yet.',
		});
		expect(whoAnswers(empty)).toBe('The AI answers every visitor.');

		await env.list('tools', [
			{
				name: 'check_stock',
				description: 'Checks whether a product is in stock.',
				url: 'https://tools.example.com/stock',
				parameters: [{ name: 'sku', type: 'string', required: true }],
			},
			{ name: 'track_order', description: 'Finds an order.', url: 'https://tools.example.com/orders', parameters: [] },
		]);
		await env.list('flows', [
			{ id: 'welcome', name: 'Welcome', start: { kind: 'page', path: '/', delay: 0 }, steps: [{ kind: 'end' }] },
			{
				id: 'pricing',
				name: 'Pricing',
				start: { kind: 'page', path: '/pricing', delay: 5 },
				steps: [{ kind: 'message', text: 'Questions about our plans?' }],
			},
			{ id: 'refund', name: 'Refund', start: { kind: 'keyword', keywords: ['refund'] }, steps: [{ kind: 'handoff' }] },
		]);
		await env.list('custom_fields', [
			{ key: 'company', label: 'Company', type: 'text' },
			{ key: 'budget', label: 'Budget', type: 'number' },
		]);
		await env.list('fallback_answers', [
			{ intent: 'greeting', language: '', keywords: [], text: 'Hello! How can we help?' },
			{ intent: 'other', language: '', keywords: ['hours'], text: 'We are open from 9 AM to 5 PM.' },
		]);
		const filled = await partOf(env);
		expect(listSummaries(filled)).toEqual({
			tools: '2 tools: check_stock, track_order.',
			flows: '3 flows: 2 start on a page, 1 on a keyword.',
			custom_fields: '2 fields: Company, Budget.',
			page_rules: 'No page rules yet.',
			fallback_answers: '2 answers.',
		});
		// the kit still counts each list; tool addresses never show
		expect(filled.features.find((/** @type {any} */ f) => f.key === 'leads_flows').lists).toEqual([
			{ name: 'flows', title: 'Flows', summary: '3 flows: 2 start on a page, 1 on a keyword.', count: 3 },
		]);
		expect(JSON.stringify(filled)).not.toContain('tools.example.com');
		expect(filled.build.map((/** @type {any} */ entry) => entry.feature)).toEqual([
			'visitor_chat',
			'ai_replies',
			'fallback_answers',
			'webhook_tools',
			'proactive_pages',
			'leads_flows',
			'custom_fields',
		]);
		expect(filled.build[3]).toEqual({
			feature: 'webhook_tools',
			what: build.webhook_tools,
			docs: `${BASE}/docs#feature-webhook_tools`,
		});

		// one of each, a flow on a keyword only, and as many long names as fit in a summary
		const labels = Array.from(
			{ length: 30 },
			(_, i) => `${'Preferred contact time for the follow-up call '.repeat(2).slice(0, 78)}${String(i).padStart(2, '0')}`,
		);
		await env.list(
			'custom_fields',
			labels.map((label, i) => ({ key: `field_${i}`, label, type: 'text' })),
		);
		await env.list('tools', [{ name: 'check_stock', description: 'Checks stock.', url: 'https://tools.example.com/stock' }]);
		await env.list('flows', [
			{ id: 'refund', name: 'Refund', start: { kind: 'keyword', keywords: ['refund'] }, steps: [{ kind: 'handoff' }] },
		]);
		await env.list('page_rules', [{ path: '/products/**', delay: 10, message: 'Need help choosing?' }]);
		await env.list('fallback_answers', [{ intent: 'greeting', language: '', keywords: [], text: 'Hello!' }]);
		const one = listSummaries(await partOf(env));
		expect(one).toEqual({
			tools: '1 tool: check_stock.',
			flows: '1 flow: 1 starts on a keyword.',
			custom_fields: `30 fields: ${labels.slice(0, 3).join(', ')} and 27 more.`,
			page_rules: '1 page rule.',
			fallback_answers: '1 answer.',
		});
		expect(one.custom_fields.length).toBeLessThanOrEqual(300);

		// who answers, as the features on say
		await env.switchOn([...on, 'inbox']);
		expect(whoAnswers(await partOf(env))).toBe('The AI answers every visitor; your staff can also answer in the inbox.');
		await env.switchOn([...on, 'inbox', 'handoff']);
		expect(whoAnswers(await partOf(env))).toBe('The AI answers first and hands a conversation to your staff when needed.');
		await env.switchOn(['visitor_chat', 'inbox']);
		const staff = await partOf(env);
		expect(whoAnswers(staff)).toBe('Your staff answer in the inbox.');
		// lists of features that are off are not read
		expect(listSummaries(staff)).toEqual({});

		// the OpenAPI document itself, public
		const served = await env.call('GET', '/openapi.json');
		expect(served.json).toEqual(openapi);
	});

	it('leaves out a list it cannot read, so the kit shows its own words', async () => {
		let failing = false;
		const env = await setup({
			store: (store) => ({
				...store,
				get: async (collection, id) => {
					if (failing && id.endsWith('|chat|list.flows')) throw new Error('the product database is not answering');
					return store.get(collection, id);
				},
			}),
		});
		await env.switchOn(['visitor_chat', 'leads_flows', 'custom_fields']);
		await env.list('custom_fields', [{ key: 'company', label: 'Company', type: 'text' }]);
		failing = true;
		expect(listSummaries(await partOf(env))).toEqual({
			flows: 'Not available right now',
			custom_fields: '1 field: Company.',
		});
	});

	it('shows what the website builds in each feature of the docs', async () => {
		const env = await setup();
		const docs = await env.call('GET', '/docs');
		expect(docs.text).toContain(
			'<section id="feature-book_slot"><h3>Book-a-slot tool</h3><p>The AI offers free time slots and books one through your own booking endpoint.</p><p><strong>What your website builds.</strong> On your server, a booking endpoint (https)',
		);
		// escaped like every value
		expect(docs.text).toContain(
			'<p><strong>What your website builds.</strong> In your admin, place &#60;div data-ss-chat=&#34;inbox&#34;&#62;&#60;/div&#62;',
		);
	});

	it('reaches the docs and the OpenAPI document through the Next.js rewrites', async () => {
		const rewrites = /** @type {Array<{ source: string, destination: string }>} */ (await nextConfig.rewrites?.());
		expect(rewrites).toEqual(
			expect.arrayContaining([
				{ source: '/docs', destination: '/api/docs' },
				{ source: '/openapi.json', destination: '/api/openapi.json' },
			]),
		);
	});
});
