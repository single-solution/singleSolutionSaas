// @vitest-environment jsdom
/**
 * The item types editor in the browser (jsdom) on a faked dashboard API (PLAN 0.8.10 dynamic model §1): it lists the
 * saved types with their kind and parts, adds a type in its dialog (name, kind, parts of its kind, numbered units with
 * their unit fields, the step they are needed before, the fields it names) and edits one, and saves the whole list
 * with one PUT that the server's check takes.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, keydown, render, type } from '@ss/ui/testing';
import { ItemTypesEditor } from '../app/dashboard/item-types.js';
import { blankType, cleanType, loadType, typeProblems } from '../app/dashboard/drafts.js';
import { checkItemTypes } from '../core/item-types.js';

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
			parcel: false,
			warranty: false,
			downloads: true,
			licenceKeys: false,
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
	it('lists the types, adds one in its dialog and saves the list the server takes', async () => {
		serve();
		const { container } = render(<ItemTypesEditor websiteId={WEBSITE} />);
		await settle();
		expect(container.textContent).toContain('E-book');
		expect(container.textContent).toContain('Not offered');
		expect(container.textContent).toContain('Downloads');
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
		expect(container.textContent).toContain('Changes not saved yet');
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
				parcel: false,
				warranty: false,
				downloads: false,
				licenceKeys: false,
				slots: false,
				units: { fieldIds: ['att_imei'], capture: 'packing', requiredBefore: 'shipped' },
			},
			fieldIds: ['att_battery', 'att_color'],
		});
		expect(checkItemTypes(saved[0]).ok).toBe(true);
		expect(container.textContent).not.toContain('Changes not saved yet');
	});
});
