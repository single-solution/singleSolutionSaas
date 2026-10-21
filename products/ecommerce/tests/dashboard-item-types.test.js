// @vitest-environment jsdom
/**
 * The item types editor in the browser (jsdom) on a faked dashboard API (PLAN 0.8.10 dynamic model §1): it lists the
 * saved types with their kind and parts as rows, adds a type in its drawer (name, kind, parts of its kind, numbered units with
 * their unit fields, the step they are needed before, the fields it names) and edits one, and saves the whole list
 * with one PUT that the server's check takes.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, keydown, render, type } from '@ss/ui/testing';
import { ItemTypesEditor } from '../app/dashboard/item-types.js';
import { blankType, cleanType, loadType, typeProblems } from '../app/dashboard/drafts.js';
import { checkItemTypes } from '../core/item-types.js';
import { drawerOf, factsOf, inDashboard, openRow, rowMenu, rowNames, rowOf } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const PATH = `/v1/dashboard/websites/${WEBSITE}/lists/item_types`;

/** The lists the editor saved. @type {any[]} */
let saved = [];

/** The saved list: one e-book type. */
const START = [
	{
		key: 'ebook',
		name: 'E-book',
		kind: 'digital',
		active: false,
		elements: {
			variants: false,
			grades: false,
			units: null,
			chart: false,
			measure: null,
			quantity: null,
			parcel: false,
			warranty: false,
			downloads: true,
			licenseKeys: false,
			slots: false,
		},
		fieldIds: null,
	},
];

/** The dashboard API: the saved list, and a save checked as the server checks it. */
const serve = () => {
	saved = [];
	/** @type {any} */
	let list = structuredClone(START);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			if (path !== PATH) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
			if (init.method === 'PUT') {
				const { value } = JSON.parse(String(init.body));
				saved.push(value);
				const checked = checkItemTypes(value);
				if (!checked.ok) return new Response(JSON.stringify({ status: 422, errors: checked.errors }), { status: 422 });
				list = checked.value;
			}
			return new Response(JSON.stringify({ value: list }), { status: 200 });
		}),
	);
};

/** Let the loads answer. */
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('item type drafts', () => {
	it('load and clean a measure typed in units, check its step, least and most, and leave out numbered units with it', () => {
		const start = /** @type {any} */ (START[0]);
		const fabric = {
			...start,
			key: 'fabric',
			name: 'Fabric',
			kind: 'physical',
			active: true,
			elements: {
				...start.elements,
				downloads: false,
				measure: { unit: 'sq ft', decimals: 1, step: 500, min: 1000, max: null, standard: { code: 'FTK', amount: 1 } },
			},
		};
		const loaded = loadType(/** @type {any} */ (fabric));
		expect(loaded.measure).toEqual({
			on: true,
			unit: 'sq ft',
			decimals: '1',
			step: '0.5',
			min: '1',
			max: '',
			standardCode: 'FTK',
			standardAmount: '1',
		});
		expect(cleanType(loaded)).toEqual(fabric);
		const draft = {
			...loaded,
			units: { on: true, fieldIds: [], capture: /** @type {const} */ ('packing'), requiredBefore: /** @type {const} */ ('') },
		};
		expect(cleanType(draft).elements).toMatchObject({ units: null, measure: { step: 500, min: 1000, max: null } });
		expect(cleanType({ ...loaded, measure: { ...loaded.measure, max: '20' } }).elements.measure?.max).toBe(20_000);
		/** @param {Partial<typeof loaded.measure>} measure */
		const problem = (measure) => typeProblems({ ...loaded, measure: { ...loaded.measure, ...measure } }, []).measure;
		expect(problem({})).toBeUndefined();
		expect(problem({ step: '0' })).toBe('step');
		expect(problem({ step: '0.0005' })).toBe('step');
		expect(problem({ min: '1.2' })).toBe('min');
		expect(problem({ max: '0.5' })).toBe('max');
		expect(problem({ max: '7.25' })).toBe('max');
		// the unit is the merchant's own label; with no decimals a step is whole units; a standard needs an amount
		expect(problem({ unit: ' ' })).toBe('unit');
		expect(problem({ unit: 'dozen', decimals: '0', step: '1', min: '1' })).toBeUndefined();
		expect(problem({ decimals: '0' })).toBe('step');
		expect(problem({ standardAmount: '0' })).toBe('standard');
		expect(problem({ standardCode: '', standardAmount: 'x' })).toBeUndefined();
		expect(cleanType({ ...loaded, measure: { ...loaded.measure, standardCode: '' } }).elements.measure?.standard).toBeNull();
		expect(typeProblems({ ...loaded, measure: { ...loaded.measure, on: false, step: 'x' } }, []).measure).toBeUndefined();
		expect(blankType().measure.on).toBe(false);
	});

	it('load and clean a quantity rule in whole pieces (E4), none with a measure', () => {
		const cases = { ...blankType(), name: 'Cases', quantity: { step: '6', min: '12', max: '600' } };
		expect(cleanType(cases).elements.quantity).toEqual({ step: 6, min: 12, max: 600 });
		expect(cleanType({ ...cases, quantity: { step: '1', min: '1', max: '' } }).elements.quantity).toBeNull();
		expect(cleanType({ ...cases, quantity: { step: '6', min: '6', max: '' } }).elements.quantity).toEqual({
			step: 6,
			min: 6,
			max: null,
		});
		expect(loadType(/** @type {any} */ (checkItemTypes([cleanType(cases)]).ok && cleanType(cases))).quantity).toEqual({
			step: '6',
			min: '12',
			max: '600',
		});
		/** @param {Partial<typeof cases.quantity>} quantity */
		const problem = (quantity) => typeProblems({ ...cases, quantity: { ...cases.quantity, ...quantity } }, []).quantity;
		expect(problem({})).toBeUndefined();
		expect(problem({ step: '0' })).toBe('step');
		expect(problem({ min: '13' })).toBe('min');
		expect(problem({ max: '601' })).toBe('max');
		expect(problem({ max: '6' })).toBe('max');
		const cloth = { ...cases, measure: { ...blankType().measure, on: true, unit: 'm' } };
		expect(cleanType(cloth).elements.quantity).toBeNull();
		expect(typeProblems({ ...cloth, quantity: { step: 'x', min: '', max: '' } }, []).quantity).toBeUndefined();
	});

	it('load and clean every field, keep only the parts of the kind, and key a type from its name', () => {
		const loaded = loadType(/** @type {any} */ (START[0]));
		expect(loaded).toMatchObject({ key: 'ebook', kind: 'digital', active: false, fieldsNamed: false });
		expect(cleanType(loaded)).toEqual(START[0]);
		const draft = { ...blankType(), name: 'Used phone', fieldsNamed: true, fieldIds: [' att_1 ', ''] };
		draft.elements = { ...draft.elements, grades: true, downloads: true };
		draft.units = { on: true, fieldIds: ['att_imei'], capture: 'packing', requiredBefore: '' };
		expect(cleanType(draft)).toMatchObject({
			key: 'used_phone',
			elements: {
				grades: true,
				downloads: false,
				units: { fieldIds: ['att_imei'], capture: 'packing', requiredBefore: null },
			},
			fieldIds: ['att_1'],
		});
		// units picked from stock are needed when packed; a digital type has none
		expect(cleanType({ ...draft, units: { ...draft.units, capture: 'stock' } }).elements.units).toMatchObject({
			requiredBefore: 'packed',
		});
		expect(cleanType({ ...draft, kind: 'digital' }).elements.units).toBeNull();
		expect(typeProblems(blankType(), [])).toEqual({ name: 'missing' });
		expect(typeProblems({ ...blankType(), name: 'Phone', key: 'physical' }, [])).toEqual({ key: 'built_in' });
		expect(typeProblems({ ...blankType(), name: 'Phone' }, ['phone'])).toEqual({ key: 'taken' });
		expect(typeProblems({ ...blankType(), name: 'Phone', key: '9x' }, [])).toEqual({ key: 'invalid' });
	});
});

describe('the item types editor', () => {
	it('lists the types, adds one in its drawer and saves the list the server takes', async () => {
		serve();
		const { container } = render(inDashboard(<ItemTypesEditor websiteId={WEBSITE} />));
		await settle();
		expect(rowNames(container)).toEqual(['E-book']);
		const facts = factsOf(rowOf(container, 'E-book'));
		expect(facts.meta).toContain('Digital goods');
		expect(facts.meta).toContain('Downloads');
		expect(facts.status).toBe('Not offered');
		await act(async () => click(byText(container, 'Add item type', 'button')));
		const dialog = document.body;
		// Done refuses a type without a name
		await act(async () => click(byText(dialog, 'Done', 'button')));
		expect(dialog.textContent).toContain('Give the type a name.');
		type(byLabel(dialog, 'Name'), 'Used phone');
		// a service has no package; a physical type has numbered units
		type(byLabel(dialog, 'Kind'), 'service');
		expect(() => byLabel(dialog, 'Package weight and size')).toThrow();
		expect(() => byLabel(dialog, 'Numbered units')).toThrow();
		type(byLabel(dialog, 'Kind'), 'physical');
		await act(async () => click(byLabel(dialog, 'Options and variants')));
		await act(async () => click(byLabel(dialog, 'Condition grades')));
		await act(async () => click(byLabel(dialog, 'Numbered units')));
		type(byLabel(dialog, 'Numbers come'), 'packing');
		type(byLabel(dialog, 'Needed before'), 'shipped');
		type(byLabel(dialog, 'Unit fields'), 'att_imei');
		keydown(byLabel(dialog, 'Unit fields'), 'Enter');
		await act(async () => click(byLabel(dialog, 'Only the fields named here')));
		type(byLabel(dialog, 'Product and variant fields'), 'att_battery, att_color,');
		await act(async () => click(byText(dialog, 'Done', 'button')));
		expect(container.textContent).toContain('Used phone');
		expect(container.textContent).toContain('You have unsaved changes');
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved).toHaveLength(1);
		expect(saved[0][1]).toEqual({
			key: 'used_phone',
			name: 'Used phone',
			kind: 'physical',
			active: true,
			elements: {
				variants: true,
				grades: true,
				chart: false,
				measure: null,
				quantity: null,
				parcel: false,
				warranty: false,
				downloads: false,
				licenseKeys: false,
				slots: false,
				units: { fieldIds: ['att_imei'], capture: 'packing', requiredBefore: 'shipped' },
			},
			fieldIds: ['att_battery', 'att_color'],
		});
		expect(checkItemTypes(saved[0]).ok).toBe(true);
		expect(container.textContent).not.toContain('You have unsaved changes');
	});

	it('edits a type from its row and moves or removes types from the row menu', async () => {
		serve();
		const { container } = render(inDashboard(<ItemTypesEditor websiteId={WEBSITE} />));
		await settle();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		const drawer = await openRow(container, 'E-book');
		expect(drawer.querySelector('h2')?.textContent).toBe('Edit E-book');
		type(byLabel(drawer, 'Name'), 'E-book and PDF');
		await act(async () => click(byText(drawer, 'Done', 'button')));
		expect(drawerOf()).toBeNull();
		expect(rowNames(container)).toEqual(['E-book and PDF']);
		// a second type, then the order changes and one goes
		await act(async () => click(byText(container, 'Add item type', 'button')));
		type(byLabel(drawerOf(), 'Name'), 'Course');
		await act(async () => click(byText(drawerOf(), 'Done', 'button')));
		expect(rowNames(container)).toEqual(['E-book and PDF', 'Course']);
		await rowMenu(container, 'Course', 'Move up');
		expect(rowNames(container)).toEqual(['Course', 'E-book and PDF']);
		await rowMenu(container, 'E-book and PDF', 'Remove');
		expect(rowNames(container)).toEqual(['Course']);
		await act(async () => click(byText(container, 'Save list', 'button')));
		await settle();
		expect(saved).toHaveLength(1);
		expect(saved[0].map((/** @type {{ key: string }} */ type) => type.key)).toEqual(['course']);
	});

	it('leaves the card title out when the page says it already', async () => {
		serve();
		const titled = render(inDashboard(<ItemTypesEditor websiteId={WEBSITE} />));
		await settle();
		expect(titled.container.querySelector('h2')?.textContent).toBe('Item types');
		cleanup();
		serve();
		const bare = render(inDashboard(<ItemTypesEditor websiteId={WEBSITE} bare />));
		await settle();
		expect(bare.container.querySelector('h2')).toBeNull();
		expect(byText(bare.container, 'Add item type', 'button')).toBeTruthy();
	});
});
