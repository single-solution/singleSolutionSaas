// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { EntryGroup, Input, ListEditor } from '../src/index.js';
import { moveItem } from '../src/ListEditor.js';
import { vi } from 'vitest';
import { cleanup, click, render, type } from '../src/testing.js';

afterEach(() => cleanup());

/** @typedef {{ name: string }} Row */

/** @param {{ start: Row[], max?: number, seen: { rows: Row[] } }} props */
function Harness({ start, max, seen }) {
	const [rows, setRows] = useState(start);
	seen.rows = rows;
	return (
		<ListEditor
			legend="Payment methods"
			items={rows}
			onChange={setRows}
			newItem={() => ({ name: '' })}
			nameOf={(row, index) => row.name || `Row ${index + 1}`}
			{...(max === undefined ? {} : { max })}
			renderItem={(row, index, update) => (
				<Input label={`Name ${index + 1}`} value={row.name} onChange={(e) => update({ name: e.currentTarget.value })} />
			)}
		/>
	);
}

describe('ListEditor (the merchant-list pattern)', () => {
	it('moves a row in a copy and leaves the list alone out of range', () => {
		const list = ['a', 'b', 'c'];
		expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a']);
		expect(moveItem(list, 2, 1)).toEqual(['a', 'c', 'b']);
		expect(moveItem(list, 0, 3)).toEqual(['a', 'b', 'c']);
		expect(list).toEqual(['a', 'b', 'c']);
	});

	it('adds, renames, reorders and removes rows with buttons named by the row, up to the most', () => {
		const seen = { rows: /** @type {Row[]} */ ([]) };
		const { container } = render(<Harness start={[{ name: 'Cash' }, { name: 'Card' }]} max={3} seen={seen} />);
		const button = (/** @type {string} */ label) =>
			/** @type {HTMLButtonElement} */ (container.querySelector(`button[aria-label="${label}"]`));
		expect(container.querySelector('legend')?.textContent).toBe('Payment methods2');
		// the first row cannot go up, the last cannot go down
		expect(button('Move up: Cash').disabled).toBe(true);
		expect(button('Move down: Card').disabled).toBe(true);
		click(button('Move down: Cash'));
		expect(seen.rows.map((row) => row.name)).toEqual(['Card', 'Cash']);
		// add a row, then name it
		click(/** @type {HTMLButtonElement} */ ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Add')));
		expect(seen.rows).toEqual([{ name: 'Card' }, { name: 'Cash' }, { name: '' }]);
		type(/** @type {HTMLInputElement} */ (container.querySelectorAll('input')[2]), 'Wallet');
		expect(seen.rows[2]).toEqual({ name: 'Wallet' });
		// at the most rows Add is gone
		expect(container.textContent).toContain('At most 3.');
		click(button('Remove: Card'));
		expect(seen.rows.map((row) => row.name)).toEqual(['Cash', 'Wallet']);
		click(button('Remove: Cash'));
		click(button('Remove: Wallet'));
		expect(container.textContent).toContain('None yet.');
	});
});

describe('EntryGroup (one entry of an editor the caller lays out)', () => {
	it('is a hairline group with the entry name and Move up, Move down and Remove that call the caller', () => {
		const onMove = vi.fn();
		const onRemove = vi.fn();
		const { container } = render(
			<EntryGroup data-entry="" title="Zone 1" first texts={{ remove: 'Remove zone' }} onMove={onMove} onRemove={onRemove}>
				<p>Fields</p>
			</EntryGroup>,
		);
		const group = /** @type {HTMLElement} */ (container.firstElementChild);
		// a hairline box, never a hand-made grey one; the caller's data attribute lands on it
		expect(group.className).toContain('border-line');
		expect(group.hasAttribute('data-entry')).toBe(true);
		expect(container.textContent).toContain('Zone 1');
		expect(container.textContent).toContain('Fields');
		const button = (/** @type {string} */ name) =>
			/** @type {HTMLButtonElement} */ (
				[...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)
			);
		// the first entry cannot go up
		expect(button('Move up').disabled).toBe(true);
		click(button('Move down'));
		expect(onMove).toHaveBeenCalledWith(1);
		click(button('Remove zone'));
		expect(onRemove).toHaveBeenCalledTimes(1);
	});

	it('has no head without a name or actions, and collapses under a summary when given one', () => {
		const plain = render(
			<EntryGroup compact>
				<p>Only fields</p>
			</EntryGroup>,
		);
		expect(plain.container.querySelector('button')).toBeNull();
		expect(/** @type {HTMLElement} */ (plain.container.firstElementChild).className).toContain('pt-3');
		cleanup();
		const folded = render(
			<EntryGroup summary="Shopper words">
				<p>Inside</p>
			</EntryGroup>,
		);
		const details = /** @type {HTMLDetailsElement} */ (folded.container.querySelector('details'));
		expect(details.open).toBe(false);
		expect(details.querySelector('summary')?.textContent).toBe('Shopper words');
	});
});
