// @vitest-environment jsdom
/**
 * The fallback answers editor in the browser (jsdom) on a faked dashboard API (PLAN 0.8.10 C3): Settings → Assistant
 * shows it with Language lock's languages; it adds, edits and saves answers with one PUT from the Save bar, refuses what
 * the server's check would (each field says why, nothing is sent; a comparison answer needs its keywords, C18) and names
 * the shop tools an answer's placeholders need while they are off. The shared list editor is a table: a click on a row
 * opens the entry in a drawer that edits the draft only, the row menu moves and removes, Add stops at the limit.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, keydown, render, type } from '@ss/ui/testing';
import { FallbackAnswersEditor, PageRulesEditor, RedactionPatternsEditor, TeamsEditor } from '../app/dashboard/lists.js';
import { TABS } from '../app/dashboard/tabs.js';
import { checkFallbackAnswers } from '../core/fallback.js';
import { closeDrawer, drawerOf, inDashboard, openRow, rowMenu, rowNames } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;
const LIST = `${BASE}/lists/fallback_answers`;
const DEALS = { language: '', keywords: ['deal', 'offer'], text: 'Our deals:\n\n{deals_table}' };

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

/** The Save bar's Save list button, or null while there is nothing to save. */
const saveButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save list') ?? null;

/** Add an entry: it opens in the drawer. @param {HTMLElement} root */
const add = async (root) => {
	await act(async () => click(button(root, 'Add')));
	return drawerOf();
};

/** Close the drawer if it is open, save with the Save bar and let it answer. */
const save = async () => {
	if (drawerOf()) await closeDrawer();
	await act(async () => click(/** @type {HTMLElement} */ (saveButton())));
	await settle();
};

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
		// the saved answer is a row: its language, keywords and text
		expect(rowNames(container)).toEqual(['Answer 1']);
		const cells = container.querySelector('tbody')?.textContent ?? '';
		expect(cells).toContain('Any language');
		expect(cells).toContain('deal, offer');
		const first = await openRow(container, 'Answer 1');
		expect(field(first, 'Keywords (one per line)').value).toBe('deal\noffer');
		expect(field(first, 'Answer').value).toBe(DEALS.text);
		expect(optionsOf(field(first, 'Language'))).toEqual(['Any language', 'English (en)', 'French (fr)']);
		expect(first.textContent).not.toContain('Skipped while these are off');
		await closeDrawer();
		// nothing changed: the floating Save bar is not on screen
		expect(saveButton()).toBeNull();

		// a new answer opens in the drawer: nothing written yet, so the list is not saved
		const drawer = await add(container);
		expect(drawer.querySelector('h2')?.textContent).toBe('Answer 2');
		expect(drawer.textContent).toContain('Write the answer (up to 2000 characters).');
		expect(/** @type {HTMLButtonElement} */ (saveButton()).disabled).toBe(true);
		type(field(drawer, 'Answer', 0), '  Popular this week:\n{top_products}  ');
		expect(drawer.textContent).not.toContain('Write the answer');
		// its placeholder needs a shop tool that is off: the answer would be skipped
		expect(drawer.textContent).toContain('Skipped while these are off: Shop tools: top and new products.');
		type(field(drawer, 'Language', 0), 'fr');
		// 31 keywords are more than the server takes
		type(field(drawer, 'Keywords (one per line)', 0), Array.from({ length: 31 }, (_, i) => `word ${i}`).join('\n'));
		expect(drawer.textContent).toContain('Up to 30 keywords of up to 100 characters each.');
		expect(/** @type {HTMLButtonElement} */ (saveButton()).disabled).toBe(true);
		type(field(drawer, 'Keywords (one per line)', 0), ' best \n\nbestseller');
		expect(drawer.textContent).not.toContain('Up to 30 keywords');
		// Done closes the drawer; nothing is sent until the Save bar
		await closeDrawer();
		expect(drawerOf()).toBeNull();
		expect(saved).toEqual([]);

		await save();
		expect(saved).toEqual([
			[DEALS, { language: 'fr', keywords: ['best', 'bestseller'], text: 'Popular this week:\n{top_products}' }],
		]);
		expect(container.textContent).toContain('Saved');
		// saved: the floating Save bar goes away
		expect(saveButton()).toBeNull();
	});

	it('a comparison answer needs the words between the two products (C18)', async () => {
		serve();
		const { container } = render(inDashboard(<FallbackAnswersEditor websiteId={WEBSITE} languages={[]} on={() => true} />));
		await settle();
		const drawer = await add(container);
		type(field(drawer, 'Answer', 0), 'Side by side:\n{comparison}');
		expect(drawer.textContent).toContain('Add the words between the two products, such as vs, for {comparison}.');
		expect(/** @type {HTMLButtonElement} */ (saveButton()).disabled).toBe(true);
		type(field(drawer, 'Keywords (one per line)', 0), 'vs\nversus');
		expect(drawer.textContent).not.toContain('Add the words between');
		await save();
		expect(saved).toEqual([[DEALS, { language: '', keywords: ['vs', 'versus'], text: 'Side by side:\n{comparison}' }]]);
	});

	it('keeps a saved language Language lock no longer lists; moves and removes answers', async () => {
		serve();
		const { container } = render(inDashboard(<FallbackAnswersEditor websiteId={WEBSITE} languages={[]} on={() => true} />));
		await settle();
		const added = await add(container);
		type(field(added, 'Answer', 0), 'Hello!');
		await closeDrawer();
		// move the new one up with its row menu, then look at the first
		await rowMenu(container, 'Answer 2', 'Move up');
		const first = await openRow(container, 'Answer 1');
		expect(field(first, 'Answer', 0).value).toBe('Hello!');
		// no fixed "For" list (C20): an answer is its language, keywords and text
		expect(first.textContent).not.toContain('Anything else');
		await save();
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
		expect(again.container.querySelector('tbody')?.textContent).toContain('ur-Latn');
		const saved1 = await openRow(again.container, 'Answer 1');
		expect(field(saved1, 'Language').value).toBe('ur-Latn');
		expect(optionsOf(field(saved1, 'Language'))).toContain('English (en)');
		await closeDrawer();
		await rowMenu(again.container, 'Answer 1', 'Remove');
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
		const drawer = await openRow(container, 'Answer 1');
		expect(optionsOf(field(drawer, 'Language'))).toEqual(['Any language', 'English (en)', 'Arabic (ar)']);
		// the deals table needs the deals shop tool, which is off here
		expect(drawer.textContent).toContain('Skipped while these are off: Shop tools: deals and savings quotes.');
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
		const drawer = await add(container);
		type(field(drawer, 'Name'), 'member number');
		type(field(drawer, 'Pattern (for example \\d{5}-\\d{7}-\\d)'), '(?=M)M\\d+');
		expect(drawer.textContent).toContain('Look-arounds and named groups are not taken');
		expect(/** @type {HTMLButtonElement} */ (saveButton()).disabled).toBe(true);
		type(field(drawer, 'Pattern (for example \\d{5}-\\d{7}-\\d)'), 'M-\\d{6}');
		expect(drawer.textContent).not.toContain('not taken');
		await save();
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
		const drawer = await add(container);
		type(field(drawer, 'Name'), 'Wholesale');
		expect(drawer.textContent).toContain('list 1 to 100 members by email address or user id.');
		expect(/** @type {HTMLButtonElement} */ (saveButton()).disabled).toBe(true);
		type(field(drawer, 'Members (one per line: email address or user id)'), 'ana@shop.example.com\nusr_lee');
		type(field(drawer, 'Pages (one per line: paths such as /wholesale/**)'), '/wholesale/**');
		await save();
		// the saved team is a row with its member count
		expect(rowNames(container)).toEqual(['Wholesale']);
		expect(container.querySelector('tbody')?.textContent).toContain('2');
		expect(puts).toEqual([
			[{ name: 'Wholesale', members: ['ana@shop.example.com', 'usr_lee'], languages: [], pages: ['/wholesale/**'] }],
		]);
	});
});

describe('the shared list editor table', () => {
	const PATH = `${BASE}/lists/page_rules`;
	const RULES = [
		{ path: '/pricing', delay: 10, message: 'Questions about pricing?' },
		{ path: '/blog/**', delay: 30, message: 'Want updates?' },
	];

	/**
	 * The page rules list: `late` keeps the load waiting until `release`; saves are kept.
	 * @param {any[]} rules
	 * @param {boolean} [late]
	 */
	const serveRules = (rules, late = false) => {
		saved = [];
		/** @type {Array<() => void>} */
		const waiting = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
				if (path !== PATH) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
				if (init.method === 'PUT') {
					rules = JSON.parse(String(init.body)).value;
					saved.push(rules);
				} else if (late) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
				return new Response(JSON.stringify({ value: rules }), { status: 200 });
			}),
		);
		return { release: () => waiting.splice(0).forEach((go) => go()) };
	};

	it('shows a skeleton table while the list loads, then a row per entry with its columns', async () => {
		const api = serveRules(RULES, true);
		const { container } = render(inDashboard(<PageRulesEditor websiteId={WEBSITE} />));
		await settle();
		expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
		// the title and Add are there while it loads; Add waits for the list
		expect(container.querySelector('h2')?.textContent).toBe('Page rules');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Add')).disabled).toBe(true);
		api.release();
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		// a row is the page path with its delay and message
		expect(rowNames(container)).toEqual(['/pricing', '/blog/**']);
		expect(container.querySelector('tbody')?.textContent).toContain('Questions about pricing?');
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Add')).disabled).toBe(false);
	});

	it('edits an entry in the drawer without saving, and saves it with the Save bar only', async () => {
		serveRules(RULES);
		const { container } = render(inDashboard(<PageRulesEditor websiteId={WEBSITE} />));
		await settle();
		// no Save bar until something changed, and no Save or Cancel button inside the card
		expect(saveButton()).toBeNull();
		expect(container.querySelector('[data-entry]')).toBeNull();
		const drawer = await openRow(container, '/pricing');
		expect(drawer.querySelector('h2')?.textContent).toBe('/pricing');
		type(field(drawer, 'Message'), 'Need a hand with pricing?');
		// Done closes the drawer; the draft is not saved
		await closeDrawer();
		expect(drawerOf()).toBeNull();
		expect(saved).toEqual([]);
		expect(container.querySelector('tbody')?.textContent).toContain('Need a hand with pricing?');
		await save();
		expect(saved).toEqual([[{ ...RULES[0], message: 'Need a hand with pricing?' }, RULES[1]]]);
		expect(container.textContent).toContain('Saved');
		expect(saveButton()).toBeNull();
		// Cancel in the Save bar drops the draft
		await rowMenu(container, '/blog/**', 'Remove');
		expect(rowNames(container)).toEqual(['/pricing']);
		await act(async () =>
			click(
				/** @type {HTMLElement} */ ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')),
			),
		);
		expect(rowNames(container)).toEqual(['/pricing', '/blog/**']);
		expect(saveButton()).toBeNull();
	});

	it('moves and removes an entry from its row menu; an end of the list cannot move further', async () => {
		serveRules(RULES);
		const { container } = render(inDashboard(<PageRulesEditor websiteId={WEBSITE} />));
		await settle();
		await rowMenu(container, '/blog/**', 'Move up');
		expect(rowNames(container)).toEqual(['/blog/**', '/pricing']);
		await act(async () => click(/** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup]'))));
		const up = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Move up');
		expect(up?.hasAttribute('disabled') || up?.getAttribute('aria-disabled') === 'true').toBe(true);
		await keydown(document, 'Escape');
		await rowMenu(container, '/pricing', 'Remove');
		await save();
		expect(saved).toEqual([[RULES[1]]]);
	});

	it('stops Add at the limit, says so when the list is empty, and leaves the title out on a page of its own', async () => {
		serveRules(Array.from({ length: 20 }, (_, index) => ({ path: `/p${index}`, delay: 1, message: 'Hi' })));
		const { container } = render(inDashboard(<PageRulesEditor websiteId={WEBSITE} />));
		await settle();
		expect(rowNames(container)).toHaveLength(20);
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Add')).disabled).toBe(true);
		cleanup();
		serveRules([]);
		const empty = render(inDashboard(<PageRulesEditor websiteId={WEBSITE} bare />));
		await settle();
		expect(empty.container.textContent).toContain('Nothing yet.');
		expect(empty.container.querySelector('h2')).toBeNull();
		expect(/** @type {HTMLButtonElement} */ (button(empty.container, 'Add')).disabled).toBe(false);
	});
});
