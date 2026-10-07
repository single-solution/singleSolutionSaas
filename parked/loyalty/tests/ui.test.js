import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createWallet } from '../headless/wallet.js';
import { render, styles } from '../ui/wallet.js';
import { createFakeDom, findAll, walletView } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const loaded = async (view = walletView()) => {
	const wallet = createWallet({ strings, client: { wallet: async () => ({ ok: /** @type {const} */ (true), value: view }) } });
	await wallet.actions.load();
	return wallet;
};

describe('ui/wallet renderer', () => {
	it('renders an accessible panel: balance, tier progress, expiring points, history and "show more"', async () => {
		const wallet = await loaded();
		const root = render({ state: wallet.state(), actions: wallet.actions, strings, dom: createFakeDom() });
		expect(root.attributes).toMatchObject({ role: 'region', 'aria-label': 'Your rewards', 'aria-busy': 'false' });
		expect(root.attributes.class).toContain('ss-wallet--panel');
		const [progress] = findAll(root, (node) => node.tag === 'progress');
		expect(progress.attributes).toMatchObject({ max: '100', value: '30', 'aria-label': 'Progress to the next tier' });
		expect(findAll(root, (node) => node.tag === 'li')).toHaveLength(2);
		expect(findAll(root, (node) => node.attributes?.role === 'note')[0].textContent).toBe('300 points expire on Oct 15, 2026');
		const [more] = findAll(root, (node) => node.tag === 'button');
		more.dispatch('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(wallet.state().history).toHaveLength(4);
		expect(findAll(root, (node) => node.attributes?.role === 'status')).toHaveLength(1);
	});

	it('renders the badge variant, slots, the empty state and loading/disabled states', async () => {
		const wallet = await loaded(walletView({ history: { items: [], nextCursor: null, hasMore: false } }));
		const dom = createFakeDom();
		const badge = render({
			state: wallet.state(),
			actions: wallet.actions,
			strings,
			theme: { variant: 'badge' },
			slots: { before: dom.createTextNode('★') },
			dom,
		});
		expect(badge.attributes.class).toContain('ss-wallet--badge');
		expect(badge.children[0].text).toBe('★');
		expect(findAll(badge, (node) => node.tag === 'ul')).toHaveLength(0);
		const empty = render({
			state: wallet.state(),
			actions: wallet.actions,
			strings,
			slots: { after: dom.createTextNode('end') },
			dom,
		});
		expect(empty.textContent).toContain('No points activity yet.');
		const custom = render({
			state: wallet.state(),
			actions: wallet.actions,
			strings,
			slots: { empty: dom.createTextNode('Nothing') },
			dom,
		});
		expect(custom.textContent).toContain('Nothing');
		const loading = render({
			state: { ...wallet.state(), status: 'loading', hasMore: true, loadingMore: true, showTier: false, error: 'oops' },
			actions: wallet.actions,
			strings,
			dom,
		});
		expect(loading.attributes['aria-busy']).toBe('true');
		expect(loading.textContent).toContain('Loading your rewards…');
		expect(loading.textContent).toContain('oops');
		expect(findAll(loading, (node) => node.tag === 'button')[0].attributes.disabled).toBe('');
		const plain = render({
			state: { ...wallet.state(), showHistory: false, nextTierText: 'x', progress: null },
			actions: wallet.actions,
			strings,
			dom,
		});
		expect(findAll(plain, (node) => node.tag === 'progress')).toHaveLength(0);
	});

	it('uses design tokens only and stays inside the 8 KB budget', () => {
		expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
		expect(styles).toMatch(/var\(--ss-color-primary\)/);
		const source = ['../ui/wallet.js', '../headless/wallet.js', '../headless/strings.js'].map((file) =>
			readFileSync(new URL(file, import.meta.url)),
		);
		const bytes = gzipSync(Buffer.concat(source)).length;
		expect(bytes).toBeLessThan(8 * 1024);
	});
});
