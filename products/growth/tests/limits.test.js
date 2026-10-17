/**
 * The fixed limits of Growth (core/limits.js) keep the old defaults of the settings they replaced, and no settings
 * schema offers them any more.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEO_LIMITS } from '../core/limits.js';

describe('fixed limits', () => {
	it('seo_checklist.titleMin / titleMax / descriptionMin / descriptionMax were 10 / 60 / 50 / 160', () => {
		expect(SEO_LIMITS).toEqual({ titleMin: 10, titleMax: 60, descriptionMin: 50, descriptionMax: 160 });
	});

	it('no settings schema offers a removed limit (pixels.searchFromUrl was on: a search in the page address always goes to the pixels)', () => {
		const folder = new URL('../schemas/', import.meta.url);
		const removed = ['titleMin', 'titleMax', 'descriptionMin', 'descriptionMax', 'searchFromUrl'];
		const offered = [];
		for (const file of readdirSync(folder).filter((name) => /\.(settings|shared)\.json$/.test(name)))
			for (const key of Object.keys(JSON.parse(readFileSync(new URL(file, folder), 'utf8')).properties))
				if (removed.includes(key)) offered.push(`${file}: ${key}`);
		expect(offered).toEqual([]);
	});

	it('the IndexNow key stays a setting, with a Generate button for a new key of the right shape', () => {
		const schema = JSON.parse(readFileSync(new URL('../schemas/indexnow.settings.json', import.meta.url), 'utf8'));
		expect(schema.properties.key['x-ui'].generate).toBeGreaterThanOrEqual(8);
		expect(schema.properties.key['x-ui'].generate).toBeLessThanOrEqual(schema.properties.key.maxLength);
	});
});
