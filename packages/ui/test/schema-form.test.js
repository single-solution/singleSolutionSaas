// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SchemaForm, randomKey } from '../src/SchemaForm.js';
import { fieldsOf, groupFields, isWide, shapeOf, widgetOf } from '../src/schema.js';
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
		expect(widgetOf(node({ type: 'string', enum: ['a', 'b'] }))).toBe('segmented');
		expect(widgetOf(node({ type: 'string', enum: ['a', 'b', 'c', 'd', 'e'] }))).toBe('select');
		expect(widgetOf(node({ type: 'string', enum: ['a', 'b'], 'x-ui': { widget: 'radio' } }))).toBe('radio');
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
			tabs={false}
			{...rest}
		/>
	);
}

/**
 * @param {ParentNode} root
 * @param {string} label
 */
const byTextButton = (root, label) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

/** @param {any} schema */
const defaults = (schema) =>
	Object.fromEntries(Object.entries(schema.properties).map(([k, n]) => [k, /** @type {any} */ (n).default]));

describe('SchemaForm', () => {
	it('renders every widget with labels and groups', () => {
		const schema = hinted();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} idPrefix="t" />);
		// one titled card per group, the settings as rows inside
		expect([...container.querySelectorAll('section h2')].map((h) => h.textContent)).toEqual(['Content', 'Look', 'General']);
		expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-labelledby')).toBeTruthy();
		expect(container.querySelector('[role="radiogroup"]')?.textContent).toContain('Tone');
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
		expect(cellOf('tone')?.parentElement?.className).toContain('flex-col');
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

	it('gives a text with `generate` a Generate button that fills in a new random key (not while disabled)', () => {
		const schema = /** @type {import('../src/schema.js').SettingsSchema} */ ({
			type: 'object',
			properties: { key: { type: 'string', title: 'Site key', default: '', maxLength: 128, 'x-ui': { generate: 32 } } },
		});
		const onChange = vi.fn();
		const { container, rerender } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		click(byText(container, 'Generate', 'button'));
		const first = String(onChange.mock.calls.at(-1)?.[1]);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		click(byText(container, 'Generate', 'button'));
		expect(String(onChange.mock.calls.at(-1)?.[1])).not.toBe(first);
		expect(randomKey(8)).toMatch(/^[0-9a-f]{8}$/);
		expect(randomKey(33)).toHaveLength(33);
		// the dashboard words the button
		rerender(<SchemaForm schema={schema} values={defaults(schema)} onChange={onChange} generateText="Make one" />);
		expect(byText(container, 'Make one', 'button')).toBeTruthy();
		// a form that is disabled offers none
		rerender(<SchemaForm schema={schema} values={defaults(schema)} onChange={onChange} disabled />);
		expect(container.textContent).not.toContain('Generate');
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

	it('lays the settings out as grouped cards: x-ui.group makes the cards, x-ui.order sorts, the feature title heads them', () => {
		const schema = /** @type {any} */ ({
			type: 'object',
			properties: {
				late: { type: 'string', title: 'Late', default: '', 'x-ui': { group: 'Look', order: 2 } },
				early: { type: 'string', title: 'Early', default: '', 'x-ui': { group: 'Look', order: 1 } },
				plain: { type: 'boolean', title: 'Plain', default: false },
				limit: { type: 'integer', title: 'Limit', default: 3, 'x-ui': { group: 'Limits' } },
			},
		});
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} title="Notes" description="Off" />);
		expect(container.querySelector('h3')?.textContent).toBe('Notes');
		expect([...container.querySelectorAll('section h2')].map((h) => h.textContent)).toEqual(['Look', 'General', 'Limits']);
		const cards = [...container.querySelectorAll('section')];
		expect([...(cards[0]?.querySelectorAll('[data-field]') ?? [])].map((f) => f.getAttribute('data-field'))).toEqual([
			'early',
			'late',
		]);
		// a feature without groups is one card, titled with the feature
		const single = render(
			<Harness
				schema={{ type: 'object', properties: { a: { type: 'string', title: 'A', default: '' } } }}
				initial={{ a: '' }}
				title="Notes"
			/>,
		);
		expect(single.container.querySelectorAll('section')).toHaveLength(1);
		expect(single.container.querySelector('section h2')?.textContent).toBe('Notes');
		expect(single.container.querySelector('h3')).toBeNull();
	});

	it('picks a segmented control for a few short choices and radios for longer words', () => {
		const schema = /** @type {any} */ ({
			type: 'object',
			properties: {
				tone: { type: 'string', title: 'Tone', default: 'a', enum: ['a', 'b', 'c'] },
				mood: {
					type: 'string',
					title: 'Mood',
					default: 'x',
					enum: ['x', 'y'],
					'x-ui': { labels: { x: 'Quite a long answer to read', y: 'Another long answer here' } },
				},
			},
		});
		const onChange = vi.fn();
		const { container } = render(<Harness schema={schema} initial={defaults(schema)} onChange={onChange} />);
		const groups = [...container.querySelectorAll('[role="radiogroup"]')];
		expect(groups).toHaveLength(2);
		expect(groups[0]?.querySelectorAll('input[type="radio"]')).toHaveLength(3);
		expect(groups[0]?.querySelector('.rounded-control')).not.toBeNull();
		expect(groups[1]?.querySelector('.rounded-control')).toBeNull();
		click(/** @type {HTMLElement} */ (byLabel(container, 'C')));
		expect(onChange).toHaveBeenLastCalledWith('tone', 'c');
	});

	it('shows the Save changes bar with Discard only while something changed', () => {
		const schema = coupons();
		const onSave = vi.fn();
		const onDiscard = vi.fn();
		const view = render(
			<Harness schema={schema} initial={defaults(schema)} onSave={onSave} onDiscard={onDiscard} dirty={false} />,
		);
		expect(byTextButton(view.container, 'Save changes')).toBeUndefined();
		view.rerender(
			<Harness
				schema={schema}
				initial={defaults(schema)}
				onSave={onSave}
				onDiscard={onDiscard}
				dirty
				saveTexts={{ message: 'Unsaved', save: 'Save all', discard: 'Throw away' }}
			/>,
		);
		expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Unsaved');
		click(/** @type {HTMLElement} */ (byTextButton(view.container, 'Save all')));
		expect(onSave).toHaveBeenCalledTimes(1);
		click(/** @type {HTMLElement} */ (byTextButton(view.container, 'Throw away')));
		expect(onDiscard).toHaveBeenCalledTimes(1);
	});

	describe('advanced settings and many groups', () => {
		const many = () =>
			/** @type {any} */ ({
				type: 'object',
				properties: {
					name: { type: 'string', title: 'Shop name', default: '', 'x-ui': { group: 'Basics' } },
					email: { type: 'string', title: 'Sender email', default: '', 'x-ui': { group: 'Messages' } },
					limit: { type: 'integer', title: 'Daily limit', default: 5, 'x-ui': { group: 'Limits' } },
					timeout: { type: 'integer', title: 'Timeout seconds', default: 30, 'x-ui': { group: 'Limits', advanced: true } },
					salt: { type: 'string', title: 'Hash salt', default: 'x', 'x-ui': { group: 'Advanced' } },
				},
			});

		it('puts x-ui.advanced settings and an Advanced group in an open Advanced section after the cards, with its heading', () => {
			const schema = /** @type {any} */ ({
				type: 'object',
				properties: {
					name: { type: 'string', title: 'Shop name', default: '' },
					retries: { type: 'integer', title: 'Retries', default: 3, 'x-ui': { advanced: true } },
					salt: { type: 'string', title: 'Hash salt', default: 'x', 'x-ui': { group: 'Advanced' } },
				},
			});
			const { container } = render(<Harness schema={schema} initial={defaults(schema)} title="Mail" />);
			// no closed box: everything is on the page at once
			expect(container.querySelector('button[aria-expanded]')).toBeNull();
			for (const name of ['name', 'retries', 'salt']) expect(container.querySelector(`[data-field="${name}"]`)).not.toBeNull();
			const section = /** @type {HTMLElement} */ (container.querySelector('section[aria-labelledby$="-advanced-title"]'));
			expect(section.querySelector('h3')?.textContent).toBe('Advanced');
			expect(section.querySelector('[data-field="retries"]')).not.toBeNull();
			expect(section.querySelector('[data-field="name"]')).toBeNull();
			// it is the last thing of the form
			expect(container.firstElementChild?.lastElementChild).toBe(section);
			// a page that shows it apart leaves it out
			const apart = render(<Harness schema={schema} initial={defaults(schema)} title="Mail" withAdvanced={false} />);
			expect(apart.container.querySelector('[data-field="name"]')).not.toBeNull();
			expect(apart.container.querySelector('[data-field="retries"]')).toBeNull();
			expect(apart.container.textContent).not.toContain('Advanced');
		});

		it('shows the errors of the Advanced settings where they are', () => {
			const schema = many();
			const { container } = render(
				<Harness schema={schema} initial={defaults(schema)} tabs={false} errors={{ timeout: 'Too long.' }} />,
			);
			expect(container.querySelector('[data-field="timeout"]')?.textContent).toContain('Too long.');
		});

		it('shows one group at a time from three groups on, Advanced as the last tab', () => {
			const schema = many();
			const { container } = render(<Harness schema={schema} initial={defaults(schema)} tabs title="Mail" />);
			const tabs = allByRole(container, 'tab').map((tab) => tab.textContent);
			expect(tabs).toEqual(['Basics', 'Messages', 'Limits', 'Advanced']);
			expect(container.querySelector('[data-field="name"]')).not.toBeNull();
			expect(container.querySelector('[data-field="email"]')).toBeNull();
			click(/** @type {HTMLElement} */ (allByRole(container, 'tab')[2]));
			expect(container.querySelector('[data-field="limit"]')).not.toBeNull();
			expect(container.querySelector('[data-field="name"]')).toBeNull();
			expect(container.querySelector('[data-field="timeout"]')).toBeNull();
			click(/** @type {HTMLElement} */ (allByRole(container, 'tab')[3]));
			expect(container.querySelector('[data-field="timeout"]')).not.toBeNull();
			expect(container.querySelector('[data-field="salt"]')).not.toBeNull();
		});

		it('reads the shape of a form: its everyday groups in order, and whether it has an Advanced block', () => {
			expect(shapeOf(many())).toEqual({ groups: ['Basics', 'Messages', 'Limits'], advanced: true });
			expect(shapeOf(coupons()).advanced).toBe(false);
			expect(shapeOf(null)).toEqual({ groups: [], advanced: false });
		});

		it('shows only the group it is asked for (an inner sidebar lists the groups as sub-items)', () => {
			const schema = many();
			const { container } = render(<Harness schema={schema} initial={defaults(schema)} group="Messages" />);
			expect([...container.querySelectorAll('[data-field]')].map((f) => f.getAttribute('data-field'))).toEqual(['email']);
			const advanced = render(<Harness schema={schema} initial={defaults(schema)} group="Advanced" />);
			expect([...advanced.container.querySelectorAll('[data-field]')].map((f) => f.getAttribute('data-field')).sort()).toEqual(
				['salt', 'timeout'],
			);
		});
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
