import { describe, expect, it } from 'vitest';
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import {
	KIT_GUIDE,
	apiAnchor,
	docsBlock,
	docsFeatureSections,
	docsList,
	docsOperations,
	docsParagraph,
	docsRouteTable,
	operationFeatures,
	renderApiReference,
	renderDocsPage,
} from '../src/index.js';

const OPENAPI = {
	paths: {
		'/v1/notes': {
			get: { 'x-ss-auth': 'browser', 'x-ss-feature': 'notes', summary: 'List <notes>' },
			post: { 'x-ss-auth': 'ticket', 'x-ss-feature': ['notes', 'inbox'], 'x-ss-permission': 'notes.write' },
		},
		'/v1/tickets': { post: { 'x-ss-auth': 'server' }, parameters: [] },
		'/v1/odd': 'not an operation list',
	},
};

const MANIFEST = {
	id: 'notes',
	features: [
		{ key: 'notes', name: 'Notes', description: 'Leave notes & more.' },
		{ key: 'inbox', name: 'Inbox', description: 'Read them.', dependsOn: ['notes', 'gone'] },
		{ key: 'quiet', name: 'Quiet', description: 'Nothing to show.', dependsOn: [] },
	],
	widgets: [
		{ key: 'form', kind: 'visitor', feature: 'notes' },
		{ key: 'inbox', kind: 'admin', feature: ['notes', 'inbox'] },
	],
};

const GUIDE = {
	title: 'Notes <docs>',
	intro: 'Hello "you".',
	localhost: 'Use localhost.',
	business: 'Your business.',
	api: 'Every call.',
};

describe('the docs pieces', () => {
	it('escape plain text and keep HTML items', () => {
		expect(docsBlock('<b> & "x"')).toBe('<pre><code>&#60;b&#62; &#38; &#34;x&#34;</code></pre>');
		expect(docsParagraph("it's")).toBe('<p>it&#39;s</p>');
		expect(docsList(['<code>a</code>', 'b'])).toBe('<ul><li><code>a</code></li><li>b</li></ul>');
		expect(docsList([])).toBe('');
	});

	it('read the operations of openapi.json and their features', () => {
		const rows = docsOperations(OPENAPI);
		expect(rows.map(([method, path]) => `${method} ${path}`)).toEqual(['GET /v1/notes', 'POST /v1/notes', 'POST /v1/tickets']);
		expect(docsOperations(null)).toEqual([]);
		expect(docsOperations({ paths: [] })).toEqual([]);
		expect(rows.map(([, , operation]) => operationFeatures(operation))).toEqual([['notes'], ['notes', 'inbox'], []]);
	});

	it('write the route table, linked to the API reference, and nothing without routes', () => {
		const table = docsRouteTable(docsOperations(OPENAPI));
		expect(table).toContain(`<a href="#${apiAnchor('GET', '/v1/notes')}"><code>GET /v1/notes</code></a> List &#60;notes&#62;`);
		expect(table).toContain('<td>ticket (notes.write)</td><td>notes or inbox</td>');
		expect(table).toContain('<td>server</td><td>always</td>');
		expect(docsRouteTable([['GET', '/x', {}]])).toContain('<td></td><td>always</td>');
		expect(docsRouteTable([])).toBe('');
	});
});

describe('the feature sections', () => {
	it('show each feature with its words, needs, build, widgets and routes', () => {
		const html = docsFeatureSections({
			manifest: MANIFEST,
			rows: docsOperations(OPENAPI),
			guide: { features: { notes: ['More about notes.'] }, build: { inbox: 'An admin page.' } },
		});
		const [notes, inbox, quiet] = html.split('\n');
		expect(notes).toBe(
			'<section id="feature-notes"><h3>Notes <code>notes</code></h3><p>Leave notes &#38; more.</p><p>More about notes.</p>' +
				'<ul><li>visitor widget <code>data-ss-notes=&#34;form&#34;</code></li><li>admin widget <code>data-ss-notes=&#34;inbox&#34;</code></li></ul>' +
				`${docsRouteTable(docsOperations(OPENAPI).slice(0, 2))}</section>`,
		);
		expect(inbox).toContain('<p>Needs: Notes, gone.</p><p><strong>What your website builds.</strong> An admin page.</p>');
		expect(inbox).toContain('POST /v1/notes');
		expect(inbox).not.toContain('GET /v1/notes');
		// no widget and no route: no empty list or table
		expect(quiet).toBe('<section id="feature-quiet"><h3>Quiet <code>quiet</code></h3><p>Nothing to show.</p></section>');
	});

	it('take no guide texts', () => {
		const html = docsFeatureSections({ manifest: { ...MANIFEST, widgets: [] }, rows: [] });
		expect(html).not.toContain('<ul>');
		expect(html).not.toContain('<table>');
	});
});

describe('the docs page', () => {
	it('wraps the product sections with the kit sections, business.json and the API reference', () => {
		const html = renderDocsPage({ guide: GUIDE, openapi: OPENAPI, body: '<h2>Own</h2>' });
		expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
		expect(html).toContain('<title>Notes &#60;docs&#62;</title>');
		expect(html).toContain(
			'<h1>Notes &#60;docs&#62;</h1>\n<p>Hello &#34;you&#34;.</p>\n<p><strong>Local testing.</strong> Use localhost.</p>\n<h2>Own</h2>',
		);
		for (const section of KIT_GUIDE) expect(html).toContain(`<h2 id="${section.id}">`);
		expect(html).toContain(
			`<h2 id="business">business.json</h2>\n<p>Your business.</p>\n${docsBlock(JSON.stringify(BUSINESS_JSON_TEMPLATE, null, 2))}`,
		);
		expect(html).toContain(
			`<h2 id="api">API reference</h2>\n<p>Every call.</p>\n${docsRouteTable(docsOperations(OPENAPI))}\n${renderApiReference(OPENAPI)}`,
		);
		expect(html.indexOf('<h2>Own</h2>')).toBeLessThan(html.indexOf(`id="${KIT_GUIDE[0]?.id}"`));
		expect(html).not.toContain('undefined');
	});

	it("adds the guide's note on the kit routes and renders the reference once per document", () => {
		const html = renderDocsPage({ guide: { ...GUIDE, kit: 'Our lists: a, b.' }, openapi: OPENAPI, body: '' });
		expect(html).toContain(`</p>\n<p>Our lists: a, b.</p>\n<h2 id="business">`);
		expect(renderDocsPage({ guide: { ...GUIDE, kit: 'Our lists: a, b.' }, openapi: OPENAPI, body: '' })).toBe(html);
		expect(renderDocsPage({ guide: GUIDE, openapi: null, body: '' })).toContain('<div class="ss-api">\n\n</div>');
	});
});
