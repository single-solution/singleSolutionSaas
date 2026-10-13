// @vitest-environment jsdom
/* global window */
/**
 * The alert stop page (visitor widget `alerts_stop`, EN-1): the token from the page address, Stop on a press only, and
 * what the answer says.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountAlertsStop, stopTokenOf } from '../ui/alerts-stop.js';
import { $, buttonOf, click, configOf, fail, flush, makeShop, ok, place, resetPage, text, textOf } from './ui-shop-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

const TOKEN = 'AbCdEfGhJkMnPqRsTuVwXyZ234567892';

/** @param {ReturnType<typeof makeShop>} fake */
const mount = async (fake) => {
	const host = place('alerts_stop');
	await mountAlertsStop({ host, config: configOf(['alerts']), shop: fake.shop, win: window });
	await flush();
	return host;
};

describe('alert stop page', () => {
	it('reads the token from the last path segment or ?token=', () => {
		expect(stopTokenOf(new URL(`https://shop.example.com/alerts/unsubscribe/${TOKEN}`))).toBe(TOKEN);
		expect(stopTokenOf(new URL(`https://shop.example.com/alerts/stop?token=${TOKEN}`))).toBe(TOKEN);
		expect(stopTokenOf(new URL('https://shop.example.com/alerts/unsubscribe/short'))).toBe('');
		expect(stopTokenOf(new URL('https://shop.example.com/'))).toBe('');
	});

	it('stops the alerts only when the shopper presses Stop, and says what happened', async () => {
		let answer = fail(500, 'internal_error');
		const fake = makeShop({
			features: ['alerts'],
			url: `https://shop.example.com/alerts/unsubscribe/${TOKEN}`,
			routes: { [`POST /v1/shop/alerts/unsubscribe/${TOKEN}`]: () => answer },
		});
		const host = await mount(fake);
		expect(host.getAttribute('data-ss-mounted')).toBe('alerts-stop');
		expect(textOf(host)).toContain(text('alertsStop.intro'));
		expect(fake.all(`POST /v1/shop/alerts/unsubscribe/${TOKEN}`)).toHaveLength(0);
		await click(buttonOf(host, text('alertsStop.stop')));
		expect(textOf(host)).toContain(text('alertsStop.failed'));
		answer = ok({ removed: 2 });
		await click(buttonOf(host, text('alertsStop.stop')));
		expect(textOf(host)).toContain(text('alertsStop.stopped'));
		expect(() => buttonOf(host, text('alertsStop.stop'))).toThrow();
	});

	it('says when nothing was left to stop, or the link is incomplete', async () => {
		const used = makeShop({
			features: ['alerts'],
			url: `https://shop.example.com/alerts/stop?token=${TOKEN}`,
			routes: { [`POST /v1/shop/alerts/unsubscribe/${TOKEN}`]: () => ok({ removed: 0 }) },
		});
		const host = await mount(used);
		await click(buttonOf(host, text('alertsStop.stop')));
		expect(textOf(host)).toContain(text('alertsStop.none'));
		const broken = await mount(makeShop({ features: ['alerts'], url: 'https://shop.example.com/alerts/unsubscribe/' }));
		expect(textOf(broken)).toContain(text('alertsStop.noLink'));
		expect($(broken, 'button')).toBeNull();
	});
});
