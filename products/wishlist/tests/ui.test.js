import { describe, expect, it } from 'vitest';
import { createWishlist } from '../headless/wishlist.js';
import { render, styles } from '../ui/wishlist.js';
import en from '../strings/en.json' with { type: 'json' };
import { createFakeDom, createWishlistClient, findAll } from './helpers.js';

const shirt = { itemId: 'itm_1', title: 'Linen shirt', price: { amount: 4900, currency: 'EUR' } };
/** @param {any} root @param {string} label */
const buttonNamed = (root, label) =>
	findAll(root, (n) => n.tag === 'button' && (n.attributes['aria-label'] === label || n.textContent === label))[0];

describe('render (Mode A)', () => {
	it('renders the heart as an aria-pressed toggle that never follows the card link', async () => {
		const element = createWishlist({ config: { item: shirt }, strings: en, client: createWishlistClient() });
		await element.actions.load();
		const dom = createFakeDom();
		const root = render({ state: element.state(), actions: element.actions, strings: en, theme: { variant: 'heart' }, dom });
		const heart = findAll(root, (n) => n.tag === 'button')[0];
		expect(heart.attributes).toMatchObject({
			type: 'button',
			'aria-pressed': 'false',
			'aria-label': 'Save Linen shirt to your wishlist',
			class: 'ss-wl__heart',
		});
		let prevented = 0;
		let stopped = 0;
		heart.dispatch('click', { preventDefault: () => (prevented += 1), stopPropagation: () => (stopped += 1) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect([prevented, stopped]).toEqual([1, 1]);
		const after = render({ state: element.state(), actions: element.actions, strings: en, dom });
		const pressed = findAll(after, (n) => n.tag === 'button')[0];
		expect(pressed.attributes).toMatchObject({ 'aria-pressed': 'true', 'aria-label': 'Remove Linen shirt from your wishlist' });
		expect(findAll(after, (n) => n.attributes?.role === 'status')[0].textContent).toBe('Linen shirt saved to your wishlist');
		const busy = render({ state: { ...element.state(), busy: true, saved: false, item: null }, actions: {}, strings: en, dom });
		expect(findAll(busy, (n) => n.tag === 'button')[0].attributes).toMatchObject({
			'aria-busy': 'true',
			'aria-label': 'Save this item to your wishlist',
		});
	});

	it('renders the list page with lists, items, opt-in, sharing and list management', async () => {
		const client = createWishlistClient({ owner: 'customer' });
		const element = createWishlist({ config: { view: 'page' }, strings: en, client });
		await element.actions.load();
		await element.actions.createList('Gifts');
		await element.actions.createList('Home');
		await element.actions.select(client.lists[0].id);
		await element.store.add(
			{ ...shirt, url: 'https://shop.example.com/p/1', image: 'https://cdn.test/1.jpg' },
			client.lists[0].id,
		);
		await element.store.add({ itemId: 'itm_2', title: null }, client.lists[0].id);
		client.lists[0].items[0].inStock = false;
		await element.actions.share(client.lists[0].id);
		const dom = createFakeDom();
		const slots = { before: dom.createTextNode('B'), after: dom.createTextNode('A') };
		const root = render({ state: element.state(), actions: element.actions, strings: en, dom, slots });
		expect(root.attributes).toMatchObject({
			class: 'ss-wl ss-wl--page',
			role: 'region',
			'aria-label': en['page.title'],
			'aria-busy': 'false',
		});
		expect(root.children[0]).toBe(slots.before);
		expect(root.children.at(-1)).toBe(slots.after);
		const tabs = findAll(root, (n) => n.attributes?.role === 'group')[0];
		expect(tabs.children.map((/** @type {any} */ b) => [b.textContent, b.attributes['aria-current']])).toEqual([
			['Gifts (2)', 'true'],
			['Home (0)', 'false'],
		]);
		expect(findAll(root, (n) => n.tag === 'li')).toHaveLength(2);
		expect(findAll(root, (n) => n.tag === 'a')[0].attributes.href).toBe('https://shop.example.com/p/1');
		expect(findAll(root, (n) => n.tag === 'img')[0].attributes).toMatchObject({ alt: 'Linen shirt', loading: 'lazy' });
		expect(findAll(root, (n) => n.textContent === en['page.out_of_stock'])).not.toHaveLength(0);
		expect(findAll(root, (n) => n.tag === 'input' && n.attributes.readonly === '')[0].attributes.value).toBe(
			'https://shop.example.com/s?t=tok',
		);
		// every control is wired to the headless actions
		buttonNamed(root, 'Remove Linen shirt').dispatch('click');
		buttonNamed(root, 'Home (0)').dispatch('click');
		findAll(root, (n) => n.attributes?.name === 'notify')[0].dispatch('change', { target: { checked: true } });
		buttonNamed(root, en['page.share']).dispatch('click');
		buttonNamed(root, en['page.share.revoke']).dispatch('click');
		const name = findAll(root, (n) => n.attributes?.name === 'name')[0];
		name.dispatch('input', { target: { value: 'Third' } });
		findAll(root, (n) => n.tag === 'form')[0].dispatch('submit', { preventDefault: () => {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
		buttonNamed(root, 'Delete the list Gifts').dispatch('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const called = client.calls.map(([action]) => action);
		for (const action of ['remove', 'updateList', 'share', 'revoke', 'createList', 'deleteList'])
			expect(called).toContain(action);
	});

	it('renders empty, signed-out, rows and share views', async () => {
		const dom = createFakeDom();
		const empty = createWishlist({
			config: { view: 'page' },
			strings: en,
			client: createWishlistClient({ settings: { manageLists: false, share: false } }),
		});
		await empty.actions.load();
		const emptyRoot = render({
			state: empty.state(),
			actions: empty.actions,
			strings: en,
			dom,
			slots: { empty: dom.createTextNode('E') },
		});
		expect(emptyRoot.textContent).toContain('E');
		expect(findAll(emptyRoot, (n) => n.tag === 'form')).toHaveLength(0);
		const out = createWishlist({ config: { view: 'page' }, strings: en, client: createWishlistClient({ owner: null }) });
		await out.actions.load();
		expect(render({ state: out.state(), actions: out.actions, strings: en, dom }).textContent).toContain(en['page.sign_in']);
		const rows = createWishlist({
			config: { view: 'page' },
			strings: en,
			client: createWishlistClient({
				settings: { layout: 'rows' },
				lists: [{ id: 'wl_1', name: 'Wishlist', isDefault: true, notify: false, shared: true, items: [] }],
			}),
		});
		await rows.actions.load();
		const rowsRoot = render({ state: rows.state(), actions: rows.actions, strings: en, dom });
		expect(findAll(rowsRoot, (n) => n.textContent === en['page.empty'])).not.toHaveLength(0);
		const shared = createWishlist({
			config: { view: 'share', shareToken: 'tok' },
			strings: en,
			client: createWishlistClient(),
		});
		await shared.actions.load();
		const sharedRoot = render({
			state: shared.state(),
			actions: shared.actions,
			strings: en,
			dom,
			theme: { variant: 'share' },
		});
		expect(sharedRoot.attributes).toMatchObject({ class: 'ss-wl ss-wl--share', 'aria-label': 'Birthday' });
		expect(findAll(sharedRoot, (n) => n.tag === 'button')).toHaveLength(0);
		expect(findAll(sharedRoot, (n) => n.tag === 'li')).toHaveLength(1);
		const gone = createWishlist({ config: { view: 'share', shareToken: 'x' }, strings: en, client: createWishlistClient() });
		await gone.actions.load();
		const goneRoot = render({ state: gone.state(), actions: gone.actions, strings: en, dom });
		expect(goneRoot.textContent).toContain(en['share.error.not_found']);
		const emptyShare = render({
			state: { ...shared.state(), shared: { name: 'X', items: [] } },
			actions: {},
			strings: en,
			dom,
		});
		expect(emptyShare.textContent).toContain(en['page.empty']);
	});

	it('styles with design tokens only and respects reduced motion', () => {
		expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
		expect(styles).toContain('var(--ss-color-focus)');
		expect(styles).toContain('prefers-reduced-motion');
	});
});
