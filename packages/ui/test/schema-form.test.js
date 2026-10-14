// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SchemaForm } from '../src/SchemaForm.js';
import { choiceLabel, fieldsOf, groupFields, isWide, widgetOf } from '../src/schema.js';
import { allByRole, byLabel, byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(cleanup);

/** @typedef {import('../src/schema.js').SettingNode} SettingNode */

/**
 * A setting with a title and default, as every settings schema has them.
 * @param {Omit<SettingNode, 'title' | 'default'>} rest
 * @returns {SettingNode}
 */
const node = (rest) => ({ title: 'Setting', default: null, ...rest });

/** A coupons feature's settings schema using every setting type. */
const coupons = () =>
	/** @type {any} */ ({
		type: 'object',
		properties: {
			allowStacking: { type: 'boolean', title: 'Allow stacking', default: false },
			maxActive: { type: 'integer', title: 'Maximum active codes', default: 20, minimum: 1, maximum: 100000 },
			prefix: { type: 'string', title: 'Code prefix', default: 'SAVE', maxLength: 12 },
			channels: {
				type: 'array',
				title: 'Channels',
				default: ['web'],
				items: { type: 'string', enum: ['web', 'pos', 'app'] },
			},
			share: { type: 'number', title: 'Share', default: 0.5, minimum: 0, maximum: 1 },
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
			tags: { type: 'array', title: 'Tags', default: [], items: { type: 'string' }, 'x-ui': { group: 'Look' } },
			flags: { type: 'array', title: 'Flags', default: [], items: { type: 'boolean' }, 'x-ui': { advanced: true } },
		},
	});

describe('schema helpers', () => {
	it('orders and groups fields by x-ui, dropping hidden ones', () => {
		const fields = fieldsOf(hinted());
		expect(fields.map((f) => f.name)).toEqual(['tone', 'message', 'theme', 'color', 'debug', 'tags', 'flags']);
		const { groups, advanced } = groupFields(fields);
		expect(groups.map((g) => [g.name, g.fields.map((f) => f.name)])).toEqual([
			['Content', ['tone', 'message']],
			['Look', ['theme', 'color', 'tags']],
		]);
		expect(advanced.map((f) => f.name)).toEqual(['debug', 'flags']);
		expect(fields.find((f) => f.name === 'message')?.help).toBe('Shown in the bar');
		expect(fieldsOf(null)).toEqual([]);
	});

	it('derives widgets and which fields span the row', () => {
		const s = coupons();
		expect(widgetOf(s.properties.allowStacking)).toBe('switch');
		expect(widgetOf(s.properties.maxActive)).toBe('number');
		expect(widgetOf(s.properties.channels)).toBe('checkboxes');
		expect(widgetOf(node({ type: 'string', enum: ['a', 'b'] }))).toBe('radio');
		expect(widgetOf(node({ type: 'string', format: 'email' }))).toBe('email');
		expect(widgetOf(node({ type: 'string', format: 'uri' }))).toBe('url');
		expect(widgetOf(node({ type: 'string', format: 'date' }))).toBe('text');
		expect(widgetOf(node({ type: 'array', items: { type: 'string' } }))).toBe('tags');
		expect(widgetOf(node({ type: 'integer', 'x-ui': { widget: 'slider' } }))).toBe('number');
		expect(widgetOf(node({ type: 'boolean', 'x-ui': { widget: 'textarea' } }))).toBe('switch');
		// grid layout: long text and lists span the row; `x-ui.wide` decides when given
		expect(isWide(node({ type: 'string' }), 'text')).toBe(false);
		expect(isWide(node({ type: 'string', 'x-ui': { widget: 'textarea' } }), 'textarea')).toBe(true);
		expect(isWide(node({ type: 'string', 'x-ui': { wide: true } }), 'text')).toBe(true);
		expect(isWide(node({ type: 'array', items: { type: 'string' }, 'x-ui': { wide: false } }), 'tags')).toBe(false);
		expect(fieldsOf(s).map((f) => [f.name, f.wide])).toEqual([
			['allowStacking', false],
			['maxActive', false],
			['prefix', false],
			['channels', true],
			['share', false],
		]);
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
		expect(byLabel(container, 'Flags').tagName).toBe('TEXTAREA');
		// fields sit in a grid: short ones are cells, long ones span the row
		const cellOf = (/** @type {string} */ name) => container.querySelector(`[data-field="${name}"]`);
		expect(cellOf('tone')?.hasAttribute('data-cell')).toBe(true);
		expect(cellOf('tone')?.hasAttribute('data-wide')).toBe(false);
		expect(cellOf('message')?.hasAttribute('data-wide')).toBe(true);
		expect(cellOf('tags')?.hasAttribute('data-wide')).toBe(true);
		expect(cellOf('tone')?.parentElement?.className).toContain('@md:grid-cols-2');
	});

	it('reports typed values: numbers, switches, enums and lists, with the bounds on the inputs', () => {
		const schema = coupons();
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		const max = byLabel(container, 'Maximum active codes');
		expect([max.getAttribute('min'), max.getAttribute('max'), max.getAttribute('step')]).toEqual(['1', '100000', '1']);
		const share = byLabel(container, 'Share');
		expect([share.getAttribute('min'), share.getAttribute('max'), share.getAttribute('step')]).toEqual(['0', '1', 'any']);
		type(share, '0.25');
		expect(onChange).toHaveBeenLastCalledWith('share', 0.25);
		expect(byLabel(container, 'Code prefix').getAttribute('maxlength')).toBe('12');
		type(max, '42');
		expect(onChange).toHaveBeenLastCalledWith('maxActive', 42);
		type(max, '');
		expect(onChange).toHaveBeenLastCalledWith('maxActive', undefined);
		const stacking = allByRole(container, 'switch')[0];
		expect(stacking?.getAttribute('aria-checked')).toBe('false');
		click(/** @type {HTMLElement} */ (stacking));
		expect(onChange).toHaveBeenLastCalledWith('allowStacking', true);
		expect(stacking?.getAttribute('aria-checked')).toBe('true');
		click(byLabel(container, 'Pos'));
		expect(onChange).toHaveBeenLastCalledWith('channels', ['web', 'pos']);
		click(byLabel(container, 'Web'));
		expect(onChange).toHaveBeenLastCalledWith('channels', ['pos']);
		type(byLabel(container, 'Code prefix'), 'WIN');
		expect(onChange).toHaveBeenLastCalledWith('prefix', 'WIN');
	});

	it('picks from a long list of countries by name, with the placeholder while none is chosen', () => {
		const schema = /** @type {import('../src/schema.js').SettingsSchema} */ ({
			type: 'object',
			properties: {
				countries: {
					type: 'array',
					title: 'Countries',
					default: ['GB'],
					items: { type: 'string', enum: ['GB', 'FR', 'DE', 'US', 'PK', 'AE', 'SA', 'IN', 'CN', 'JP', 'BR', 'CA', 'AU'] },
					'x-ui': { labels: 'country', placeholder: 'Any country' },
				},
			},
		});
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		expect(container.querySelector('input[type="search"]')).not.toBeNull();
		click(/** @type {HTMLElement} */ (container.querySelector('input[id$="-FR"]')));
		expect(onChange).toHaveBeenLastCalledWith('countries', ['GB', 'FR']);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Remove United Kingdom"]')));
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Remove France"]')));
		expect(onChange).toHaveBeenLastCalledWith('countries', []);
		expect(container.textContent).toContain('Any country');
	});

	it('edits tag lists and lists of on/off values (JSON)', () => {
		const schema = hinted();
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		type(byLabel(container, 'Tags'), 'a\n\nb\n');
		expect(onChange).toHaveBeenLastCalledWith('tags', ['a', 'b']);
		click(byText(container, 'Advanced settings (2)', 'button'));
		const flags = byLabel(container, 'Flags');
		type(flags, '[true, false]');
		expect(onChange).toHaveBeenLastCalledWith('flags', [true, false]);
		type(flags, '[oops');
		expect(container.textContent).toContain('Enter valid JSON.');
		click(byLabel(container, 'Debug'));
		expect(onChange).toHaveBeenLastCalledWith('debug', true);
		click(byLabel(container, 'Warning'));
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
				errors={{ prefix: 'Must be at most 12 characters.' }}
				overridden={{ prefix: true }}
				onReset={onReset}
			/>,
		);
		const prefix = byLabel(container, 'Code prefix');
		expect(prefix.getAttribute('aria-invalid')).toBe('true');
		const message = document.getElementById(String(prefix.getAttribute('aria-describedby')).split(' ').pop() ?? '');
		expect(message?.textContent).toContain('Must be at most 12 characters.');
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

describe('choiceLabel', () => {
	it('shows a choice value as readable words, keeping known short words in capitals', () => {
		expect(choiceLabel('per_unit_down')).toBe('Per unit down');
		expect(choiceLabel('sms')).toBe('SMS');
		expect(choiceLabel('whatsapp')).toBe('WhatsApp');
		expect(choiceLabel('cod_fee')).toBe('COD fee');
		expect(choiceLabel('one-exclusive')).toBe('One exclusive');
		expect(choiceLabel('Mixed Case')).toBe('Mixed Case');
		expect(choiceLabel('iban')).toBe('IBAN');
		expect(choiceLabel('postalCode')).toBe('Postal code');
		expect(choiceLabel('line1')).toBe('Line 1');
		expect(choiceLabel(30)).toBe('30');
	});
});
