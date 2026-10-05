/** Mode B cores (overlay, suggestions) on a scripted client and Mode A renderer (combobox ARIA, keyboard, variants). */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createOverlay, priceText } from '../headless/overlay.js';
import { safeStorage, createStore } from '../headless/store.js';
import { HISTORY_KEY, createSuggestions } from '../headless/suggestions.js';
import { browserStorage, memo, refocus, trapTab } from '../ui/dom.js';
import { render, styles } from '../ui/overlay.js';
import { createClient, createFakeDom, createScheduler, createStorage, findAll } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const hit = (/** @type {string} */ id, extra = {}) => ({
	id,
	type: 'item',
	title: `T ${id}`,
	description: 'd',
	url: `/${id}`,
	image: null,
	price: 1250,
	currency: 'EUR',
	fields: {},
	...extra,
});
const routes = {
	'GET /v1/search': (/** @type {any} */ q) =>
		q.q === 'boom'
			? { error: { code: 'unavailable' } }
			: { items: [hit('a'), hit('b', { url: null, price: null, image: 'https://cdn.example.com/b.png' })], total: 2 },
	'GET /v1/suggestions': (/** @type {any} */ q) => ({
		popular: [{ text: 'linen' }, { bad: 1 }],
		completions: q.q ? [{ text: `${q.q}en` }] : [],
		recent: [{ id: 'r1', type: 'page', title: 'New page', url: '/r1' }, { nope: true }],
	}),
	'POST /v1/search-clicks': () => ({ counted: true }),
};

describe('suggestions core', () => {
	it('loads suggestions and keeps recent searches only in the injected storage', async () => {
		const storage = createStorage();
		storage.set(HISTORY_KEY, JSON.stringify(['old', 5]));
		const s = createSuggestions({ config: { history_size: 2 }, strings, client: createClient(routes), storage });
		expect(s.state().history).toEqual(['old']);
		const loaded = await s.actions.load('li', { types: ['item'] });
		expect(loaded.ok).toBe(true);
		expect(s.state()).toMatchObject({
			status: 'ready',
			popular: [{ text: 'linen' }],
			completions: [{ text: 'lien' }],
			recent: [{ id: 'r1', url: '/r1' }],
		});
		await s.actions.remember('  shoes ');
		await s.actions.remember('hats');
		await s.actions.remember('shoes');
		expect(s.state().history).toEqual(['shoes', 'hats']);
		expect(JSON.parse(storage.values.get(HISTORY_KEY) ?? '')).toEqual(['shoes', 'hats']);
		await s.actions.remember('');
		await s.actions.forget();
		expect(s.state().history).toEqual([]);
		await s.actions.attachStorage(null);
		expect(s.validate('x'.repeat(101))[0]?.code).toBe('too_long');
		expect(s.validate('ok')).toEqual([]);
		const failing = createSuggestions({ client: createClient({}), storage: { get: () => '{bad', set: () => {} } });
		expect(failing.state().history).toEqual([]);
		expect((await failing.actions.load()).ok).toBe(false);
		expect(failing.state().status).toBe('error');
		const off = createSuggestions({ config: { history_size: 0 }, client: createClient(routes) });
		expect((await off.actions.remember('x')).ok).toBe(true);
		expect(off.state().history).toEqual([]);
		off.destroy();
		expect((await off.actions.load()).ok).toBe(false);
	});

	it('survives broken storage and superseded loads', async () => {
		const broken = safeStorage({
			get: () => {
				throw new Error('blocked');
			},
			set: () => {
				throw new Error('full');
			},
		});
		expect(broken.get('x')).toBeNull();
		expect(() => broken.set('x', 'y')).not.toThrow();
		const s = createSuggestions({ client: createClient(routes) });
		const [first, second] = await Promise.all([s.actions.load('a'), s.actions.load('b')]);
		expect(first.ok ? null : first.error.code).toBe('superseded');
		expect(second.ok).toBe(true);
		const store = createStore({ n: 1 });
		const seen = vi.fn();
		const off = store.subscribe(seen);
		store.set({ n: 2 });
		off();
		store.set({ n: 3 });
		expect(seen).toHaveBeenCalledTimes(1);
	});
});

describe('overlay core', () => {
	it('debounces typing, shows results, moves the active option and submits', async () => {
		const client = createClient(routes);
		const timers = createScheduler();
		const emit = vi.fn();
		const overlay = createOverlay({
			config: { debounce_ms: 300, min_chars: 2, types: ['item'], results_path: '/find', query_param: 'k' },
			strings,
			client,
			emit,
			schedule: timers.schedule,
			locale: 'en',
		});
		await overlay.actions.start();
		expect(overlay.state().options.map((o) => o.kind)).toEqual(['popular', 'recent']);
		await overlay.actions.open();
		const pendingA = overlay.actions.setQuery('li');
		const pendingB = overlay.actions.setQuery('lin');
		expect(timers.timers.filter((t) => !t.cancelled)).toHaveLength(1);
		expect(timers.timers[0]?.ms).toBe(300);
		timers.run();
		expect((await pendingA).ok).toBe(false);
		expect((await pendingB).ok).toBe(true);
		expect(client.calls.filter((/** @type {any} */ c) => c.path === '/v1/search')).toEqual([
			{ method: 'GET', path: '/v1/search', query: { q: 'lin', limit: 8, types: 'item' } },
		]);
		const state = overlay.state();
		expect(state).toMatchObject({ status: 'ready', total: 2, href: '/find?k=lin', message: '2 results' });
		expect(state.options[0]).toMatchObject({ kind: 'result', label: 'T a', detail: '€12.50', href: '/a' });
		expect(state.options[1]).toMatchObject({ detail: 'd', image: 'https://cdn.example.com/b.png' });
		expect((await overlay.actions.move(1)).ok && overlay.state().active).toBe(0);
		await overlay.actions.move(-1);
		await overlay.actions.move(-1);
		expect(overlay.state().active).toBe(1);
		await overlay.actions.jump('first');
		const chosen = await overlay.actions.submit();
		expect(chosen).toEqual({ ok: true, value: { href: '/a', query: null } });
		expect(client.calls.at(-1)).toEqual({ method: 'POST', path: '/v1/search-clicks', body: { q: 'lin', id: 'a' } });
		await overlay.actions.clearActive();
		expect(await overlay.actions.submit()).toEqual({ ok: true, value: { href: '/find?k=lin', query: null } });
		await overlay.actions.jump('last');
		expect(overlay.state().active).toBe(1);
		expect(emit).toHaveBeenCalledWith('searched', { results: 2 });
		await overlay.actions.close();
		expect(overlay.state().open).toBe(false);
	});

	it('shows suggestions for short queries, runs a chosen suggestion and reports errors', async () => {
		const timers = createScheduler();
		const storage = createStorage();
		const overlay = createOverlay({
			config: { min_chars: 3, show_images: false, hotkey: 'mod+k' },
			strings,
			client: createClient(routes),
			storage,
			schedule: timers.schedule,
		});
		await overlay.actions.attachStorage(storage);
		await overlay.actions.setQuery('li');
		await tick();
		const kinds = overlay.state().options.map((o) => o.kind);
		expect(kinds).toEqual(['completion', 'popular']);
		expect(overlay.state()).toMatchObject({ status: 'idle', hotkey: 'mod+k', showImages: false });
		const picked = await overlay.actions.choose(0);
		expect(picked).toEqual({ ok: true, value: { href: null, query: 'lien' } });
		expect(overlay.state().status).toBe('ready');
		expect((await overlay.actions.choose(9)).ok).toBe(false);
		await overlay.actions.setQuery('');
		expect(await overlay.actions.submit()).toEqual({ ok: false, error: { code: 'empty_query' } });
		const failing = overlay.actions.setQuery('boom');
		timers.run();
		expect((await failing).ok).toBe(false);
		expect(overlay.state()).toMatchObject({ status: 'error', message: strings['overlay.error'] });
		const typed = overlay.actions.setQuery('lin');
		timers.run();
		await typed;
		await overlay.actions.choose(0);
		expect(storage.values.get(HISTORY_KEY)).toContain('lin');
		await overlay.actions.forgetHistory();
		expect(storage.values.get(HISTORY_KEY)).toBe('[]');
		expect(overlay.validate('x'.repeat(200))).toHaveLength(1);
		expect(overlay.validate('x')).toEqual([]);
		overlay.destroy();
		const empty = createOverlay({
			config: { show_suggestions: false, debounce_ms: 'x', hotkey: 'zz' },
			strings,
			client: createClient({ 'GET /v1/search': () => ({ items: 'x' }) }),
		});
		await empty.actions.start();
		await empty.actions.open();
		expect((await empty.actions.move(1)).value).toBe(-1);
		expect((await empty.actions.jump('last')).value).toBe(-1);
		const done = empty.actions.setQuery('abc');
		expect((await done).ok).toBe(true);
		expect(empty.state()).toMatchObject({ hotkey: '/', message: strings['overlay.empty'] });
		expect(await empty.actions.searchNow()).toMatchObject({ ok: true });
		expect(priceText(100, 'JPY', 'en')).toBe('¥100');
		expect(priceText(100, 'EUR', 'xx-invalid-locale-')).toBeNull();
		expect(priceText(1.5, 'EUR', 'en')).toBeNull();
	});
});

describe('overlay renderer', () => {
	const setup = async (/** @type {Record<string, any>} */ theme = {}) => {
		const timers = createScheduler();
		const overlay = createOverlay({
			config: { min_chars: 2 },
			strings,
			client: createClient(routes),
			schedule: timers.schedule,
		});
		await overlay.actions.open();
		const pending = overlay.actions.setQuery('lin');
		timers.run();
		await pending;
		const dom = createFakeDom();
		const node = render({ state: overlay.state(), actions: overlay.actions, strings, theme, dom });
		return { overlay, dom, node };
	};

	it('renders an ARIA combobox over a listbox in a modal dialog, tokens only', async () => {
		const { node, overlay } = await setup();
		const [input] = findAll(node, (n) => n.tag === 'input');
		const [list] = findAll(node, (n) => n.attributes?.role === 'listbox');
		expect(input.attributes).toMatchObject({
			role: 'combobox',
			'aria-expanded': 'true',
			'aria-autocomplete': 'list',
			'aria-controls': list.attributes.id,
			value: 'lin',
		});
		const options = findAll(node, (n) => n.attributes?.role === 'option');
		expect(options.map((o) => o.attributes['aria-selected'])).toEqual(['false', 'false']);
		const [dialog] = findAll(node, (n) => n.attributes?.role === 'dialog');
		expect(dialog.attributes['aria-modal']).toBe('true');
		expect(findAll(node, (n) => n.attributes?.role === 'status')[0].textContent).toBe('2 results');
		expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
		expect(styles).toContain('prefers-reduced-motion');
		input.dispatch('keydown', { key: 'ArrowDown', preventDefault: () => {} });
		await tick();
		expect(overlay.state().active).toBe(0);
		const next = render({ state: overlay.state(), actions: overlay.actions, strings, dom: createFakeDom() });
		const [input2] = findAll(next, (n) => n.tag === 'input');
		expect(input2.attributes['aria-activedescendant']).toMatch(/-opt-0$/);
		input2.dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
		await tick();
		expect(overlay.state().active).toBe(-1);
		const third = render({ state: overlay.state(), actions: overlay.actions, strings, dom: createFakeDom() });
		findAll(third, (n) => n.tag === 'input')[0].dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
		await tick();
		expect(overlay.state().open).toBe(false);
		input2.dispatch('keydown', { key: 'x', preventDefault: () => {} });
		input2.dispatch('input', { target: { value: 'w' } });
		await tick();
		expect(overlay.state().q).toBe('w');
	});

	it('opens with the button and the hotkey, follows chosen results and submits the form', async () => {
		/** @type {Record<string, Function>} */
		const docListeners = {};
		const assign = vi.fn();
		const win = {
			document: { addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => (docListeners[type] = fn) },
			location: { assign },
			localStorage: { getItem: () => null, setItem: () => {} },
		};
		const timers = createScheduler();
		const overlay = createOverlay({
			config: { min_chars: 2 },
			strings,
			client: createClient(routes),
			schedule: timers.schedule,
		});
		const dom = { ...createFakeDom(), defaultView: win };
		const node = render({ state: overlay.state(), actions: overlay.actions, strings, dom });
		await tick();
		const [button] = findAll(node, (n) => n.tag === 'button' && n.attributes['aria-haspopup'] === 'dialog');
		button.dispatch('click');
		await tick();
		expect(overlay.state().open).toBe(true);
		await overlay.actions.close();
		docListeners.keydown?.({ key: '/', target: { tagName: 'BODY' }, preventDefault: () => {} });
		await tick();
		expect(overlay.state().open).toBe(true);
		await overlay.actions.close();
		docListeners.keydown?.({ key: '/', target: { tagName: 'INPUT' }, preventDefault: () => {} });
		expect(overlay.state().open).toBe(false);
		const pending = overlay.actions.setQuery('lin');
		timers.run();
		await pending;
		const tree = render({ state: overlay.state(), actions: overlay.actions, strings, dom });
		const options = findAll(tree, (n) => n.attributes?.role === 'option');
		options[0].dispatch('mousedown', { preventDefault: () => {} });
		options[0].dispatch('click', { preventDefault: () => {} });
		await tick();
		await tick();
		expect(assign).toHaveBeenCalledWith('/a');
		const [form] = findAll(tree, (n) => n.tag === 'form');
		await overlay.actions.clearActive();
		form.dispatch('submit', { preventDefault: () => {} });
		await tick();
		await tick();
		expect(assign).toHaveBeenLastCalledWith('/search?q=lin');
		const [close] = findAll(tree, (n) => n.attributes?.['data-k'] === 'close');
		close.dispatch('click');
		const [dialog] = findAll(tree, (n) => n.attributes?.role === 'dialog');
		dialog.dispatch('keydown', { key: 'Tab' });
	});

	it('renders the inline variant with slots and handles the mod+k shortcut', async () => {
		const overlay = createOverlay({ config: { min_chars: 2, hotkey: 'mod+k' }, strings, client: createClient(routes) });
		/** @type {Record<string, Function>} */
		const listeners = {};
		const dom = {
			...createFakeDom(),
			defaultView: {
				document: { addEventListener: (/** @type {string} */ t, /** @type {Function} */ f) => (listeners[t] = f) },
			},
		};
		const before = dom.createElement('span');
		const node = render({
			state: overlay.state(),
			actions: overlay.actions,
			strings,
			theme: { variant: 'inline' },
			slots: { before },
			dom,
		});
		expect(node.attributes.class).toContain('ss-search--inline');
		expect(node.children[0]).toBe(before);
		const [input] = findAll(node, (n) => n.tag === 'input');
		input.dispatch('focus');
		await tick();
		expect(overlay.state().open).toBe(true);
		input.dispatch('keydown', { key: 'ArrowUp', preventDefault: () => {} });
		input.dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
		listeners.keydown?.({ key: 'k', ctrlKey: true, target: {}, preventDefault: () => {} });
		listeners.keydown?.({ key: 'j', ctrlKey: true, target: {}, preventDefault: () => {} });
		const closed = createOverlay({ config: { hotkey: 'none' }, strings, client: createClient(routes) });
		const inline = render({
			state: closed.state(),
			actions: closed.actions,
			strings,
			theme: { variant: 'inline' },
			dom: createFakeDom(),
		});
		findAll(inline, (n) => n.tag === 'input')[0].dispatch('keydown', { key: 'ArrowDown', preventDefault: () => {} });
		await tick();
		expect(closed.state().open).toBe(true);
	});

	it('keeps focus across re-renders and traps Tab', async () => {
		const actions = {};
		const focused = { getAttribute: () => 'q' };
		const target = { getAttribute: () => 'q', focus: vi.fn(), setSelectionRange: vi.fn(), value: 'abc' };
		const root1 = { contains: () => true, querySelectorAll: () => [target] };
		refocus(/** @type {any} */ ({ activeElement: focused }), actions, root1);
		refocus(/** @type {any} */ ({ activeElement: focused }), actions, root1);
		await tick();
		expect(target.focus).toHaveBeenCalled();
		expect(target.setSelectionRange).toHaveBeenCalledWith(3, 3);
		refocus(/** @type {any} */ ({ activeElement: null }), {}, {});
		expect(memo(actions).id).toMatch(/^ss-search-\d+$/);
		const head = { focus: vi.fn() };
		const tail = { focus: vi.fn() };
		const root = { querySelectorAll: () => [head, tail], ownerDocument: { activeElement: tail } };
		const event = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
		trapTab(event, root);
		expect(head.focus).toHaveBeenCalled();
		trapTab({ key: 'Tab', shiftKey: true, preventDefault: vi.fn() }, { ...root, ownerDocument: { activeElement: head } });
		expect(tail.focus).toHaveBeenCalled();
		trapTab({ key: 'Tab' }, { querySelectorAll: () => [] });
		trapTab({ key: 'Enter' }, root);
		expect(browserStorage(null)).toBeNull();
		const store = /** @type {any} */ (browserStorage({ localStorage: { getItem: () => 'v', setItem: vi.fn() } }));
		expect(store.get('k')).toBe('v');
		store.set('k', 'w');
		expect(
			browserStorage({
				get localStorage() {
					throw new Error('denied');
				},
			}),
		).toBeNull();
	});
});
