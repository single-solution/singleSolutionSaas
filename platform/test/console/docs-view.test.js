// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DocsHubView } from '../../src/console/views/docs.js';
import { DocsProductView } from '../../src/console/views/docs-product.js';
import * as loaders from '../../src/console/loaders.js';

vi.mock('next/navigation.js', async (importOriginal) => {
	const { testRouter } = await import('./router.js');
	return { .../** @type {object} */ (await importOriginal()), useRouter: () => testRouter };
});

describe('Docs hub views (PLAN §10 B1, B2)', () => {
	const branding = { name: 'Single Solution', accent: '#0f766e', logoUrl: null };
	const sampleProduct = {
		productId: 'chat',
		name: 'Chat',
		version: '1.0.0',
		description: 'Talk to visitors in real time with AI and human fallback.',
		status: /** @type {const} */ ('active'),
		baseUrl: 'http://localhost:3003',
		features: [
			{ key: 'ai', name: 'AI Assistant', description: 'Answers customer questions automatically.' },
			{ key: 'inbox', name: 'Operator Inbox', description: 'Staff live response desk.' },
		],
		needs: { database: true, storage: /** @type {const} */ ('optional') },
		links: { offers: [{ scope: 'chat.write', name: 'Send chat' }], needs: [] },
		widgetScriptUrl: 'http://localhost:3003/widget.js',
		widgetScriptLoading: /** @type {const} */ ('async'),
		docsUrl: '/docs/chat',
		openapiUrl: '/docs/chat/openapi.json',
		guide: {
			title: 'Chat Integration Guide',
			intro: 'Embed live chat on your site and automate support with AI.',
			install: 'Add the script to your layout.',
			features: {},
			build: {},
		},
		operations: [
			{
				method: 'GET',
				path: '/v1/conversations',
				summary: 'List active conversations',
				auth: 'server',
				permission: 'chat.read',
				feature: 'inbox',
				description: '',
			},
			{
				method: 'POST',
				path: '/v1/messages',
				summary: 'Send a message',
				auth: 'browser',
				permission: '',
				feature: 'always',
				description: '',
			},
		],
	};

	it('renders DocsHubView with hero, quickstart, and product cards without error', () => {
		const html = renderToString(<DocsHubView branding={branding} items={[sampleProduct]} />);
		expect(html).toContain('Documentation Hub');
		expect(html).toContain('Quickstart for Developers and AI');
		expect(html).toContain('Chat');
		expect(html).toContain('v1.0.0');
		expect(html).toContain('AI Assistant');
		expect(html).toContain('/docs/chat');
		expect(html).toContain('/docs/chat/openapi.json');
		expect(html).toContain('/docs/openapi.json');
	});

	it('renders DocsProductView with guide, features, widget snippet, and operations table without error', () => {
		const html = renderToString(<DocsProductView branding={branding} product={sampleProduct} />);
		expect(html).toContain('Chat');
		expect(html).toContain('v1.0.0');
		expect(html).toContain('Embed live chat on your site');
		expect(html).toContain('Widget Integration');
		expect(html).toContain('http://localhost:3003/widget.js');
		expect(html).toContain('YOUR_WEBSITE_BROWSER_TOKEN');
		expect(html).toContain('AI Assistant');
		expect(html).toContain('Operator Inbox');
		expect(html).toContain('/v1/conversations');
		expect(html).toContain('List active conversations');
		expect(html).toContain('/v1/messages');
		expect(html).toContain('/docs/chat/openapi.json');
	});

	it('loads docs hub and product detail via loaders', async () => {
		const mockApi = {
			get: vi.fn(async (path) => {
				if (path === '/v1/docs') {
					return { ok: true, status: 200, data: { items: [sampleProduct] } };
				}
				if (path === '/v1/docs/chat') {
					return { ok: true, status: 200, data: { product: sampleProduct } };
				}
				return { ok: false, status: 404, problem: { code: 'not_found' } };
			}),
		};

		const hubLoaded = await loaders.loadDocsHub(/** @type {any} */ (mockApi));
		expect(hubLoaded.ok).toBe(true);
		if (hubLoaded.ok) {
			expect(hubLoaded.items).toHaveLength(1);
			expect(hubLoaded.items[0].productId).toBe('chat');
		}

		const productLoaded = await loaders.loadDocsProduct(/** @type {any} */ (mockApi), 'chat');
		expect(productLoaded.ok).toBe(true);
		expect(productLoaded.product?.productId).toBe('chat');

		const missingLoaded = await loaders.loadDocsProduct(/** @type {any} */ (mockApi), 'unknown');
		expect(missingLoaded.ok).toBe(false);
		expect(missingLoaded.status).toBe(404);
	});
});
