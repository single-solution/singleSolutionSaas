import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWallet } from '../headless/wallet.js';
import { createTranslator } from '../headless/strings.js';
import { walletView } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));

describe('headless/wallet', () => {
	it('loads the wallet, formats texts from the catalog and pages the history', async () => {
		/** @type {Array<unknown>} */
		const calls = [];
		const client = {
			wallet: async (/** @type {any} */ query) => {
				calls.push(query);
				return query?.cursor
					? {
							ok: /** @type {const} */ (true),
							value: walletView({
								history: {
									items: [
										{
											id: 'ptx_0',
											kind: 'adjust',
											points: 1,
											occurredAt: '2026-08-01T00:00:00.000Z',
											reason: 'goodwill',
										},
									],
									nextCursor: null,
									hasMore: false,
								},
							}),
						}
					: { ok: /** @type {const} */ (true), value: walletView() };
			},
		};
		/** @type {Array<[string, unknown]>} */
		const events = [];
		const wallet = createWallet({ strings, client, emit: (name, data) => events.push([name, data]) });
		/** @type {string[]} */
		const seen = [];
		const off = wallet.subscribe((state) => seen.push(state.status));
		expect(wallet.state()).toMatchObject({ status: 'idle', balanceText: '0 points', showHistory: true });
		await wallet.actions.load();
		const state = wallet.state();
		expect(Object.isFrozen(state)).toBe(true);
		expect(state).toMatchObject({
			status: 'ready',
			balanceText: '1,234 points',
			tierText: 'Silver member',
			nextTierText: '3,500 to Gold',
			progress: 30,
			expiringText: '300 points expire on Oct 15, 2026',
			hasMore: true,
		});
		expect(state.history.map((item) => `${item.label} ${item.pointsText}`)).toEqual(['Redeemed -500', 'Earned +1,734']);
		expect(events).toEqual([['wallet.viewed', { balance: 1234 }]]);
		await wallet.actions.loadMore();
		expect(wallet.state().history).toHaveLength(3);
		expect(wallet.state().hasMore).toBe(false);
		expect((await wallet.actions.loadMore()).ok).toBe(false);
		expect(calls).toEqual([undefined, { cursor: 'c1' }]);
		expect(seen).toContain('loading');
		expect(wallet.formatPoints(1)).toBe('1 point');
		off();
		wallet.destroy();
		await wallet.actions.load();
		expect(wallet.state().status).toBe('ready'); // destroyed: no more updates
	});

	it('shows top tier, no tier and no expiring points', async () => {
		const top = createWallet({
			strings,
			client: {
				wallet: async () => ({
					ok: /** @type {const} */ (true),
					value: walletView({ tier: { key: 'gold', name: 'Gold', metric: 9000, next: null }, expiring: null }),
				}),
			},
		});
		await top.actions.load();
		expect(top.state()).toMatchObject({ nextTierText: 'Top tier reached', progress: 100, expiringText: null });
		const none = createWallet({
			strings,
			client: { wallet: async () => ({ ok: /** @type {const} */ (true), value: walletView({ tier: null }) }) },
		});
		await none.actions.load();
		expect(none.state()).toMatchObject({ tierText: null, nextTierText: null, progress: null });
	});

	it('surfaces problems with user-facing messages and validates cursors', async () => {
		const failing = createWallet({
			strings,
			config: { show_history: false, show_tier: false },
			client: {
				wallet: async () => ({ ok: /** @type {const} */ (false), problem: { code: 'identity_required', status: 401 } }),
			},
		});
		expect(failing.state()).toMatchObject({ showHistory: false, showTier: false });
		await failing.actions.load();
		expect(failing.state()).toMatchObject({ status: 'error', error: 'Sign in to see your rewards.' });
		let page = 0;
		const flaky = createWallet({
			strings,
			client: {
				wallet: async () =>
					(page += 1) === 1
						? { ok: /** @type {const} */ (true), value: walletView() }
						: { ok: /** @type {const} */ (false), problem: { code: 'network_error' } },
			},
		});
		await flaky.actions.load();
		await flaky.actions.loadMore();
		expect(flaky.state()).toMatchObject({ loadingMore: false, error: 'Your rewards could not be loaded. Please try again.' });
		expect(flaky.validate({ cursor: 5 })).toHaveLength(1);
		expect(flaky.validate({ cursor: 'abc' })).toEqual([]);
		expect(flaky.validate(null)).toEqual([]);
		expect(
			createWallet({ client: { wallet: async () => ({ ok: /** @type {const} */ (true), value: walletView() }) } }).state()
				.balanceText,
		).toBe('wallet.points.other');
	});

	it('translates with placeholders and shows missing keys', () => {
		const t = createTranslator({ hi: 'Hello {name} {missing}' });
		expect(t('hi', { name: 'Ann' })).toBe('Hello Ann {missing}');
		expect(t('nope')).toBe('nope');
	});
});
