// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SchemaForm } from '../src/SchemaForm.js';
import { act, byLabel, click, cleanup, render, type } from '../src/testing.js';

afterEach(cleanup);

const schema = /** @type {any} */ ({
	type: 'object',
	properties: {
		reasons: { type: 'array', title: 'Reasons', default: [], items: { type: 'string' } },
		sizes: { type: 'array', title: 'Sizes', default: [], items: { type: 'integer' } },
		flags: { type: 'array', title: 'Flags', default: [], items: { type: 'boolean' } },
	},
});

/** @param {Element} el */
const blur = (el) =>
	act(() => {
		el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
	});

/**
 * A controlled form with the buttons an outside change comes from.
 * @param {{ initial?: Record<string, unknown>, onChange?: (name: string, value: unknown) => void, onSave?: () => void } & Record<string, any>} props
 */
function Harness({ initial = {}, onChange, onSave, ...rest }) {
	const [values, setValues] = useState(
		/** @type {Record<string, unknown>} */ ({ reasons: [], sizes: [], flags: [], ...initial }),
	);
	return (
		<>
			<button type="button" onClick={() => setValues({ reasons: ['Kept'], sizes: [], flags: [true] })}>
				Reload
			</button>
			<SchemaForm
				schema={schema}
				values={values}
				tabs={false}
				onChange={(name, value) => {
					onChange?.(name, value);
					setValues((all) => ({ ...all, [name]: value }));
				}}
				dirty
				{...(onSave ? { onSave, onDiscard: () => undefined } : {})}
				{...rest}
			/>
		</>
	);
}

describe('"one per line" lists keep what is typed while typing (188)', () => {
	it('keeps a space at the end of a line and a new empty line while the box is being typed in', () => {
		const onChange = vi.fn();
		const { container } = render(<Harness onChange={onChange} />);
		const box = byLabel(container, 'Reasons');
		type(box, 'Wrong ');
		expect(box.value).toBe('Wrong ');
		type(box, 'Wrong size');
		expect(box.value).toBe('Wrong size');
		type(box, 'Wrong size\n');
		expect(box.value).toBe('Wrong size\n');
		type(box, 'Wrong size\nToo big');
		expect(box.value).toBe('Wrong size\nToo big');
		// what the form holds is always the clean list, so Save needs no extra step
		expect(onChange).toHaveBeenLastCalledWith('reasons', ['Wrong size', 'Too big']);
	});

	it('turns the text into the clean list when the box loses focus', () => {
		const { container } = render(<Harness />);
		const box = byLabel(container, 'Reasons');
		type(box, '  Wrong size \n\n  Too big\n');
		expect(box.value).toBe('  Wrong size \n\n  Too big\n');
		blur(box);
		expect(box.value).toBe('Wrong size\nToo big');
	});

	it('shows the new list when the value changes from outside while the box keeps its raw text', () => {
		const { container } = render(<Harness />);
		const box = byLabel(container, 'Reasons');
		type(box, 'Typed \n');
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload')));
		expect(box.value).toBe('Kept');
	});

	it('keeps typing in a list of numbers working too', () => {
		const onChange = vi.fn();
		const { container } = render(<Harness onChange={onChange} />);
		const box = byLabel(container, 'Sizes');
		type(box, '10\n');
		expect(box.value).toBe('10\n');
		type(box, '10\n20');
		expect(onChange).toHaveBeenLastCalledWith('sizes', [10, 20]);
	});
});

describe('the raw JSON box (189)', () => {
	it('shows the new value when it changes from outside (Discard, reload)', () => {
		const { container } = render(<Harness />);
		const box = byLabel(container, 'Flags');
		type(box, '[false, false]');
		expect(box.value).toBe('[false, false]');
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload')));
		expect(JSON.parse(box.value)).toEqual([true]);
	});

	it('keeps the typed layout while the JSON is valid', () => {
		const { container } = render(<Harness />);
		const box = byLabel(container, 'Flags');
		type(box, '[true,false]');
		expect(box.value).toBe('[true,false]');
	});

	it('says why under the box and turns Save off while the JSON is not valid', () => {
		const onSave = vi.fn();
		const { container } = render(<Harness onSave={onSave} />);
		const box = byLabel(container, 'Flags');
		type(box, '[oops');
		expect(box.value).toBe('[oops');
		expect(container.textContent).toContain('Enter valid JSON.');
		const save = /** @type {HTMLButtonElement} */ (
			[...container.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')
		);
		expect(save.disabled).toBe(true);
		type(box, '[true]');
		expect(container.textContent).not.toContain('Enter valid JSON.');
		expect(
			/** @type {HTMLButtonElement} */ (
				[...container.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')
			).disabled,
		).toBe(false);
	});

	it('words the reason from the texts it is given', () => {
		const { container } = render(<Harness invalidJsonText="Not valid JSON." />);
		type(byLabel(container, 'Flags'), '[oops');
		expect(container.textContent).toContain('Not valid JSON.');
	});
});
