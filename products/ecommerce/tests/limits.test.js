/**
 * The fixed limits of Ecommerce (core/limits.js) keep the old defaults of the settings they replaced (a limit that was
 * off has a generous value now), no settings schema offers them any more, and the invoice labels are texts, not
 * settings.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INVOICE_LABELS } from '../core/invoice.js';
import * as limits from '../core/limits.js';
import strings from '../strings/en.json' with { type: 'json' };

describe('fixed limits', () => {
	it('keep the defaults of the settings they replaced', () => {
		expect(limits.TOP_FIELD).toBe('sold');
		expect([limits.IMAGE_MAX_BYTES, limits.VIDEO_MAX_BYTES]).toEqual([5 * 1024 * 1024, 64 * 1024 * 1024]);
		expect(limits.SEARCH_INDEX).toBe('ss_ecommerce_products_search');
		expect([limits.OPEN_ORDER_CAP, limits.CART_MAX_LINES, limits.CART_MAX_QUANTITY, limits.COMPARE_MAX_PRODUCTS]).toEqual([
			3, 50, 99, 4,
		]);
		expect([limits.LANDING_MIN_PRODUCTS, limits.AUTO_LANDING_MIN_PRODUCTS, limits.LANDING_MIN_VARIANTS]).toEqual([3, 2, 3]);
		expect([limits.AUTO_LANDING_MAX_PAGES, limits.SITEMAP_FILE_SIZE, limits.LLMS_TXT_PRODUCTS]).toEqual([2000, 10_000, 50]);
		expect([limits.RETURN_PHOTO_MAX_MB, limits.STAFF_ALERT_MAX_RECIPIENTS]).toEqual([5, 100]);
	});

	it('the order burst limit was off; now a customer may place 10 orders in 15 minutes', () => {
		expect([limits.ORDER_BURST_LIMIT, limits.ORDER_BURST_WINDOW_MINUTES]).toEqual([10, 15]);
	});

	it('no settings schema offers a removed limit', () => {
		const folder = new URL('../schemas/', import.meta.url);
		const removed = {
			catalog: ['topBasis', 'imageMaxBytes', 'videoMaxBytes', 'chatSearch', 'searchIndex'],
			checkout: ['policyFormat', 'openOrderCap', 'placeLimit', 'placeWindowMinutes', 'maxLines', 'maxQuantity'],
			compare: ['maxProducts'],
			landing_pages: ['landingMinProducts', 'autoMaxPages', 'autoMinProducts', 'autoMinInStockVariants'],
			llms_txt: ['products'],
			returns: ['photoMaxMb'],
			seo: ['sitemapSize'],
			staff_alerts: ['maxRecipients'],
		};
		const offered = [];
		for (const [feature, keys] of Object.entries(removed)) {
			const schema = JSON.parse(readFileSync(new URL(`${feature}.settings.json`, folder), 'utf8'));
			for (const key of keys) if (key in schema.properties) offered.push(`${feature}.${key}`);
		}
		expect(offered).toEqual([]);
	});

	it('the invoice labels are not settings: each is a text with its words in strings/en.json', () => {
		const folder = new URL('../schemas/', import.meta.url);
		const schema = JSON.parse(readFileSync(new URL('invoices.settings.json', folder), 'utf8'));
		expect(Object.keys(schema.properties).filter((key) => key.startsWith('label'))).toEqual([]);
		expect(Object.keys(INVOICE_LABELS)).toHaveLength(32);
		for (const key of Object.values(INVOICE_LABELS)) expect(typeof (/** @type {any} */ (strings)[key])).toBe('string');
	});
});
