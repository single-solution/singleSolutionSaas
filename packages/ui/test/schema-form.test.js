// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { manifest } from '@ss/contracts/testing';
import { SchemaForm } from '../src/SchemaForm.js';
import {
	boundsOf,
	changedNames,
	defaultOf,
	fieldsOf,
	groupFields,
	kindOf,
	lockLabel,
	sameValue,
	validateValue,
	validateValues,
	widgetOf,
} from '../src/schema.js';
import { allByRole, byLabel, byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(cleanup);

/** The coupons element's feature schema from the contracts fixtures (every x-* keyword in use). */
const coupons = () => /** @type {any} */ (manifest().elements[0].features);

/** A schema exercising x-ui hints. */
const hinted = () =>
	/** @type {import('../src/schema.js').FeatureSchema} */ ({
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

	it('derives kinds, widgets, defaults and plan bounds', () => {
		const s = coupons();
		expect(kindOf(s.properties.allowStacking)).toBe('flag');
		expect(kindOf(s.properties.prefix)).toBe('config');
		expect(kindOf({ type: 'boolean' })).toBe('flag');
		expect(kindOf({ type: 'string' })).toBe('config');
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
		expect(defaultOf(s.properties.maxActive, 'starter')).toBe(10);
		expect(defaultOf(s.properties.maxActive, null)).toBe(20);
		expect(boundsOf(s.properties.maxActive, 'starter')).toMatchObject({ min: 1, max: 50, absoluteMax: 100000, planMax: 50 });
		expect(boundsOf(s.properties.maxActive, null)).toMatchObject({ max: 100000, planMax: undefined });
		expect(boundsOf({ type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 })).toMatchObject({ min: 1, max: 9 });
		expect(boundsOf({ type: 'string', maxLength: 20, 'x-plan': { p: { max: 5 } } }, 'p').maxLength).toBe(5);
		expect(boundsOf({ type: 'array', maxItems: 9, 'x-plan': { p: { max: 2 } } }, 'p').maxItems).toBe(2);
		expect(boundsOf({ type: 'boolean', 'x-plan': { p: { max: false } } }, 'p').flagAllowed).toBe(false);
		const fields = fieldsOf(s, { plan: 'starter' });
		expect(fields.find((f) => f.name === 'monthlyRedemptions')).toMatchObject({
			unitLabel: 'per month · redemption',
			unlimitedAllowed: false,
		});
		expect(fields.find((f) => f.name === 'validateRate')).toMatchObject({
			unitLabel: 'per minute · request',
			unlimitedAllowed: true,
		});
		expect(fields.find((f) => f.name === 'maxActive')?.lockable).toBe(true);
	});

	it('validates values against absolute and plan bounds', () => {
		const s = coupons();
		const p = s.properties;
		expect(validateValue(p.maxActive, 51, { plan: 'starter' })).toBe('Your plan allows at most 50.');
		expect(validateValue(p.maxActive, 0)).toBe('Must be at least 1.');
		expect(validateValue(p.maxActive, 100001)).toBe('Must be at most 100,000.');
		expect(validateValue(p.maxActive, 2.5)).toBe('Enter a whole number.');
		expect(validateValue(p.maxActive, 'x')).toBe('Enter a number.');
		expect(validateValue(p.maxActive, undefined)).toBe('This field is required.');
		expect(validateValue(p.validateRate, null)).toBeNull();
		expect(validateValue(p.maxActive, null, { plan: 'starter' })).toBe('A value is required.');
		expect(validateValue(p.prefix, 'save')).toBe('Has an invalid format.');
		expect(validateValue(p.prefix, 'SAVE20')).toBeNull();
		expect(validateValue(p.prefix, 'A'.repeat(13))).toBe('Must be at most 12 characters.');
		expect(validateValue(p.prefix, 3)).toBe('Enter text.');
		expect(validateValue(p.channels, ['web', 'web'])).toBe('Items must not repeat.');
		expect(validateValue(p.channels, ['web', 'tv'])).toMatch(/An item is invalid/);
		expect(validateValue(p.channels, 'web')).toBe('Invalid list.');
		expect(validateValue(p.channels, ['web', 'pos', 'app', 'web'])).toBe('At most 3 items.');
		expect(validateValue({ type: 'array', maxItems: 5, 'x-plan': { p: { max: 1 } } }, ['a', 'b'], { plan: 'p' })).toBe(
			'Your plan allows at most 1 items.',
		);
		expect(validateValue({ type: 'array', minItems: 1 }, [])).toBe('Choose at least 1.');
		expect(validateValue(p.window, { days: 0 })).toBe('Days: Must be at least 1.');
		expect(validateValue(p.window, {})).toBe('Days is required.');
		expect(validateValue(p.window, [])).toBe('Invalid value.');
		expect(validateValue(p.allowStacking, 'yes')).toBe('Choose on or off.');
		expect(validateValue({ type: 'boolean', 'x-plan': { p: { max: false } } }, true, { plan: 'p' })).toBe(
			'Your plan does not include this option.',
		);
		expect(validateValue({ type: 'string', enum: ['a'] }, 'b')).toBe('Choose one of the options.');
		expect(validateValue({ type: 'string', minLength: 2 }, 'a')).toBe('Must be at least 2 characters.');
		expect(validateValue({ type: 'string', format: 'email' }, 'nope')).toBe('Enter an e-mail address.');
		expect(validateValue({ type: 'string', format: 'uri' }, 'ftp://x')).toBe('Enter a URL starting with https://.');
		expect(validateValue({ type: 'string', pattern: '(' }, 'x')).toBeNull();
		expect(validateValue({ type: 'number', multipleOf: 0.5 }, 0.75)).toBe('Must be a multiple of 0.5.');
		expect(validateValue({ type: 'boolean' }, undefined)).toBeNull();
		expect(
			validateValues(
				s,
				{ ...Object.fromEntries(Object.entries(p).map(([k, n]) => [k, n.default])), maxActive: 60 },
				{ plan: 'starter' },
			),
		).toEqual({
			maxActive: 'Your plan allows at most 50.',
			monthlyRedemptions: 'Your plan allows at most 500.',
		});
		expect(validateValues(s, { maxActive: 60 }, { plan: 'starter', skip: ['maxActive'] }).maxActive).toBeUndefined();
	});

	it('compares values and labels lock sources', () => {
		expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
		expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(sameValue([1], { 0: 1 })).toBe(false);
		expect(sameValue(null, {})).toBe(false);
		expect(changedNames({ a: 1, b: [1] }, { a: 1, b: [2], c: true })).toEqual(['b', 'c']);
		expect(lockLabel('admin_override')).toBe('Set by admin');
		expect(lockLabel('platform_policy')).toBe('Set by platform');
		expect(lockLabel(undefined)).toBe('Set by platform/admin');
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
	it('renders every widget with labels, groups, plan bounds and the advanced disclosure', () => {
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
	});

	it('reports typed values: numbers, switches, enums, lists, tags, nested objects and JSON', () => {
		const schema = coupons();
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} plan="starter" onChange={onChange} />);
		const max = byLabel(container, 'Maximum active codes');
		expect(max.getAttribute('max')).toBe('50');
		expect(container.textContent).toContain('Plan max 50');
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
		// a rate without a plan max may be unlimited
		click(byLabel(container, 'Unlimited'));
		expect(onChange).toHaveBeenLastCalledWith('validateRate', null);
		expect(byLabel(container, 'Validations per minute').disabled).toBe(true);
		click(byLabel(container, 'Unlimited'));
		expect(onChange).toHaveBeenLastCalledWith('validateRate', 60);
		expect(container.textContent).toContain('per minute · request');
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

	it('shows locked features read-only with who set them', () => {
		const schema = coupons();
		const { container } = render(
			<Harness
				schema={schema}
				initial={{ ...defaults(schema), maxActive: 75 }}
				plan="starter"
				locks={{ maxActive: { label: 'Set by admin', reason: 'contract' } }}
			/>,
		);
		expect(() => byLabel(container, 'Maximum active codes')).toThrow();
		const row = byText(container, 'Maximum active codes').closest('div');
		expect(row?.parentElement?.textContent).toContain('Set by admin — contract');
		expect(row?.parentElement?.textContent).toContain('75');
		expect(container.querySelector('svg[aria-label="Locked"]')).not.toBeNull();
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

	it('flags plan-forbidden options and renders an empty schema message', () => {
		const schema = /** @type {any} */ ({
			type: 'object',
			properties: { premium: { type: 'boolean', title: 'Premium', default: false, 'x-plan': { basic: { max: false } } } },
		});
		const { container } = render(
			<SchemaForm schema={schema} values={{ premium: false }} onChange={() => undefined} plan="basic" />,
		);
		expect(container.textContent).toContain('Not in your plan');
		expect(/** @type {HTMLButtonElement} */ (allByRole(container, 'switch')[0]).disabled).toBe(true);
		cleanup();
		const empty = render(<SchemaForm schema={{ type: 'object', properties: {} }} values={{}} onChange={() => undefined} />);
		expect(empty.container.textContent).toContain('This element has no settings.');
	});
});

/**
 * @param {ParentNode} root
 * @param {string} text
 */
const allByText = (root, text) => [...root.querySelectorAll('button')].filter((b) => b.textContent === text);
