/** Free-tier scheduling: the background sweep after requests runs due crawl steps within a time budget. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SWEEP_BUDGET_MS, SWEEP_INTERVAL_MS } from '../jobs/sweep.js';
import { HOUR, WEBSITE, WEBSITE_2, createHarness } from './harness.js';

const BASE = 'https://shop.example.com';
const FEED = {
	key: 'feed',
	kind: 'json',
	url: `${BASE}/feed.json`,
	type: 'item',
	every_hours: 6,
	records_path: 'products',
	fields: [{ field: 'title', path: 'name' }],
};

describe('background sweep', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let h;
	beforeAll(async () => {
		h = await createHarness({ config: { sources: { crawl_sources: [FEED] } } });
		h.site.pages.set(`${BASE}/feed.json`, {
			type: 'application/json',
			body: JSON.stringify({ products: [{ id: 'p1', name: 'Linen shirt' }] }),
		});
	});
	afterAll(async () => h.close());
	const feedRequests = () => h.site.requests.filter((r) => r.url === `${BASE}/feed.json`).length;

	it('is registered per website and crawls due sources when triggered (throttled per interval)', async () => {
		expect(h.search.tasks.sweep.name).toBe('sweep');
		expect(SWEEP_INTERVAL_MS).toBe(15 * 60_000);
		expect(SWEEP_BUDGET_MS).toBeLessThan(SWEEP_INTERVAL_MS);
		expect(await h.search.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		expect(feedRequests()).toBe(1);
		const ids = (await h.collection('documents').find({ websiteId: WEBSITE, source: 'crawl:feed' }).toArray()).map(
			(/** @type {any} */ d) => d.id,
		);
		expect(ids).toEqual(['feed:p1']);
		// throttled until the interval passed; per website, never without one
		expect(await h.search.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(false);
		expect(await h.search.tasks.sweep.trigger()).toBe(false);
		h.clock.advance(SWEEP_INTERVAL_MS);
		expect(await h.search.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		expect(feedRequests()).toBe(1); // not due before every_hours
		h.clock.advance(6 * HOUR);
		expect(await h.search.tasks.sweep.trigger({ websiteId: WEBSITE })).toBe(true);
		expect(feedRequests()).toBe(2);
		// a website without an entitlement is skipped quietly
		expect(await h.search.tasks.sweep.trigger({ websiteId: WEBSITE_2 })).toBe(true);
	});

	it('starts no crawl step once the time budget is spent', async () => {
		h.clock.advance(6 * HOUR);
		const site = /** @type {any} */ (await h.search.siteFor(WEBSITE));
		expect(await h.search.sources.runDue(site, { deadline: h.clock.now() })).toEqual({ crawled: 0 });
		expect(await h.search.sources.runDue(site, { deadline: h.clock.now() + 1 })).toEqual({ crawled: 1 });
	});
});
