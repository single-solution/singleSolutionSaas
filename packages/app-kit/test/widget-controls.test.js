// @vitest-environment jsdom
/* global document */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ADMIN_KIT_CSS,
	CONTROLS_CSS,
	affix,
	block,
	checkbox,
	choiceGroup,
	field,
	fieldError,
	radio,
	settingRow,
	toggle,
} from '../src/widget.js';

afterEach(() => document.body.replaceChildren());

/** @param {Node} node */
const mount = (node) => {
	document.body.append(node);
	return node;
};

describe('toggle', () => {
	it('is a native checkbox with role switch inside a setting row, its label and help linked', () => {
		const onChange = vi.fn();
		const { box, node } = toggle(document, 'Show prices', { help: 'Visitors see them', checked: true, onChange });
		mount(node);
		expect(box.type).toBe('checkbox');
		expect(box.getAttribute('role')).toBe('switch');
		expect(box.checked).toBe(true);
		expect(node.className).toBe('setting');
		expect(node.querySelector('label')?.getAttribute('for')).toBe(box.id);
		expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Visitors see them');
		box.click();
		expect(box.checked).toBe(false);
		expect(onChange).toHaveBeenCalledWith(false);
	});

	it('is a native checkbox for the keyboard: it takes focus, and a press on its label toggles it', () => {
		const { box, node } = toggle(document, 'Active', { inline: true });
		mount(node);
		box.focus();
		expect(document.activeElement).toBe(box);
		expect(box.tabIndex).toBe(0);
		expect(node.className).toBe('switch');
		/** @type {HTMLElement} */ (node).click();
		expect(box.checked).toBe(true);
	});

	it('keeps help and a disabled state on an inline switch', () => {
		const { box, node } = toggle(document, 'Beta', { inline: true, help: 'Not final', disabled: true });
		mount(node);
		expect(node.className).toBe('opt');
		expect(box.disabled).toBe(true);
		expect(node.querySelector('.help')?.id).toBe(box.getAttribute('aria-describedby'));
	});

	it('takes an element as its label', () => {
		const link = document.createElement('a');
		link.textContent = 'terms';
		const { node } = toggle(document, link, { inline: true });
		expect(node.querySelector('a')?.textContent).toBe('terms');
	});
});

describe('checkbox and radio', () => {
	it('a checkbox has its text as its label and can be indeterminate', () => {
		const { box, node } = checkbox(document, 'Select all', { indeterminate: true, name: 'all', value: 'x' });
		mount(node);
		expect(box.indeterminate).toBe(true);
		expect(box.name).toBe('all');
		expect(box.value).toBe('x');
		expect(node.tagName).toBe('LABEL');
		expect(node.textContent).toBe('Select all');
		box.click();
		expect(box.indeterminate).toBe(false);
		expect(box.checked).toBe(true);
	});

	it('a checkbox with help is a wrapper linking the line to the input', () => {
		const { box, node } = checkbox(document, 'Remember me', { help: 'On this device', checked: true });
		mount(node);
		expect(node.className).toBe('opt');
		expect(node.querySelector('label')?.textContent).toBe('Remember me');
		expect(node.querySelector('.help')?.id).toBe(box.getAttribute('aria-describedby'));
		expect(box.checked).toBe(true);
	});

	it('radios with one name are one group', () => {
		const a = radio(document, 'Pickup', { name: 'way', value: 'pickup', checked: true });
		const b = radio(document, 'Delivery', { name: 'way', value: 'delivery' });
		mount(a.node);
		mount(b.node);
		b.box.click();
		expect(a.box.checked).toBe(false);
		expect(b.box.checked).toBe(true);
		expect(b.box.type).toBe('radio');
	});
});

describe('choiceGroup', () => {
	const items = [
		{ value: 'a', label: 'Alpha', help: 'First' },
		{ value: 'b', label: 'Beta' },
		{ value: 'c', label: 'Gamma', disabled: true },
	];

	it('a segmented control is a labeled radio group of native radios', () => {
		const onChange = vi.fn();
		const group = choiceGroup(document, { label: 'Size', name: 'size', items, value: 'a', look: 'segmented', onChange });
		mount(group.node);
		expect(group.node.getAttribute('role')).toBe('radiogroup');
		expect(group.node.getAttribute('aria-label')).toBe('Size');
		expect(group.node.className).toBe('segmented');
		expect(group.inputs.map((each) => each.type)).toEqual(['radio', 'radio', 'radio']);
		expect(group.value).toBe('a');
		group.inputs[1]?.click();
		expect(group.value).toBe('b');
		expect(onChange).toHaveBeenCalledWith('b');
		expect(group.inputs[2]?.disabled).toBe(true);
		expect(group.node.querySelector('label')?.textContent).toBe('Alpha');
	});

	it('cards carry a title and a line, and the value can be set', () => {
		const group = choiceGroup(document, { label: 'Plan', name: 'plan', items, look: 'card' });
		mount(group.node);
		expect(group.node.className).toBe('choices');
		expect(group.value).toBe('');
		group.value = 'b';
		expect(group.inputs[1]?.checked).toBe(true);
		expect(group.node.querySelector('.choice b')?.textContent).toBe('Alpha');
		expect(group.node.querySelector('.choice .help')?.textContent).toBe('First');
	});

	it('a multiple group is checkboxes and reads and sets an array', () => {
		const onChange = vi.fn();
		const group = choiceGroup(document, {
			label: 'Days',
			name: 'days',
			items,
			multiple: true,
			value: ['a'],
			onChange,
		});
		mount(group.node);
		expect(group.node.getAttribute('role')).toBe('group');
		expect(group.inputs[0]?.type).toBe('checkbox');
		expect(group.value).toEqual(['a']);
		group.inputs[1]?.click();
		expect(onChange).toHaveBeenCalledWith(['a', 'b']);
		group.value = ['b'];
		expect(group.value).toEqual(['b']);
		group.value = 'a';
		expect(group.value).toEqual(['a']);
	});

	it('the plain look is a list of checks with their help', () => {
		const group = choiceGroup(document, { label: 'Way', name: 'way', items: items.slice(0, 2), value: 'b' });
		mount(group.node);
		expect(group.node.className).toBe('opts');
		expect(group.node.querySelectorAll('.check')).toHaveLength(2);
		expect(group.node.querySelector('.help')?.textContent).toBe('First');
		expect(group.value).toBe('b');
	});
});

describe('field and affix', () => {
	it('links the label, the hint and the control', () => {
		const input = document.createElement('input');
		const node = field(document, 'Price', input, { hint: 'Without tax' });
		mount(node);
		expect(node.querySelector('label')?.getAttribute('for')).toBe(input.id);
		expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Without tax');
	});

	it('puts a prefix and a suffix in one frame with the input', () => {
		const input = document.createElement('input');
		const node = field(document, 'Price', input, { prefix: '$', suffix: 'USD' });
		mount(node);
		const frame = node.querySelector('.affix');
		expect(frame?.querySelector('.pre')?.textContent).toBe('$');
		expect(frame?.querySelector('.suf')?.textContent).toBe('USD');
		expect(frame?.contains(input)).toBe(true);
		const bare = affix(document, document.createElement('select'));
		expect(bare.querySelector('.pre, .suf')).toBeNull();
	});

	it('shows an error as an alert, marks the control invalid and clears it', () => {
		const input = document.createElement('input');
		const node = field(document, 'Name', input, { hint: 'Shown on invoices' });
		mount(node);
		fieldError(node, 'Required');
		const line = node.querySelector('.hint.error');
		expect(line?.getAttribute('role')).toBe('alert');
		expect(line?.textContent).toBe('Required');
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(input.getAttribute('aria-describedby')).toContain(line?.id ?? '?');
		fieldError(node, 'Too short');
		expect(node.querySelectorAll('.hint.error')).toHaveLength(1);
		fieldError(node, '');
		expect(node.querySelector('.hint.error')).toBeNull();
		expect(input.hasAttribute('aria-invalid')).toBe(false);
		fieldError(node, '');
	});

	it('can start with an error and works without a hint', () => {
		const input = document.createElement('input');
		const node = field(document, 'Name', input, { error: 'Taken' });
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(input.getAttribute('aria-describedby')).toBe(node.querySelector('.hint.error')?.id);
	});
});

describe('block and settingRow', () => {
	it('a block is a labeled region with a title, one line, actions and a body', () => {
		const action = document.createElement('button');
		const node = block(document, {
			title: 'Shipping',
			sub: 'Where it goes',
			actions: [action, null, false],
			body: ['text', undefined],
		});
		mount(node);
		expect(node.tagName).toBe('SECTION');
		expect(node.getAttribute('aria-labelledby')).toBe(node.querySelector('h3')?.id);
		expect(node.querySelector('.block-head p')?.textContent).toBe('Where it goes');
		expect(node.querySelector('.actions button')).toBe(action);
		expect(node.textContent).toContain('text');
	});

	it('a block without a title or actions has no head', () => {
		const bare = block(document, { body: [document.createElement('p')] });
		expect(bare.querySelector('.block-head')).toBeNull();
		const quiet = block(document, { title: 'Only title' });
		expect(quiet.querySelector('.actions')).toBeNull();
		expect(quiet.querySelector('.block-head p')).toBeNull();
	});

	it('a setting row links its label and help to the control; wide rows are marked', () => {
		const select = document.createElement('select');
		const row = settingRow(document, { label: 'Currency', help: 'For prices', control: select, wide: true });
		mount(row);
		expect(row.className).toBe('setting wide');
		expect(row.querySelector('label')?.getAttribute('for')).toBe(select.id);
		expect(select.getAttribute('aria-describedby')).toBe(row.querySelector('.help')?.id);
		const plain = settingRow(document, { label: 'X', control: document.createElement('input') });
		expect(plain.className).toBe('setting');
		expect(plain.querySelector('.help')).toBeNull();
	});
});

describe('the CSS', () => {
	it('draws the native inputs, takes every color from the theme and follows the page direction', () => {
		expect(CONTROLS_CSS).toContain('appearance: none');
		expect(CONTROLS_CSS).toContain("input[role='switch']");
		expect(CONTROLS_CSS).toContain('prefers-reduced-motion');
		expect(CONTROLS_CSS).toContain(":host([data-ss-mode='dark'])");
		expect(CONTROLS_CSS).toContain('var(--ss-color-accent');
		expect(CONTROLS_CSS).toContain('margin-inline-start');
		expect(CONTROLS_CSS).not.toMatch(/margin-left|padding-left|text-align: left/);
		// no brand color is written outside a var() fallback
		const stripped = CONTROLS_CSS.replace(/var\(--[\w-]+,[^)]*\)/g, '');
		expect(stripped).not.toMatch(/#(4f46e5|a5b4fc|15803d|b91c1c)/i);
	});

	it('keeps the admin kit free of the tokens that the controls own', () => {
		expect(ADMIN_KIT_CSS).not.toContain('--ss-kit-focus:');
		expect(ADMIN_KIT_CSS).toContain('.split > .pane');
	});
});
