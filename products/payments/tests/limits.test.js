/**
 * The fixed limits of Payments (core/limits.js) keep the old default of the setting they replaced, and no settings
 * schema offers them any more.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_CHECKOUT_MINUTES, PROOF_MAX_MB } from '../core/limits.js';

describe('fixed limits', () => {
	it('manual_payments.proofMaxMb was 5 MB; a gateway checkout stays open at least 30 minutes', () => {
		expect(PROOF_MAX_MB).toBe(5);
		expect(MIN_CHECKOUT_MINUTES).toBe(30);
	});

	it('no settings schema offers the largest proof', () => {
		const folder = new URL('../schemas/', import.meta.url);
		const offered = readdirSync(folder)
			.filter((name) => name.endsWith('.settings.json'))
			.filter((name) => 'proofMaxMb' in JSON.parse(readFileSync(new URL(name, folder), 'utf8')).properties);
		expect(offered).toEqual([]);
	});
});
