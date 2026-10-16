// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Paged } from '../src/paged.js';
import { byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(cleanup);

const names = Array.from({ length: 25 }, (_, i) => `Item ${String(i + 1).padStart(2, '0')}`);

/** @param {string[]} items @param {Record<string, unknown>} [props] */
const list = (items, props = {}) => (
	<Paged items={items} text={(item) => item} {...props}>
		{(page) => (
			<ul>
				{page.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		)}
	</Paged>
);

const shown = (/** @type {HTMLElement} */ container) => [...container.querySelectorAll('li')].map((li) => li.textContent);

describe('Paged', () => {
	it('shows one page at a time with Previous and Next', () => {
		const { container } = render(list(names, { pageSize: 10 }));
		expect(shown(container)).toHaveLength(10);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing 1–10 of 25');
		const previous = byText(container, 'Previous', 'button');
		const next = byText(container, 'Next', 'button');
		expect(/** @type {HTMLButtonElement} */ (previous).disabled).toBe(true);
		click(next);
		expect(shown(container)[0]).toBe('Item 11');
		click(next);
		expect(shown(container)).toEqual(['Item 21', 'Item 22', 'Item 23', 'Item 24', 'Item 25']);
		expect(/** @type {HTMLButtonElement} */ (next).disabled).toBe(true);
		click(previous);
		expect(shown(container)[0]).toBe('Item 11');
	});

	it('searches the whole list, starts again at the first page, and says when nothing matches', () => {
		const { container } = render(list(names, { pageSize: 10 }));
		click(byText(container, 'Next', 'button'));
		const search = /** @type {HTMLInputElement} */ (container.querySelector('input[type="search"]'));
		type(search, 'item 2');
		expect(shown(container)).toHaveLength(6);
		expect(shown(container)[0]).toBe('Item 20');
		expect(container.querySelector('nav')).toBeNull();
		type(search, 'zzz');
		expect(container.textContent).toContain('Nothing matches.');
	});

	it('shows no search box or pager for a short list', () => {
		const { container } = render(list(names.slice(0, 5)));
		expect(container.querySelector('input')).toBeNull();
		expect(container.querySelector('nav')).toBeNull();
		expect(shown(container)).toHaveLength(5);
	});
});
