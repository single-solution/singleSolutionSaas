/**
 * The fixed limits of Chat (core/limits.js) keep the old defaults of the settings they replaced, and no settings
 * schema offers them any more.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	AI_COST_ALERT_PERCENT,
	AI_MAX_OUTPUT_TOKENS,
	AI_REPLIES_PER_NETWORK_PER_DAY,
	AI_REPLIES_PER_VISITOR_PER_DAY,
	AI_TEMPERATURE,
	CONTEXT_PANEL_ORDERS,
	GUEST_REMEMBER_DAYS,
	LANGUAGE_MIN_MARKERS,
	NEW_GUESTS_PER_NETWORK,
	PROACTIVE_DISMISS_DAYS,
	REASSURE_AFTER_MINUTES,
	SHOP_CONTEXT_MAX_CHARACTERS,
	SHOP_DEALS_COUNT,
	SHOP_MY_ORDERS_COUNT,
	SHOP_SEARCH_MAX_RESULTS,
	SHOP_TOP_COUNT,
	STAFF_ALERT_MAX_RECIPIENTS,
	STAFF_ATTACHMENT_MAX_BYTES,
	STAFF_ATTACHMENT_TYPES,
	VISITOR_ALERT_AWAY_SECONDS,
} from '../core/limits.js';
import { CHECKS } from '../core/widgets.js';

describe('fixed limits', () => {
	it('keep the defaults of the settings they replaced', () => {
		expect([AI_COST_ALERT_PERCENT, AI_TEMPERATURE, AI_MAX_OUTPUT_TOKENS]).toEqual([80, 0.4, 500]);
		expect([AI_REPLIES_PER_VISITOR_PER_DAY, AI_REPLIES_PER_NETWORK_PER_DAY]).toEqual([40, 60]);
		expect([GUEST_REMEMBER_DAYS, PROACTIVE_DISMISS_DAYS, VISITOR_ALERT_AWAY_SECONDS]).toEqual([90, 7, 60]);
		expect([CONTEXT_PANEL_ORDERS, SHOP_CONTEXT_MAX_CHARACTERS]).toEqual([5, 6000]);
		expect([SHOP_DEALS_COUNT, SHOP_MY_ORDERS_COUNT, SHOP_SEARCH_MAX_RESULTS, SHOP_TOP_COUNT]).toEqual([10, 5, 5, 5]);
		expect(STAFF_ALERT_MAX_RECIPIENTS).toBe(20);
		expect(STAFF_ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
		expect(STAFF_ATTACHMENT_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
		expect(LANGUAGE_MIN_MARKERS).toBe(2);
		// the widget's check intervals: 10 s while the chat is open, 5 minutes while it is closed
		expect([CHECKS.activeMs, CHECKS.closedEveryMs]).toEqual([10_000, 300_000]);
	});

	it('the limits that were switched off or optional are now on, with generous values', () => {
		// new guests per network were not limited, and the wait before the AI reassures was off (0)
		expect(NEW_GUESTS_PER_NETWORK).toBeGreaterThanOrEqual(60);
		expect(REASSURE_AFTER_MINUTES).toBeGreaterThan(0);
	});

	it('no settings schema offers a removed limit', () => {
		const folder = new URL('../schemas/', import.meta.url);
		const removed = [
			'alertPercent',
			'temperature',
			'maxOutputTokens',
			'repliesPerVisitorPerDay',
			'repliesPerNetworkPerDay',
			'botPhrases',
			'staffTypes',
			'staffMaxSizeMb',
			'pdfInline',
			'orders',
			'noLimitWithoutSignIn',
			'rememberDays',
			'newGuestsPerNetwork',
			'reassureAfterMinutes',
			'minMarkers',
			'markerShare',
			'minWordsForShare',
			'strict',
			'checkMode',
			'maxCharacters',
			'count',
			'maxResults',
			'maxRecipients',
			'awaySeconds',
			'proactiveDismissDays',
			'pollFocusedSeconds',
			'pollBackgroundSeconds',
		];
		const offered = [];
		for (const file of readdirSync(folder).filter((name) => /\.(settings|shared)\.json$/.test(name)))
			for (const key of Object.keys(JSON.parse(readFileSync(new URL(file, folder), 'utf8')).properties))
				if (removed.includes(key)) offered.push(`${file}: ${key}`);
		expect(offered).toEqual([]);
	});
});
