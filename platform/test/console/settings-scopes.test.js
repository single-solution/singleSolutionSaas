/** F.16 console helpers: website settings body, key scope groups, resources needed now vs if enabled. */
import { describe, expect, it } from 'vitest';
import { neededResources } from '../../src/console/views/connectors.js';
import { scopeGroups } from '../../src/console/views/keys.js';
import { settingsBody } from '../../src/console/views/websites.js';

describe('console helpers (F.16)', () => {
	it('sends only changed website settings; empty clears', () => {
		const website = { timeZone: 'UTC', language: null, currency: 'EUR' };
		expect(settingsBody({ timeZone: 'UTC', language: '', currency: 'EUR' }, website)).toBeNull();
		expect(settingsBody({ timeZone: ' Europe/Berlin ', language: 'de', currency: '' }, website)).toEqual({
			timeZone: 'Europe/Berlin',
			language: 'de',
			currency: null,
		});
	});

	it('groups the scope catalogue: platform first, then per product', () => {
		expect(
			scopeGroups([
				{ scope: 'elements.read', group: 'platform', label: 'Read elements' },
				{ scope: 'reviews.read', group: 'reviews', product: 'Reviews', label: 'Read' },
				{ scope: 'reviews.write', group: 'reviews', product: 'Reviews', label: 'Write' },
			]),
		).toEqual([
			{ group: 'platform', title: 'Platform', options: [{ value: 'elements.read', label: 'Read elements (elements.read)' }] },
			{
				group: 'reviews',
				title: 'Reviews',
				options: [
					{ value: 'reviews.read', label: 'Read (reviews.read)' },
					{ value: 'reviews.write', label: 'Write (reviews.write)' },
				],
			},
		]);
	});

	it('splits resources needed now from those needed once an element is enabled', () => {
		const catalog = [
			{ appId: 'app_a', slug: 'a', name: 'Alerts', requires: ['database'], elements: [{ key: 'sms', name: 'SMS' }] },
		];
		const needs = [
			{ appId: 'app_a', productSlug: 'a', kind: 'database', neededNow: true, elements: [] },
			{ appId: 'app_a', productSlug: 'a', kind: 'messaging', neededNow: false, elements: ['sms'] },
		];
		const out = neededResources(needs, [], catalog);
		expect([...out.now]).toEqual([['database', ['Alerts']]]);
		expect([...out.ifEnabled]).toEqual([['messaging', ['SMS (Alerts)']]]);
		// without needs (older Portal): product-level kinds of live subscriptions
		const legacy = neededResources(
			null,
			[
				{ appId: 'app_a', status: 'active' },
				{ appId: 'app_a', status: 'cancelled' },
			],
			catalog,
		);
		expect([...legacy.now]).toEqual([['database', ['Alerts']]]);
		expect(legacy.ifEnabled.size).toBe(0);
	});
});
