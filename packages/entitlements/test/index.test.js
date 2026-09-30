import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('public API', () => {
	it('exports the documented functions and constants', () => {
		for (const name of [
			'normaliseProduct',
			'elementDependencies',
			'planDefaults',
			'resolveEntitlement',
			'periodBounds',
			'quotaState',
			'overageCharge',
			'planSettlement',
			'planMeteredSettlement',
			'nextCursor',
			'reconcile',
			'balanceAfter',
			'hoursRemaining',
			'projectedMonth',
			'spendCapState',
			'spendCapDecision',
			'toMillicredits',
		]) {
			expect(typeof api[/** @type {keyof typeof api} */ (name)]).toBe('function');
		}
		expect(api.MILLICREDITS_PER_CREDIT).toBe(1000);
		expect(api.LAYERS).toEqual(['product', 'plan', 'platform', 'merchant', 'website', 'admin']);
	});
});
