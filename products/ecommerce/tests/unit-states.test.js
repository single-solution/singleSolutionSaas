/** Unit states (E38): in_stock and sold are fixed; the merchant names the others (seeded: faulty). */
import { describe, expect, it } from 'vitest';
import { DEFAULT_UNIT_STATES, FIXED_UNIT_STATES, checkUnitStates, unitStatusOf } from '../core/unit-states.js';

describe('unit states', () => {
	it('keeps in_stock and sold fixed and seeds faulty', () => {
		expect(FIXED_UNIT_STATES).toEqual(['in_stock', 'sold']);
		expect(DEFAULT_UNIT_STATES).toEqual([{ key: 'faulty', label: 'Faulty' }]);
	});

	it('checks the merchant list', () => {
		expect(checkUnitStates([{ key: 'demo', label: ' Demo unit ' }])).toEqual({
			ok: true,
			value: [{ key: 'demo', label: 'Demo unit' }],
		});
		expect(checkUnitStates([]).ok).toBe(true);
		expect(checkUnitStates([{ key: 'sold', label: 'Sold' }]).ok).toBe(false);
		expect(checkUnitStates([{ key: 'Demo!', label: 'Demo' }]).ok).toBe(false);
		expect(checkUnitStates([{ key: 'demo', label: '' }]).ok).toBe(false);
		expect(
			checkUnitStates([
				{ key: 'demo', label: 'A' },
				{ key: 'demo', label: 'B' },
			]).ok,
		).toBe(false);
		expect(checkUnitStates(Array.from({ length: 21 }, (_, n) => ({ key: `s${n}`, label: `S${n}` }))).ok).toBe(false);
	});

	it('reads a status staff may set: in stock or one of the list', () => {
		const states = [{ key: 'demo', label: 'Demo' }];
		expect(unitStatusOf('in_stock', states)).toBe('in_stock');
		expect(unitStatusOf('demo', states)).toBe('demo');
		expect(unitStatusOf('sold', states)).toBeNull();
		expect(unitStatusOf('faulty', states)).toBeNull();
	});
});
