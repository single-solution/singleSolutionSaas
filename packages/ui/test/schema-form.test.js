// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SchemaForm } from '../src/SchemaForm.js';
import {
	boundsOf,
	changedNames,
	fieldsOf,
	groupFields,
	isWide,
	sameValue,
	validateValue,
	validateValues,
	widgetOf,
} from '../src/schema.js';
import { allByRole, byLabel, byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(cleanup);

/** A coupons feature's settings schema using every node type. */
const coupons = () =>
	/** @type {any} */ ({
		type: 'object',
		properties: {
			allowStacking: { type: 'boolean', title: 'Allow stacking', default: false },
			maxActive: { type: 'integer', title: 'Maximum active codes', default: 20, minimum: 1, maximum: 100000 },
			prefix: { type: 'string', title: 'Code prefix', default: 'SAVE', maxLength: 12, pattern: '^[A-Z0-9]+$' },
			channels: {
				type: 'array',
				title: 'Channels',
				default: ['web'],
				items: { type: 'string', enum: ['web', 'pos', 'app'] },
				maxItems: 3,
				uniqueItems: true,
			},
			window: {
				type: 'object',
				title: 'Validity window',
				default: { days: 30 },
				required: ['days'],
				properties: { days: { type: 'integer', title: 'Days', minimum: 1, maximum: 365 } },
			},
		},
	});

/** A schema exercising x-ui hints. */
const hinted = () =>
	/** @type {import('../src/schema.js').SettingsSchema} */ ({
		type: 'object',
		properties: {
			message: {
				type: 'string',
				title: 'Message',
				default: 'Hello',
				maxLength: 140,
				'x-ui': { widget: 'textarea', group: 'Content', order: 2, help: 'Shown in the bar' },
			},
			tone: {
				type: 'string',
				title: 'Tone',
				default: 'info',
				enum: ['info', 'warning'],
				'x-ui': { group: 'Content', order: 1 },
			},
			theme: { type: 'string', title: 'Theme', default: 'a', enum: ['a', 'b', 'c', 'd', 'e'], 'x-ui': { group: 'Look' } },
			color: { type: 'string', title: 'Colour', default: '#112233', 'x-ui': { widget: 'color', group: 'Look' } },
			debug: { type: 'boolean', title: 'Debug', default: false, 'x-ui': { advanced: true, widget: 'checkbox' } },
			secretFlag: { type: 'boolean', title: 'Hidden', default: false, 'x-ui': { hidden: true } },
			tags: { type: 'array', title: 'Tags', default: [], items: { type: 'string' }, maxItems: 3, 'x-ui': { group: 'Look' } },
			raw: { type: 'object', title: 'Raw', default: {}, properties: {}, 'x-ui': { widget: 'json', advanced: true } },
		},
	});

describe('schema helpers', () => {
	it('orders and groups fields by x-ui, dropping hidden ones', () => {
		const fields = fieldsOf(hinted());
		expect(fields.map((f) => f.name)).toEqual(['tone', 'message', 'theme', 'color', 'debug', 'tags', 'raw']);
		const { groups, advanced } = groupFields(fields);
		expect(groups.map((g) => [g.name, g.fields.map((f) => f.name)])).toEqual([
			['Content', ['tone', 'message']],
			['Look', ['theme', 'color', 'tags']],
		]);
		expect(advanced.map((f) => f.name)).toEqual(['debug', 'raw']);
		expect(fields.find((f) => f.name === 'message')?.help).toBe('Shown in the bar');
		expect(fieldsOf(null)).toEqual([]);
	});

	it('derives widgets, defaults and bounds', () => {
		const s = coupons();
		expect(widgetOf(s.properties.allowStacking)).toBe('switch');
		expect(widgetOf(s.properties.maxActive)).toBe('number');
		expect(widgetOf(s.properties.channels)).toBe('checkboxes');
		expect(widgetOf(s.properties.window)).toBe('fieldset');
		expect(widgetOf({ type: 'string', enum: ['a', 'b'] })).toBe('radio');
		expect(widgetOf({ type: 'string', format: 'email' })).toBe('email');
		expect(widgetOf({ type: 'string', format: 'uri' })).toBe('url');
		expect(widgetOf({ type: 'array', items: { type: 'string' } })).toBe('tags');
		expect(widgetOf({ type: 'integer', 'x-ui': { widget: 'slider' } })).toBe('number');
		expect(widgetOf({ type: 'boolean', 'x-ui': { widget: 'textarea' } })).toBe('switch');
		expect(widgetOf({ type: 'string', format: 'markdown' })).toBe('textarea');
		// grid layout: long text, JSON, lists and fieldsets span the row; `x-ui.wide` decides when given
		expect(isWide({ type: 'string' }, 'text')).toBe(false);
		expect(isWide({ type: 'string', format: 'multiline' }, widgetOf({ type: 'string', format: 'multiline' }))).toBe(true);
		expect(isWide({ type: 'string', 'x-ui': { wide: true } }, 'text')).toBe(true);
		expect(isWide({ type: 'array', items: { type: 'string' }, 'x-ui': { wide: false } }, 'tags')).toBe(false);
		expect(fieldsOf(s).map((f) => [f.name, f.wide])).toEqual([
			['allowStacking', false],
			['maxActive', false],
			['prefix', false],
			['channels', true],
			['window', true],
		]);
		expect(boundsOf(s.properties.maxActive)).toEqual({ min: 1, max: 100000, maxLength: undefined, maxItems: undefined });
		expect(boundsOf({ type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 })).toMatchObject({ min: 1, max: 9 });
		expect(boundsOf({ type: 'number', exclusiveMinimum: 0 }).min).toBe(Number.EPSILON);
		expect(fieldsOf(s).find((f) => f.name === 'maxActive')?.defaultValue).toBe(20);
		expect(fieldsOf({ properties: { short_name: { type: 'string' } } })[0]?.title).toBe('Short name');
	});

	it('validates values against their bounds', () => {
		const s = coupons();
		const p = s.properties;
		expect(validateValue(p.maxActive, 0)).toBe('Must be at least 1.');
		expect(validateValue(p.maxActive, 100001)).toBe('Must be at most 100,000.');
		expect(validateValue(p.maxActive, 2.5)).toBe('Enter a whole number.');
		expect(validateValue(p.maxActive, 'x')).toBe('Enter a number.');
		expect(validateValue(p.maxActive, undefined)).toBe('This field is required.');
		expect(validateValue(p.maxActive, null)).toBe('A value is required.');
		expect(validateValue(p.prefix, 'save')).toBe('Has an invalid format.');
		expect(validateValue(p.prefix, 'SAVE20')).toBeNull();
		expect(validateValue(p.prefix, 'A'.repeat(13))).toBe('Must be at most 12 characters.');
		expect(validateValue(p.prefix, 3)).toBe('Enter text.');
		expect(validateValue(p.channels, ['web', 'web'])).toBe('Items must not repeat.');
		expect(validateValue(p.channels, ['web', 'tv'])).toMatch(/An item is invalid/);
		expect(validateValue(p.channels, 'web')).toBe('Invalid list.');
		expect(validateValue(p.channels, ['web', 'pos', 'app', 'web'])).toBe('At most 3 items.');
		expect(validateValue({ type: 'array', minItems: 1 }, [])).toBe('Choose at least 1.');
		expect(validateValue(p.window, { days: 0 })).toBe('Days: Must be at least 1.');
		expect(validateValue(p.window, {})).toBe('Days is required.');
		expect(validateValue(p.window, [])).toBe('Invalid value.');
		expect(validateValue(p.allowStacking, 'yes')).toBe('Choose on or off.');
		expect(validateValue({ type: 'string', enum: ['a'] }, 'b')).toBe('Choose one of the options.');
		expect(validateValue({ type: 'string', minLength: 2 }, 'a')).toBe('Must be at least 2 characters.');
		expect(validateValue({ type: 'string', format: 'email' }, 'nope')).toBe('Enter an e-mail address.');
		expect(validateValue({ type: 'string', format: 'uri' }, 'ftp://x')).toBe('Enter a URL starting with https://.');
		expect(validateValue({ type: 'string', pattern: '(' }, 'x')).toBeNull();
		expect(validateValue({ type: 'number', multipleOf: 0.5 }, 0.75)).toBe('Must be a multiple of 0.5.');
		expect(validateValue({ type: 'boolean' }, undefined)).toBeNull();
		expect(validateValue({ type: 'string', enum: ['a'] }, 'a')).toBeNull();
		expect(validateValue({ type: 'array' }, ['x'])).toBeNull();
		expect(validateValue({ type: 'object' }, { x: 1 })).toBeNull();
		expect(validateValue({}, 'anything')).toBeNull();
		expect(
			validateValues(s, { ...Object.fromEntries(Object.entries(p).map(([k, n]) => [k, n.default])), maxActive: 0 }),
		).toEqual({ maxActive: 'Must be at least 1.' });
	});

	it('compares values', () => {
		expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
		expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(sameValue([1], { 0: 1 })).toBe(false);
		expect(sameValue(null, {})).toBe(false);
		expect(changedNames({ a: 1, b: [1] }, { a: 1, b: [2], c: true })).toEqual(['b', 'c']);
	});
});

/**
 * Controlled harness recording every change.
 * @param {{ schema: any, initial: Record<string, unknown>, onChange?: (name: string, value: unknown) => void } & Record<string, any>} props
 */
function Harness({ schema, initial, onChange, ...rest }) {
	const [values, setValues] = useState(initial);
	return (
		<SchemaForm
			schema={schema}
			values={values}
			onChange={(name, value) => {
				onChange?.(name, value);
				setValues((v) => ({ ...v, [name]: value }));
			}}
			{...rest}
		/>
	);
}

/** @param {any} schema */
const defaults = (schema) =>
	Object.fromEntries(Object.entries(schema.properties).map(([k, n]) => [k, /** @type {any} */ (n).default]));

describe('SchemaForm', () => {
	it('renders every widget with labels, groups and the advanced disclosure', () => {
		const schema = hinted();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} idPrefix="t" />);
		expect([...container.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(
			expect.arrayContaining(['Content', 'Look', 'Tone']),
		);
		expect(byLabel(container, 'Message').tagName).toBe('TEXTAREA');
		expect(byLabel(container, 'Message').getAttribute('aria-describedby')).toContain('t-message-help');
		expect(byLabel(container, 'Theme').tagName).toBe('SELECT');
		expect(byLabel(container, 'Colour').getAttribute('type')).toBe('color');
		expect(container.querySelectorAll('input[type="radio"]').length).toBe(2);
		expect(container.textContent).not.toContain('Hidden');
		// advanced fields are behind a disclosure
		expect(container.textContent).not.toContain('Debug');
		const toggle = byText(container, 'Advanced settings (2)', 'button');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(byLabel(container, 'Debug').getAttribute('type')).toBe('checkbox');
		expect(byLabel(container, 'Raw').tagName).toBe('TEXTAREA');
		// fields sit in a grid: short ones are cells, long ones span the row
		const cellOf = (/** @type {string} */ name) => container.querySelector(`[data-field="${name}"]`);
		expect(cellOf('tone')?.hasAttribute('data-cell')).toBe(true);
		expect(cellOf('tone')?.hasAttribute('data-wide')).toBe(false);
		expect(cellOf('message')?.hasAttribute('data-wide')).toBe(true);
		expect(cellOf('tags')?.hasAttribute('data-wide')).toBe(true);
		expect(cellOf('tone')?.parentElement?.className).toContain('@md:grid-cols-2');
	});

	it('reports typed values: numbers, switches, enums, lists, tags, nested objects and JSON', () => {
		const schema = coupons();
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		const max = byLabel(container, 'Maximum active codes');
		expect(max.getAttribute('max')).toBe('100000');
		type(max, '42');
		expect(onChange).toHaveBeenLastCalledWith('maxActive', 42);
		type(max, '');
		expect(onChange).toHaveBeenLastCalledWith('maxActive', undefined);
		const stacking = allByRole(container, 'switch')[0];
		expect(stacking?.getAttribute('aria-checked')).toBe('false');
		click(/** @type {HTMLElement} */ (stacking));
		expect(onChange).toHaveBeenLastCalledWith('allowStacking', true);
		expect(stacking?.getAttribute('aria-checked')).toBe('true');
		click(byLabel(container, 'pos'));
		expect(onChange).toHaveBeenLastCalledWith('channels', ['web', 'pos']);
		click(byLabel(container, 'web'));
		expect(onChange).toHaveBeenLastCalledWith('channels', ['pos']);
		type(byLabel(container, 'Code prefix'), 'WIN');
		expect(onChange).toHaveBeenLastCalledWith('prefix', 'WIN');
		type(container.querySelector('[id$="-window-days"]') ?? document.body, '7');
		expect(onChange).toHaveBeenLastCalledWith('window', { days: 7 });
	});

	it('edits tag lists and JSON values', () => {
		const schema = hinted();
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		type(byLabel(container, 'Tags'), 'a\n\nb\n');
		expect(onChange).toHaveBeenLastCalledWith('tags', ['a', 'b']);
		click(byText(container, 'Advanced settings (2)', 'button'));
		const raw = byLabel(container, 'Raw');
		type(raw, '{"x": 1}');
		expect(onChange).toHaveBeenLastCalledWith('raw', { x: 1 });
		type(raw, '{oops');
		expect(container.textContent).toContain('Enter valid JSON.');
		click(byLabel(container, 'Debug'));
		expect(onChange).toHaveBeenLastCalledWith('debug', true);
		click(byLabel(container, 'warning'));
		expect(onChange).toHaveBeenLastCalledWith('tone', 'warning');
		type(byLabel(container, 'Theme'), 'c');
		expect(onChange).toHaveBeenLastCalledWith('theme', 'c');
	});

	it('maps errors onto fields, offers reset of overrides and honours disabled', () => {
		const schema = coupons();
		const onReset = vi.fn();
		const { container, rerender } = render(
			<SchemaForm
				schema={schema}
				values={defaults(schema)}
				onChange={() => undefined}
				errors={{ prefix: 'Has an invalid format.' }}
				overridden={{ prefix: true }}
				onReset={onReset}
			/>,
		);
		const prefix = byLabel(container, 'Code prefix');
		expect(prefix.getAttribute('aria-invalid')).toBe('true');
		const message = document.getElementById(String(prefix.getAttribute('aria-describedby')).split(' ').pop() ?? '');
		expect(message?.textContent).toContain('Has an invalid format.');
		expect(message?.getAttribute('role')).toBe('alert');
		click(byText(container, 'Reset', 'button'));
		expect(onReset).toHaveBeenCalledWith('prefix');
		rerender(
			<SchemaForm
				schema={schema}
				values={defaults(schema)}
				onChange={() => undefined}
				disabled
				overridden={{ prefix: true }}
				onReset={onReset}
			/>,
		);
		expect(byLabel(container, 'Code prefix').disabled).toBe(true);
		expect(allByText(container, 'Reset')).toHaveLength(0);
	});

	it('renders an empty schema message', () => {
		const empty = render(<SchemaForm schema={{ type: 'object', properties: {} }} values={{}} onChange={() => undefined} />);
		expect(empty.container.textContent).toContain('This feature has no settings.');
	});
});

/**
 * @param {ParentNode} root
 * @param {string} text
 */
const allByText = (root, text) => [...root.querySelectorAll('button')].filter((b) => b.textContent === text);
