/**
 * The fixed limits of Notifications (core/limits.js) keep the old defaults of the settings they replaced, and no
 * settings schema offers them any more.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	MAX_DELAY_DAYS,
	MAX_TEMPLATES,
	MAX_VISITOR_SUBSCRIPTIONS,
	MAX_WEBHOOK_URLS,
	RETRY_WAITS,
	VISITOR_SUBSCRIPTION_DAYS,
	WEBHOOK_RETRY_WAITS,
} from '../core/limits.js';

const MIN = 60_000;

describe('fixed limits', () => {
	it('keep the old defaults', () => {
		// <channel>.retryPlan was short and retryWaits [1, 5], for email, sms, whatsapp, browser_push and staff_push
		expect(RETRY_WAITS).toEqual([MIN, 5 * MIN]);
		// webhooks.retryPlan was standard
		expect(WEBHOOK_RETRY_WAITS).toEqual([MIN, 5 * MIN, 30 * MIN, 120 * MIN]);
		expect(MAX_DELAY_DAYS).toBe(30); // delayed_send.maxDelayDays
		expect(MAX_TEMPLATES).toBe(1000); // templates.maxTemplates
		expect(MAX_WEBHOOK_URLS).toBe(5); // webhooks.maxUrls
	});

	it('hold safety ceilings that real use does not reach (SR-7-1)', () => {
		expect(MAX_VISITOR_SUBSCRIPTIONS).toBe(50_000);
		expect(VISITOR_SUBSCRIPTION_DAYS).toBe(365);
	});

	it('no settings schema offers a removed limit', () => {
		const folder = new URL('../schemas/', import.meta.url);
		const removed = ['retryPlan', 'retryWaits', 'maxDelayDays', 'maxTemplates', 'maxUrls'];
		const files = readdirSync(folder).filter((name) => /\.(settings|shared)\.json$/.test(name));
		expect(files).not.toContain('templates.shared.json');
		const offered = [];
		for (const file of files)
			for (const key of Object.keys(JSON.parse(readFileSync(new URL(file, folder), 'utf8')).properties))
				if (removed.includes(key)) offered.push(`${file}: ${key}`);
		expect(offered).toEqual([]);
	});
});
