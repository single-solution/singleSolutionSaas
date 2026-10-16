// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SchemaForm } from '../src/SchemaForm.js';
import { fieldsOf, groupFields, isWide, widgetOf } from '../src/schema.js';
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
				description: 'Shown in the bar',
				'x-ui': { widget: 'textarea', group: 'Content' },
			},
			tone: {
				type: 'string',
				title: 'Tone',
				default: 'info',
				enum: ['info', 'warning'],
				'x-ui': { group: 'Content' },
			},
			replyTo: { type: 'string', title: 'Reply-to', default: '', format: 'email', 'x-ui': { group: 'Content' } },
			theme: { type: 'string', title: 'Theme', default: 'a', enum: ['a', 'b', 'c', 'd', 'e'], 'x-ui': { group: 'Look' } },
			link: {
				type: 'string',
				title: 'Link',
				default: '',
				format: 'uri',
				'x-ui': { group: 'Look', placeholder: 'https://shop.example.com' },
			},
			debug: { type: 'boolean', title: 'Debug', default: false },
			tags: { type: 'array', title: 'Tags', default: [], items: { type: 'string' }, 'x-ui': { group: 'Look' } },
			flags: { type: 'array', title: 'Flags', default: [], items: { type: 'boolean' } },
		},
	});

describe('schema helpers', () => {
	it("keeps the schema's order and groups fields by x-ui.group (General without one)", () => {
		const fields = fieldsOf(hinted());
		expect(fields.map((f) => f.name)).toEqual(['message', 'tone', 'replyTo', 'theme', 'link', 'debug', 'tags', 'flags']);
		expect(groupFields(fields).map((g) => [g.name, g.fields.map((f) => f.name)])).toEqual([
			['Content', ['message', 'tone', 'replyTo']],
			['Look', ['theme', 'link', 'tags']],
			['General', ['debug', 'flags']],
		]);
		expect(fields.find((f) => f.name === 'message')?.help).toBe('Shown in the bar');
		expect(fields.find((f) => f.name === 'tone')?.help).toBeNull();
		expect(fields.find((f) => f.name === 'link')?.placeholder).toBe('https://shop.example.com');
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
		expect(widgetOf(node({ type: 'string', 'x-ui': { widget: 'textarea' } }))).toBe('textarea');
		expect(widgetOf(node({ type: 'array', items: { type: 'string', enum: ['a'] }, 'x-ui': { widget: 'tags' } }))).toBe('tags');
		// a widget that does not fit the type, or that the kit does not have, is ignored
		expect(widgetOf(node({ type: 'boolean', 'x-ui': { widget: 'textarea' } }))).toBe('switch');
		expect(widgetOf(node({ type: 'integer', 'x-ui': { widget: 'slider' } }))).toBe('number');
		expect(widgetOf(node({ type: 'string', 'x-ui': { widget: 'color' } }))).toBe('text');
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
	it('renders every widget with labels and groups', () => {
		const schema = hinted();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} idPrefix="t" />);
		expect([...container.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(
			expect.arrayContaining(['Content', 'Look', 'Tone']),
		);
		expect(byLabel(container, 'Message').tagName).toBe('TEXTAREA');
		expect(byLabel(container, 'Message').getAttribute('aria-describedby')).toContain('t-message-help');
		expect(byLabel(container, 'Theme').tagName).toBe('SELECT');
		expect(byLabel(container, 'Link').getAttribute('type')).toBe('url');
		expect(byLabel(container, 'Reply-to').getAttribute('type')).toBe('email');
		expect(byLabel(container, 'Message').getAttribute('type')).toBeNull();
		expect(byLabel(container, 'Link').getAttribute('placeholder')).toBe('https://shop.example.com');
		expect(container.querySelectorAll('input[type="radio"]').length).toBe(2);
		expect(byLabel(container, 'Debug').getAttribute('role')).toBe('switch');
		expect(byLabel(container, 'Flags').tagName).toBe('TEXTAREA');
		expect(container.textContent).not.toContain('Advanced');
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

	it('shows choice labels from data and lets the merchant pick a suggestion or type their own (K3)', () => {
		const schema = /** @type {import('../src/schema.js').SettingsSchema} */ ({
			type: 'object',
			properties: {
				method: {
					type: 'string',
					title: 'Method',
					default: 'cod',
					enum: ['cod', 'online', 'bank_transfer'],
					'x-ui': { labels: { cod: 'Pay on delivery', bank_transfer: 'Bank or wallet transfer' } },
				},
				unit: { type: 'string', title: 'Unit', default: 'piece', 'x-ui': { suggestions: ['piece', 'box', 'meter'] } },
				sizes: {
					type: 'array',
					title: 'Sizes',
					default: ['S'],
					items: { type: 'string' },
					'x-ui': { suggestions: ['S', 'M', 'L'] },
				},
			},
		});
		expect(widgetOf(/** @type {any} */ (schema.properties.unit))).toBe('suggest');
		expect(widgetOf(/** @type {any} */ (schema.properties.sizes))).toBe('tags');
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		// the labels are the product's words, a choice it does not name reads as words
		expect(container.textContent).toContain('Pay on delivery');
		expect(container.textContent).toContain('Bank or wallet transfer');
		expect(container.textContent).toContain('Online');
		// a text offers its suggestions and takes its own value
		const unit = byLabel(container, 'Unit');
		expect([...(unit.list?.options ?? [])].map((o) => o.value)).toEqual(['piece', 'box', 'meter']);
		type(unit, 'liter');
		expect(onChange).toHaveBeenLastCalledWith('unit', 'liter');
		// a list of texts: pick a suggestion, or add what is typed (once, any case)
		click(/** @type {HTMLElement} */ (container.querySelector('input[id$="-M"]')));
		expect(onChange).toHaveBeenLastCalledWith('sizes', ['S', 'M']);
		const search = /** @type {HTMLInputElement} */ (container.querySelector('input[type="search"]'));
		type(search, ' XXL ');
		click(byText(container, 'Add “XXL”', 'button'));
		expect(onChange).toHaveBeenLastCalledWith('sizes', ['S', 'M', 'XXL']);
		type(search, 'xxl');
		expect(container.textContent).not.toContain('Add “xxl”');
	});

	it('edits tag lists and lists of on/off values (JSON)', () => {
		const schema = hinted();
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		type(byLabel(container, 'Tags'), 'a\n\nb\n');
		expect(onChange).toHaveBeenLastCalledWith('tags', ['a', 'b']);
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

	it('maps errors onto fields, offers reset of overrides and honors disabled', () => {
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
