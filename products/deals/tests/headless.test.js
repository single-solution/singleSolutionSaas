import { describe, expect, it, vi } from 'vitest';
import en from '../strings/en.json' with { type: 'json' };
import { badgesClient, createBadges, itemKey } from '../headless/badges.js';
import { createDealsPage, dealsPageClient } from '../headless/dealsPage.js';
import { conditionNotes, countdownText, dateFormatter, moneyFormatter, rewardText } from '../headless/format.js';
import { createTranslator } from '../headless/strings.js';
import { render as renderBadges, styles as badgeStyles } from '../ui/badges.js';
import { render as renderPage, styles as pageStyles } from '../ui/dealsPage.js';
import { createFakeDom, dealCardView, findAll, offerView } from './helpers.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const t = createTranslator(en);
const money = moneyFormatter('en', 'EUR');

describe('copy', () => {
	it('formats money, rewards, conditions, countdowns and dates', () => {
		expect(money(12_345)).toBe('€123.45');
		expect(moneyFormatter('en', 'JPY')(1500)).toBe('¥1,500');
		expect(moneyFormatter('en', 'XXXX')(100)).toBe('$1.00');
		expect(rewardText(t, { type: 'percent', percent: 20 }, money)).toBe('20% off');
		expect(rewardText(t, { type: 'amount_off', amount: 500 }, money)).toBe('€5.00 off');
		expect(rewardText(t, { type: 'fixed_price', amount: 500 }, money)).toBe('Now €5.00');
		expect(rewardText(t, { type: 'buy_x_get_y', buy: 2, get: 1 }, money)).toBe('Buy 2, get 1 free');
		expect(rewardText(t, { type: 'buy_x_get_y', buy: 1, get: 1, percent: 50 }, money)).toBe('Buy 1, get 1 at 50% off');
		expect(rewardText(t, { type: 'free_shipping' }, money)).toBe('Free shipping');
		expect(rewardText(t, { type: 'tiered', upTo: { type: 'tier', percent: 10 } }, money)).toBe(
			'Spend more, save up to 10% off',
		);
		expect(rewardText(t, { type: 'tiered' }, money)).toBe('Spend more, save more');
		expect(rewardText(t, { type: 'tier', amount: 100 }, money)).toBe('€1.00 off');
		expect(rewardText(t, { type: 'tier', freeShipping: true }, money)).toBe('Free shipping');
		expect(rewardText(t, { type: 'x' }, money)).toBe('Special offer');
		expect(rewardText(t, { type: 'fixed_price', amount: 2000, bundle: 'mix_and_match', quantity: 3 }, money)).toBe(
			'Any 3 for €20.00',
		);
		expect(rewardText(t, { type: 'percent', percent: 10, bundle: 'buy_together' }, money)).toBe('10% off when bought together');
		expect(
			conditionNotes(
				t,
				{ minSubtotal: 5000, minQuantity: 2, paymentMethods: ['card'], deliveryMethods: ['pickup'], newCustomersOnly: true },
				money,
			),
		).toEqual(['on orders over €50.00', 'from 2 units', 'paying with card', 'with pickup', 'first order only']);
		const named = createTranslator({ ...en, 'method.card': 'a card' });
		expect(conditionNotes(named, { paymentMethods: ['card'] }, money)).toEqual(['paying with a card']);
		expect(countdownText(t, 26 * 3_600_000 + 60_000)).toBe('Ends in 1d 2h');
		expect(countdownText(t, 2 * 3_600_000 + 5 * 60_000)).toBe('Ends in 2h 5m');
		expect(countdownText(t, 65_000)).toBe('Ends in 1m 5s');
		expect(countdownText(t, -5)).toBe('Ends in 0m 0s');
		expect(dateFormatter('en', 'Europe/Berlin')('2026-10-02T16:00:00Z')).toContain('06:00 PM');
		expect(dateFormatter('en', 'Bad/Zone')('2026-10-02T16:00:00Z')).toContain('04:00 PM');
		expect(t('missing.key')).toBe('missing.key');
		expect(createTranslator({ a: 'x {y} {z}' })('a', { y: 1 })).toBe('x 1 {z}');
	});
});

describe('badges (headless)', () => {
	it('loads offers into badges, prices, strike-through, pills, countdowns and low-stock notes', async () => {
		const offers = vi.fn(async () => ({
			ok: /** @type {const} */ (true),
			value: {
				currency: 'EUR',
				items: [
					offerView(),
					offerView({
						itemId: 'itm_2',
						variantId: 'v',
						discount: 0,
						price: 10_000,
						badge: null,
						pills: [],
						countdown: null,
						deals: [],
					}),
				],
			},
		}));
		const emit = vi.fn();
		const element = createBadges({ config: { low_stock_below: 5 }, strings: en, client: { offers }, emit, now: () => NOW });
		const seen = vi.fn();
		const off = element.subscribe(seen);
		const result = await element.actions.load([{ itemId: 'itm_1' }, { itemId: 'itm_2', variantId: 'v' }], {
			currency: 'EUR',
			lock: true,
		});
		expect(result.ok).toBe(true);
		expect(offers).toHaveBeenCalledWith({
			items: [{ itemId: 'itm_1' }, { itemId: 'itm_2', variantId: 'v' }],
			currency: 'EUR',
			lock: true,
		});
		const [first, second] = element.state().items;
		expect(first).toMatchObject({
			key: 'itm_1',
			discounted: true,
			badgeText: '20% off',
			tone: 'urgent',
			priceText: '€80.00',
			compareAtText: '€100.00',
			strikeText: '€100.00',
			countdown: { text: 'Ends in 2h 0m' },
			lowStockText: 'Only 4 left',
		});
		expect(first?.pills[1]).toEqual({
			dealId: 'dl_2',
			text: 'Pay by card',
			notes: ['on orders over €50.00', 'paying with card'],
			tone: 'accent',
			conditional: true,
		});
		expect(second).toMatchObject({ key: 'itm_2:v', discounted: false, badgeText: null, strikeText: null, lowStockText: null });
		expect(emit).toHaveBeenCalledWith('badges.viewed', { items: 2, discounted: 1 });
		expect(element.actions.item({ itemId: 'itm_2', variantId: 'v' })?.key).toBe('itm_2:v');
		expect(element.actions.item({ itemId: 'none' })).toBeNull();
		expect(element.actions.tick(Date.parse('2026-10-02T14:00:01Z'))).toEqual({ ok: true, value: { expired: 1 } });
		expect(element.state().items[0]?.countdown?.text).toBe('Ends in 0m 0s');
		await element.actions.refresh();
		expect(offers).toHaveBeenCalledTimes(2);
		expect(seen).toHaveBeenCalled();
		off();
		element.destroy();
		await element.actions.refresh();
		expect(element.state().status).toBe('ready');
	});

	it('formats strike-through as percent or savings, validates input and reports errors', async () => {
		const ok = { offers: async () => ({ ok: /** @type {const} */ (true), value: { currency: 'EUR', items: [offerView()] } }) };
		const percent = createBadges({ config: { strike_format: 'percent' }, strings: en, client: ok, now: () => NOW });
		await percent.actions.load([{ itemId: 'itm_1' }]);
		expect(percent.state().items[0]?.strikeText).toBe('−20%');
		const savings = createBadges({ config: { strike_format: 'savings' }, strings: en, client: ok, now: () => NOW });
		await savings.actions.load([{ itemId: 'itm_1' }]);
		expect(savings.state().items[0]?.strikeText).toBe('Save €20.00');
		expect(savings.validate([])).toHaveLength(1);
		expect(savings.validate([{ itemId: '' }])).toEqual([
			{ path: '/0/itemId', code: 'required', message: 'Offers could not be loaded.' },
		]);
		expect(await savings.actions.load(/** @type {any} */ ([{}]))).toMatchObject({ ok: false });
		const busy = createBadges({
			strings: en,
			client: { offers: async () => ({ ok: /** @type {const} */ (false), error: { code: 'rate_limited' } }) },
		});
		await busy.actions.load([{ itemId: 'a' }]);
		expect(busy.state()).toMatchObject({ status: 'error', error: 'Offers are busy right now. Please try again.' });
		expect(busy.actions.tick()).toEqual({ ok: true, value: { expired: 0 } });
		const failing = createBadges({
			strings: {},
			client: { offers: async () => ({ ok: /** @type {const} */ (false), problem: { code: 'x' } }) },
		});
		await failing.actions.load([{ itemId: 'a' }]);
		expect(failing.state().error).toBe('badges.error');
		expect(itemKey({ itemId: 'a', variantId: null })).toBe('a');
		const api = { post: vi.fn(async () => ({ ok: true })) };
		await badgesClient(api).offers({ items: [{ itemId: 'a' }] });
		expect(api.post).toHaveBeenCalledWith('/v1/offers:evaluate', { items: [{ itemId: 'a' }] });
	});

	it('renders cards and product-page details with tokens only', async () => {
		const element = createBadges({
			strings: en,
			client: {
				offers: async () => ({
					ok: /** @type {const} */ (true),
					value: {
						currency: 'EUR',
						items: [offerView(), offerView({ itemId: 'itm_3', countdown: null, deals: [], pills: [] })],
					},
				}),
			},
			config: { low_stock_below: 10, strike_format: 'percent' },
			now: () => NOW,
		});
		await element.actions.load([{ itemId: 'itm_1' }]);
		const dom = createFakeDom();
		const card = renderBadges({ state: element.state(), strings: en, dom });
		expect(card.attributes).toMatchObject({ class: 'ss-deal ss-deal--card', role: 'group', 'aria-busy': 'false' });
		expect(card.textContent).toContain('20% off');
		expect(findAll(card, (n) => n.tag === 'ul')).toHaveLength(0);
		const detail = renderBadges({
			state: element.state(),
			strings: en,
			theme: { variant: 'detail', item: 'itm_1' },
			slots: { before: dom.createTextNode('B'), after: dom.createTextNode('A') },
			dom,
		});
		expect(findAll(detail, (n) => n.attributes?.role === 'timer')).toHaveLength(1);
		expect(detail.textContent).toContain('Only 4 left');
		expect(detail.textContent).toContain('· on orders over €50.00 · paying with card');
		expect(findAll(detail, (n) => n.tag === 'span' && n.attributes?.class === 'ss-deal__was')[0].textContent).toBe('−20%');
		const plain = renderBadges({ state: element.state(), strings: en, theme: { variant: 'detail', item: 'itm_3' }, dom });
		expect(findAll(plain, (n) => n.tag === 'ul')).toHaveLength(0);
		const errored = renderBadges({ state: { status: 'error', items: [], error: 'x' }, strings: en, dom });
		expect(errored.textContent).toBe('x');
		const compare = createBadges({
			strings: en,
			client: { offers: async () => ({ ok: /** @type {const} */ (true), value: { currency: 'EUR', items: [offerView()] } }) },
			now: () => NOW,
		});
		await compare.actions.load([{ itemId: 'itm_1' }]);
		expect(findAll(renderBadges({ state: compare.state(), strings: en, dom }), (n) => n.tag === 's')).toHaveLength(1);
		expect(badgeStyles).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
	});
});

describe('deals page (headless)', () => {
	const page = (/** @type {any[]} */ items, extra = {}) => ({
		ok: /** @type {const} */ (true),
		value: { items, nextCursor: 'c1', hasMore: true, ...extra },
	});
	it('loads deals, selects one, loads more deals and items, ticks countdowns', async () => {
		const client = {
			page: vi.fn(async (/** @type {any} */ query = {}) =>
				query.cursor
					? page(
							[
								dealCardView({
									id: 'dl_2',
									name: 'Later',
									schedule: {
										active: false,
										activeUntil: null,
										nextStart: '2026-10-03T16:00:00.000Z',
										timeZone: 'Europe/Berlin',
									},
									stockLeft: null,
									items: [],
									moreItems: false,
								}),
							],
							{ nextCursor: null, hasMore: false },
						)
					: page([dealCardView()]),
			),
			items: vi.fn(async (/** @type {string} */ _id, /** @type {any} */ query = {}) =>
				page(
					query.cursor
						? [
								{
									itemId: 'itm_2',
									variantId: 'v',
									title: null,
									url: null,
									image: null,
									currency: 'EUR',
									unitAmount: 500,
									price: 500,
								},
							]
						: [
								{
									itemId: 'itm_1',
									variantId: null,
									title: 'Runner',
									url: '/runner',
									image: null,
									currency: 'EUR',
									unitAmount: 10_000,
									price: 8000,
								},
							],
					{ nextCursor: query.cursor ? null : 'i1', hasMore: !query.cursor },
				),
			),
		};
		const emit = vi.fn();
		const element = createDealsPage({ strings: en, client, emit, now: () => NOW });
		await element.actions.load();
		const [deal] = element.state().deals;
		expect(deal).toMatchObject({
			id: 'dl_1',
			badgeText: '20% off',
			notes: ['from 2 units'],
			active: true,
			stockText: '4 left at this price',
			countdown: { text: 'Ends in 2h 0m' },
		});
		expect(deal?.timeText).toContain('Ends');
		expect(deal?.items[0]).toMatchObject({ title: 'Runner', priceText: '€80.00', compareAtText: '€100.00', discounted: true });
		expect(element.state().activeDealId).toBe('dl_1');
		expect(emit).toHaveBeenCalledWith('deals_page.viewed', { deals: 1 });
		await element.actions.loadMore();
		expect(element.state().deals.map((d) => d.id)).toEqual(['dl_1', 'dl_2']);
		expect(element.state().deals[1]?.timeText).toContain('Starts');
		expect(await element.actions.loadMore()).toMatchObject({ ok: false });
		expect(element.actions.select('dl_2')).toEqual({ ok: true, value: { dealId: 'dl_2' } });
		expect(element.actions.select('none')).toMatchObject({ ok: false });
		await element.actions.loadItems('dl_1');
		await element.actions.loadItems('dl_1');
		expect(element.state().deals[0]?.items.map((i) => i.key)).toEqual(['itm_1', 'itm_2:v']);
		expect(await element.actions.loadItems('none')).toMatchObject({ ok: false });
		element.actions.tick(Date.parse('2026-10-02T13:00:00Z'));
		expect(element.state().deals[0]?.countdown?.text).toBe('Ends in 1h 0m');
		expect(element.validate({ dealId: '' })).toHaveLength(1);
		expect(element.validate({ dealId: 'x' })).toEqual([]);

		const dom = createFakeDom();
		const root = renderPage({
			state: element.state(),
			actions: element.actions,
			strings: en,
			theme: { variant: 'list' },
			slots: { before: dom.createTextNode('B') },
			dom,
		});
		expect(root.attributes.class).toBe('ss-deals ss-deals--list');
		const tabs = findAll(root, (n) => n.attributes?.class === 'ss-deals__tab');
		expect(tabs.map((n) => n.attributes['aria-pressed'])).toEqual(['false', 'true']);
		tabs[0].dispatch('click');
		expect(element.state().activeDealId).toBe('dl_1');
		const again = renderPage({ state: element.state(), actions: element.actions, strings: en, dom });
		expect(findAll(again, (n) => n.tag === 'li' && n.attributes?.class === 'ss-deals__item')).toHaveLength(2);
		expect(findAll(again, (n) => n.tag === 'a')[0].attributes.href).toBe('/runner');
		expect(pageStyles).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
		element.destroy();
	});

	it('renders loading, empty, error and paging states', async () => {
		const dom = createFakeDom();
		const actions = { select: vi.fn(), loadItems: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined) };
		const base = {
			status: /** @type {const} */ ('ready'),
			deals: [],
			activeDealId: null,
			cursor: null,
			hasMore: false,
			loadingMore: false,
			error: null,
		};
		expect(renderPage({ state: { ...base, status: 'loading' }, actions, strings: en, dom }).textContent).toContain(
			'Loading deals…',
		);
		expect(renderPage({ state: base, actions, strings: en, dom }).textContent).toContain('No deals right now');
		expect(
			renderPage({ state: base, actions, strings: en, slots: { empty: dom.createTextNode('nothing') }, dom }).textContent,
		).toContain('nothing');
		const failing = createDealsPage({
			strings: en,
			client: {
				page: async () => ({ ok: /** @type {const} */ (false), problem: { code: 'x' } }),
				items: async () => ({ ok: /** @type {const} */ (false), problem: { code: 'x' } }),
			},
		});
		await failing.actions.load();
		expect(failing.state()).toMatchObject({ status: 'error', error: 'Deals could not be loaded. Please try again.' });
		const card = {
			id: 'd',
			kind: 'item',
			name: 'n',
			description: null,
			badgeText: 'b',
			tone: 'accent',
			notes: [],
			active: true,
			timeText: null,
			countdown: null,
			stockText: null,
			items: [],
			moreItems: true,
			itemsCursor: null,
			loadingItems: true,
		};
		const root = renderPage({
			state: { ...base, deals: [card], activeDealId: 'd', hasMore: true, loadingMore: true },
			actions,
			strings: en,
			dom,
		});
		const buttons = findAll(root, (n) => n.attributes?.class === 'ss-deals__more');
		expect(buttons.map((b) => b.attributes.disabled)).toEqual(['', '']);
		buttons.forEach((b) => b.dispatch('click'));
		expect(actions.loadMore).toHaveBeenCalled();
		expect(actions.loadItems).toHaveBeenCalledWith('d');
		// failing item loads and more pages keep the page
		const partial = createDealsPage({
			strings: en,
			client: {
				page: async (/** @type {any} */ q = {}) =>
					q.cursor ? { ok: /** @type {const} */ (false), problem: {} } : page([dealCardView({ currency: null })]),
				items: async () => ({ ok: /** @type {const} */ (false), problem: {} }),
			},
			now: () => NOW,
		});
		await partial.actions.load();
		await partial.actions.loadMore();
		await partial.actions.loadItems('dl_1');
		expect(partial.state()).toMatchObject({ loadingMore: false, error: 'Deals could not be loaded. Please try again.' });
		const api = { get: vi.fn(async () => ({ ok: true })) };
		const c = dealsPageClient(api);
		await c.page();
		await c.page({ cursor: 'x y' });
		await c.items('dl 1');
		await c.items('dl_1', { cursor: 'c' });
		expect(api.get.mock.calls.map((call) => /** @type {any[]} */ (call)[0])).toEqual([
			'/v1/deals-page',
			'/v1/deals-page?cursor=x%20y',
			'/v1/deals-page/dl%201/items',
			'/v1/deals-page/dl_1/items?cursor=c',
		]);
	});
});
