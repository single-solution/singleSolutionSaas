// @vitest-environment jsdom
/**
 * The fallback answers editor in the browser (jsdom) on a faked dashboard API (PLAN 0.8.10 C3): Settings → Assistant
 * shows it with Language lock's languages; it adds, edits and saves answers with one PUT, refuses what the server's
 * check would (each field says why, nothing is sent; a comparison answer needs its keywords, C18) and names the shop
 * tools an answer's placeholders need while they are off.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render, type } from '@ss/ui/testing';
import { DashboardProvider } from '@ss/ui/dashboard';
import manifest from '../manifest.json' with { type: 'json' };
import { FallbackAnswersEditor, RedactionPatternsEditor, TeamsEditor } from '../app/dashboard/lists.js';
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';
import { checkFallbackAnswers } from '../core/fallback.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;
const LIST = `${BASE}/lists/fallback_answers`;
const DEALS = { language: '', keywords: ['deal', 'offer'], text: 'Our deals:\n\n{deals_table}' };

/**
 * A dashboard piece inside the dashboard's provider (its words and feature names), as the page renders it.
 * @param {import('react').ReactNode} node
 */
const inDashboard = (node) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		{node}
	</DashboardProvider>
);

/** The lists the editor saved. @type {any[]} */
let saved = [];

/**
 * The dashboard API: the saved answers and a save checked as the server checks it; `more` answers other paths.
 * @param {Record<string, unknown>} [more]
 */
const serve = (more = {}) => {
	saved = [];
	/** @type {any[]} */
	let items = [DEALS];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			if (path === LIST) {
				if (init.method === 'PUT') {
					const body = JSON.parse(String(init.body));
					saved.push(body.value);
					const checked = checkFallbackAnswers(body.value);
					const errors = checked.ok ? [] : checked.errors.map((message) => ({ path: '/value', message }));
					if (!checked.ok) return new Response(JSON.stringify({ status: 422, errors }), { status: 422 });
					items = checked.value;
				}
				return new Response(JSON.stringify({ value: items }), { status: 200 });
			}
			if (Object.hasOwn(more, path)) return new Response(JSON.stringify(more[path]), { status: 200 });
			return new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 });
		}),
	);
};

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

/**
 * The control of the `index`-th label `label` (answers repeat their labels).
 * @param {ParentNode} root
 * @param {string} label
 * @param {number} [index]
 * @returns {HTMLInputElement}
 */
const field = (root, label, index = 0) => {
	const found = [...root.querySelectorAll('label')].filter((l) => l.textContent?.trim() === label)[index];
	if (!found) throw new Error(`no label “${label}” #${index}`);
	return /** @type {HTMLInputElement} */ (document.getElementById(/** @type {HTMLLabelElement} */ (found).htmlFor));
};

/** @param {ParentNode} root @param {string} text */
const button = (root, text) => byText(root, text, 'button');

/** The options of a select, as shown. @param {HTMLInputElement} select */
const optionsOf = (select) => [.../** @type {HTMLSelectElement} */ (/** @type {unknown} */ (select)).options].map((o) => o.text);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the fallback answers editor (C3)', () => {
	it('adds an answer, refuses what the server would, and saves the list with one PUT', async () => {
		serve();
		const { container } = render(
			inDashboard(<FallbackAnswersEditor websiteId={WEBSITE} languages={['en', 'fr']} on={(key) => key === 'shop_deals'} />),
		);
		await settle();
		// the saved answer
		expect(field(container, 'Keywords (one per line)').value).toBe('deal\noffer');
		expect(field(container, 'Answer').value).toBe(DEALS.text);
		expect(optionsOf(field(container, 'Language'))).toEqual(['Any language', 'English (en)', 'French (fr)']);
		expect(container.textContent).not.toContain('Skipped while these are off');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save list')).disabled).toBe(true);

		// a new answer: nothing written yet, so the list is not saved
		click(button(container, 'Add'));
		expect(container.textContent).toContain('Answer 2');
		expect(container.textContent).toContain('Write the answer (up to 2000 characters).');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save list')).disabled).toBe(true);
		type(field(container, 'Answer', 1), '  Popular this week:\n{top_products}  ');
		expect(container.textContent).not.toContain('Write the answer');
		// its placeholder needs a shop tool that is off: the answer would be skipped
		expect(container.textContent).toContain('Skipped while these are off: Shop tools: top and new products.');
		type(field(container, 'Language', 1), 'fr');
		// 31 keywords are more than the server takes
		type(field(container, 'Keywords (one per line)', 1), Array.from({ length: 31 }, (_, i) => `word ${i}`).join('\n'));
		expect(container.textContent).toContain('Up to 30 keywords of up to 100 characters each.');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save list')).disabled).toBe(true);
		type(field(container, 'Keywords (one per line)', 1), ' best \n\nbestseller');
		expect(container.textContent).not.toContain('Up to 30 keywords');
		expect(saved).toEqual([]);

		click(button(container, 'Save list'));
		await settle();
		expect(saved).toEqual([
			[DEALS, { language: 'fr', keywords: ['best', 'bestseller'], text: 'Popular this week:\n{top_products}' }],
		]);
		expect(container.textContent).toContain('Saved');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save list')).disabled).toBe(true);
	});

	it('a comparison answer needs the words between the two products (C18)', async () => {
		serve();
		const { container } = render(inDashboard(<FallbackAnswersEditor websiteId={WEBSITE} languages={[]} on={() => true} />));
		await settle();
		click(button(container, 'Add'));
		type(field(container, 'Answer', 1), 'Side by side:\n{comparison}');
		expect(container.textContent).toContain('Add the words between the two products, such as vs, for {comparison}.');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save list')).disabled).toBe(true);
		type(field(container, 'Keywords (one per line)', 1), 'vs\nversus');
		expect(container.textContent).not.toContain('Add the words between');
		click(button(container, 'Save list'));
		await settle();
		expect(saved).toEqual([[DEALS, { language: '', keywords: ['vs', 'versus'], text: 'Side by side:\n{comparison}' }]]);
	});

	it('keeps a saved language Language lock no longer lists; moves and removes answers', async () => {
		serve();
		const { container } = render(inDashboard(<FallbackAnswersEditor websiteId={WEBSITE} languages={[]} on={() => true} />));
		await settle();
		click(button(container, 'Add'));
		type(field(container, 'Answer', 1), 'Hello!');
		click(container.querySelectorAll('button[aria-label="Move up"]')[1] ?? container);
		expect(field(container, 'Answer', 0).value).toBe('Hello!');
		// no fixed "For" list (C20): an answer is its language, keywords and text
		expect(container.textContent).not.toContain('Anything else');
		click(button(container, 'Save list'));
		await settle();
		expect(saved.at(-1).map((/** @type {any} */ a) => a.text)).toEqual(['Hello!', DEALS.text]);
		// an answer saved in a language the lock no longer lists still shows it
		saved = [];
		vi.unstubAllGlobals();
		cleanup();
		serve();
		vi.mocked(fetch).mockImplementationOnce(
			async () => new Response(JSON.stringify({ value: [{ ...DEALS, language: 'ur-Latn' }] }), { status: 200 }),
		);
		const again = render(inDashboard(<FallbackAnswersEditor websiteId="web_2" languages={['en']} on={() => true} />));
		await settle();
		expect(field(again.container, 'Language').value).toBe('ur-Latn');
		expect(optionsOf(field(again.container, 'Language'))).toContain('English (en)');
		click(button(again.container, 'Remove'));
		expect(again.container.textContent).toContain('Nothing yet.');
	});
});

describe('Settings → Assistant', () => {
	it('shows the fallback answers with Language lock’s languages', async () => {
		/** @param {string} key @param {Record<string, unknown>} [values] */
		const feature = (key, values = {}) => ({
			key,
			name: key,
			on: true,
			schema: { type: 'object', properties: {} },
			values: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, source: 'website' }])),
		});
		serve({
			[`${BASE}/settings`]: {
				features: [
					feature('ai_replies'),
					feature('fallback_answers'),
					feature('language_lock', { allowedLanguages: ['en', 'ar'] }),
				],
			},
		});
		const Settings = TABS.settings;
		const { container } = render(
			inDashboard(
				<Settings
					websiteId={WEBSITE}
					domain="shop.example.com"
					who={{ kind: 'merchant', id: 'm_1', name: 'Merchant' }}
					support={{ channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] }}
					portal="https://portal.example.com"
					open={() => undefined}
				/>,
			),
		);
		await settle();
		expect(container.textContent).toContain('Fallback answers');
		expect(optionsOf(field(container, 'Language'))).toEqual(['Any language', 'English (en)', 'Arabic (ar)']);
		// the deals table needs the deals shop tool, which is off here
		expect(container.textContent).toContain('Skipped while these are off: Shop tools: deals and savings quotes.');
	});
});

describe('the redaction patterns editor (C14)', () => {
	it('refuses a pattern the safe subset does not take, as the server would, and saves the list', async () => {
		const path = `${BASE}/lists/redaction_patterns`;
		/** @type {any[]} */
		const puts = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
				if (url !== path) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
				if (init.method === 'PUT') puts.push(JSON.parse(String(init.body)).value);
				return new Response(JSON.stringify({ value: puts.at(-1) ?? [] }), { status: 200 });
			}),
		);
		const { container } = render(inDashboard(<RedactionPatternsEditor websiteId={WEBSITE} />));
		await settle();
		click(button(container, 'Add'));
		type(field(container, 'Name'), 'member number');
		type(field(container, 'Pattern (for example \\d{5}-\\d{7}-\\d)'), '(?=M)M\\d+');
		expect(container.textContent).toContain('Look-arounds and named groups are not taken');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save list')).disabled).toBe(true);
		type(field(container, 'Pattern (for example \\d{5}-\\d{7}-\\d)'), 'M-\\d{6}');
		expect(container.textContent).not.toContain('not taken');
		click(button(container, 'Save list'));
		await settle();
		expect(puts).toEqual([[{ name: 'member number', pattern: 'M-\\d{6}', replacement: '' }]]);
	});
});

describe('the teams editor (C12)', () => {
	it('refuses a team without members, as the server would, and saves the list', async () => {
		const path = `${BASE}/lists/teams`;
		/** @type {any[]} */
		const puts = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
				if (url !== path) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
				if (init.method === 'PUT') puts.push(JSON.parse(String(init.body)).value);
				return new Response(JSON.stringify({ value: puts.at(-1) ?? [] }), { status: 200 });
			}),
		);
		const { container } = render(inDashboard(<TeamsEditor websiteId={WEBSITE} />));
		await settle();
		click(button(container, 'Add'));
		type(field(container, 'Name'), 'Wholesale');
		expect(container.textContent).toContain('list 1 to 100 members by email address or user id.');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save list')).disabled).toBe(true);
		type(field(container, 'Members (one per line: email address or user id)'), 'ana@shop.example.com\nusr_lee');
		type(field(container, 'Pages (one per line: paths such as /wholesale/**)'), '/wholesale/**');
		click(button(container, 'Save list'));
		await settle();
		expect(puts).toEqual([
			[{ name: 'Wholesale', members: ['ana@shop.example.com', 'usr_lee'], languages: [], pages: ['/wholesale/**'] }],
		]);
	});
});
