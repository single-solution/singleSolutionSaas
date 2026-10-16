// @vitest-environment jsdom
/* global document */
/**
 * Measurement tables (PLAN 0.8.10 dynamic model phase 6, §6): any unit or an own label (no default), a unit per column,
 * a switch to another unit only within one dimension with the exact factors, `advice`.
 */
import { describe, expect, it } from 'vitest';
import { checkSizeChart, chartView } from '../core/size-charts.js';
import { UNITS, convertAmount, sameDimension } from '../core/units.js';
import { convertCell, sizeGuide } from '../ui/shop-page-parts.js';
import TEXTS from '../strings/en.json' with { type: 'json' };

/** The widget's words. @param {string} key @param {Record<string, string | number>} [values] */
const t = (key, values = {}) =>
	String(/** @type {Record<string, string>} */ (TEXTS)[key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
		String(values[name] ?? ''),
	);

describe('units', () => {
	it('converts exactly within one dimension and never between dimensions', () => {
		expect(convertAmount(1, 'in', 'mm')).toBe(25.4);
		expect(convertAmount(1, 'in', 'cm')).toBe(2.54);
		expect(convertAmount(1, 'ft', 'mm')).toBe(304.8);
		expect(convertAmount(3, 'ft', 'yd')).toBe(1);
		expect(convertAmount(1, 'lb', 'g')).toBe(453.59237);
		expect(convertAmount(16, 'oz', 'lb')).toBe(1);
		expect(convertAmount(1, 'oz', 'g')).toBe(28.349523125);
		expect(convertAmount(2.5, 'l', 'ml')).toBe(2500);
		expect(convertAmount(101.6, 'cm', 'in')).toBe(40);
		expect(convertAmount(1, 'kg', 'cm')).toBe(null);
		expect(convertAmount(1, 'ml', 'g')).toBe(null);
		expect(convertAmount(1, 'EU', 'cm')).toBe(null);
		expect(sameDimension('mm', 'yd')).toBe(true);
		expect(sameDimension('lb', 'l')).toBe(false);
		expect(Object.keys(UNITS)).toEqual(['mm', 'cm', 'm', 'in', 'ft', 'yd', 'g', 'kg', 'lb', 'oz', 'ml', 'l']);
	});
});

describe('measurement tables', () => {
	const columns = [{ key: 'chest', label: 'Chest' }];

	it('has no default unit, takes any unit or an own label, and a unit per column', () => {
		const plain = checkSizeChart({ name: 'Shoes', columns: [{ key: 'eu', label: 'EU' }] }, null);
		expect(plain).toMatchObject({
			ok: true,
			value: { unit: '', convertTo: '', columns: [{ key: 'eu', label: 'EU', unit: '' }] },
		});
		const own = checkSizeChart({ name: 'Kids', unit: 'years', columns }, null);
		expect(own).toMatchObject({ ok: true, value: { unit: 'years' } });
		const mixed = checkSizeChart(
			{
				name: 'Bags',
				unit: 'cm',
				columns: [
					{ key: 'width', label: 'Width' },
					{ key: 'weight', label: 'Weight', unit: 'kg' },
					{ key: 'volume', label: 'Volume', unit: 'l' },
				],
				convertTo: 'in',
				advice: 'Measure the opening.',
			},
			null,
		);
		expect(mixed).toMatchObject({
			ok: true,
			value: {
				unit: 'cm',
				convertTo: 'in',
				columns: [
					{ key: 'width', unit: '' },
					{ key: 'weight', unit: 'kg' },
					{ key: 'volume', unit: 'l' },
				],
				advice: 'Measure the opening.',
			},
		});
		expect(mixed.ok && 'fitAdvice' in mixed.value).toBe(false);
		expect(checkSizeChart({ name: 'C', unit: 'x'.repeat(21), columns }, null)).toMatchObject({
			ok: false,
			errors: [{ path: '/unit' }],
		});
		expect(checkSizeChart({ name: 'C', columns: [{ key: 'a', label: 'A', unit: 5 }] }, null)).toMatchObject({
			ok: false,
			errors: [{ path: '/columns/0/unit' }],
		});
	});

	it('switches only to a unit of a dimension the table uses', () => {
		expect(checkSizeChart({ name: 'C', unit: 'kg', columns, convertTo: 'lb' }, null).ok).toBe(true);
		expect(checkSizeChart({ name: 'C', columns: [{ key: 'w', label: 'W', unit: 'oz' }], convertTo: 'g' }, null).ok).toBe(true);
		for (const wrong of [
			{ unit: 'cm', convertTo: 'lb' },
			{ unit: 'cm', convertTo: 'cm' },
			{ unit: 'EU', convertTo: 'cm' },
			{ unit: '', convertTo: 'in' },
			{ unit: 'cm', convertTo: 'inch' },
		])
			expect(checkSizeChart({ name: 'C', columns, ...wrong }, null)).toMatchObject({
				ok: false,
				errors: [{ path: '/convertTo' }],
			});
		// a change of the unit is checked against the switch kept
		const existing = /** @type {any} */ ({
			id: 'szc_1',
			.../** @type {any} */ (checkSizeChart({ name: 'C', unit: 'cm', columns, convertTo: 'in' }, null)).value,
		});
		expect(checkSizeChart({ unit: 'kg' }, existing)).toMatchObject({ ok: false, errors: [{ path: '/convertTo' }] });
		expect(checkSizeChart({ unit: 'kg', convertTo: 'lb' }, existing).ok).toBe(true);
		expect(chartView(existing)).toEqual({
			id: 'szc_1',
			name: 'C',
			unit: 'cm',
			convertTo: 'in',
			columns: [{ key: 'chest', label: 'Chest', unit: '' }],
			rows: [],
			advice: '',
			notes: '',
		});
	});

	it('converts table cells with the exact factors, never between dimensions', () => {
		expect(convertCell('40', 'in', 'cm')).toBe('101.6');
		expect(convertCell('101.6', 'cm', 'in')).toBe('40');
		expect(convertCell('30 – 32', 'in', 'cm')).toBe('76.2–81.3');
		expect(convertCell('2,5', 'kg', 'lb')).toBe('5.51');
		expect(convertCell('16', 'oz', 'g')).toBe('453.6');
		expect(convertCell('XL', 'in', 'cm')).toBe('XL');
		expect(convertCell('40', 'cm', 'cm')).toBe('40');
		expect(convertCell('40', 'kg', 'cm')).toBe('40');
		expect(convertCell('40', 'EU', 'cm')).toBe('40');
	});
});

describe('the Size guide', () => {
	/** @param {any} chart */
	const open = (chart) => {
		const layer = document.createElement('div');
		document.body.replaceChildren(layer);
		sizeGuide({ doc: document, t, chart, layer }).click();
		const heads = () => [...layer.querySelectorAll('thead th')].map((th) => th.textContent);
		const cells = () => [...layer.querySelectorAll('tbody td')].map((td) => td.textContent);
		const press = (/** @type {string} */ label) =>
			/** @type {HTMLButtonElement} */ ([...layer.querySelectorAll('button')].find((b) => b.textContent === label)).click();
		return { layer, heads, cells, press };
	};
	const base = {
		name: 'Bags',
		rows: [{ size: 'M', label: 'M', values: { width: '40', weight: '2', note: 'Soft' } }],
		notes: '',
	};

	it('names each column’s own unit and switches only the columns of the target dimension', () => {
		const guide = open({
			...base,
			unit: 'cm',
			convertTo: 'in',
			columns: [
				{ key: 'width', label: 'Width', unit: '' },
				{ key: 'weight', label: 'Weight', unit: 'kg' },
				{ key: 'note', label: 'Note', unit: '' },
			],
			advice: 'Pack light.',
		});
		expect(guide.heads()).toEqual(['Size', 'Width', 'Weight (kg)', 'Note']);
		expect(guide.cells()).toEqual(['40', '2', 'Soft']);
		expect([...guide.layer.querySelectorAll('[data-unit]')].map((b) => b.textContent)).toEqual(['cm', 'in']);
		guide.press('in');
		expect(guide.heads()).toEqual(['Size', 'Width (in)', 'Weight (kg)', 'Note (in)']);
		expect(guide.cells()).toEqual(['15.7', '2', 'Soft']);
		expect(guide.layer.textContent).toContain('Pack light.');
		guide.press('cm');
		expect(guide.cells()).toEqual(['40', '2', 'Soft']);
	});

	it('shows an own label or a unit without a switch, and nothing without a unit', () => {
		const labeled = open({
			...base,
			unit: 'EU',
			convertTo: '',
			columns: [{ key: 'width', label: 'Width', unit: '' }],
			advice: '',
		});
		expect(labeled.layer.querySelector('[data-unit]')).toBeNull();
		expect(labeled.layer.querySelector('p.meta')?.textContent).toBe('Measurements in EU');
		const plain = open({ ...base, unit: '', convertTo: '', columns: [{ key: 'width', label: 'Width', unit: '' }], advice: '' });
		expect(plain.layer.querySelector('p.meta')).toBeNull();
		expect(plain.heads()).toEqual(['Size', 'Width']);
	});
});
