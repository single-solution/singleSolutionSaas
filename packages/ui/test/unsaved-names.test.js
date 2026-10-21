// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InnerNav } from '../src/InnerNav.js';
import { Page } from '../src/Page.js';
import { Row } from '../src/Row.js';
import { SaveBar } from '../src/index.js';
import { cleanup, click, render } from '../src/testing.js';

beforeEach(() => {
	HTMLElement.prototype.scrollTo = /** @type {any} */ (vi.fn());
});
afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
	window.history.replaceState(null, '', '/');
});

const crumbs = [{ label: 'Settings' }];

/**
 * A page of sections named A, B, C, D; those whose id is in `dirty` have changes.
 * @param {string[]} dirty
 * @param {string[]} [ids]
 * @param {Partial<import('react').ComponentProps<typeof Page>>} [extra]
 */
const page = (dirty, ids = ['a', 'b', 'c', 'd'], extra = {}) => (
	<Page
		crumbs={crumbs}
		sections={ids.map((id) => ({
			id,
			label: id.toUpperCase(),
			body: <SaveBar show={dirty.includes(id)} onSave={() => {}} onDiscard={() => {}} />,
		}))}
		{...extra}
	/>
);

/** @param {ParentNode} root */
const status = (root) => /** @type {HTMLElement} */ (root.querySelector('[role="status"]'));
/** @param {ParentNode} root */
const marks = (root) => [...root.querySelectorAll('[data-ss-nav-item]')].filter((el) => el.querySelector('[data-ss-changed]'));

describe('the save bar names every section with changes (115)', () => {
	it('says "Unsaved changes in B, D", in the order of the page, each name a button', () => {
		const { container } = render(page(['d', 'b']));
		expect(status(container).textContent).toBe('Unsaved changes in B, D');
		const names = [...status(container).querySelectorAll('button')].map((b) => b.textContent);
		expect(names).toEqual(['B', 'D']);
	});

	it('names the sections on a page without inner navigation too, and follows the changes', () => {
		const { container, rerender } = render(page(['c'], ['a', 'b', 'c']));
		expect(status(container).textContent).toBe('Unsaved changes in C');
		rerender(page(['a', 'c'], ['a', 'b', 'c']));
		expect(status(container).textContent).toBe('Unsaved changes in A, C');
	});

	it('a click on a name scrolls to its section and puts it in the address', () => {
		const { container } = render(page(['b', 'd']));
		click(/** @type {HTMLElement} */ ([...status(container).querySelectorAll('button')].find((b) => b.textContent === 'D')));
		expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
		expect(window.location.hash).toBe('#d');
	});

	it('says its words from the texts it is given', () => {
		const { container } = render(page(['a'], ['a', 'b'], { texts: { changedIn: 'Edits in' } }));
		expect(status(container).textContent).toBe('Edits in A');
	});
});

describe('every section with changes carries a "changed" mark (254)', () => {
	it('marks the changed sections in the inner navigation with a word, not only a colour', () => {
		const { container, rerender } = render(page(['b', 'd']));
		expect(marks(container).map((el) => el.getAttribute('data-ss-nav-item'))).toEqual(['b', 'd']);
		const mark = /** @type {HTMLElement} */ (container.querySelector('[data-ss-nav-item="b"] [data-ss-changed]'));
		expect(mark.textContent).toBe('Changed');
		rerender(page([]));
		expect(marks(container)).toHaveLength(0);
	});

	it('marks the section itself in the body', () => {
		const { container } = render(page(['c']));
		const found = [...container.querySelectorAll('section[data-ss-section]')].filter((el) => el.hasAttribute('data-changed'));
		expect(found.map((el) => el.id)).toEqual(['c']);
	});

	it('marks the items of a navigation the page was given, by the id of the section', () => {
		const nav = {
			groups: [
				{ label: 'One', items: [{ id: 'a', label: 'A' }] },
				{ label: 'Two', items: [{ id: 'b', label: 'B' }] },
			],
			value: 'a',
		};
		const { container } = render(page(['b'], ['a', 'b'], { nav }));
		expect(marks(container).map((el) => el.getAttribute('data-ss-nav-item'))).toEqual(['b']);
	});

	it('an inner navigation item says it has changes by itself, in the words it is given', () => {
		const { container } = render(
			<InnerNav
				value="a"
				items={[
					{ id: 'a', label: 'A', changed: true },
					{ id: 'b', label: 'B' },
				]}
				texts={{ changed: 'Edited' }}
			/>,
		);
		expect(marks(container).map((el) => el.getAttribute('data-ss-nav-item'))).toEqual(['a']);
		expect(container.querySelector('[data-ss-changed]')?.textContent).toBe('Edited');
	});

	it('a row says it has changes with a word beside its title', () => {
		const { container } = render(
			<>
				<Row title="First" changed />
				<Row title="Second" />
				<Row title="Third" changed texts={{ changed: 'Edited' }} />
			</>,
		);
		const rows = [...container.querySelectorAll('[data-ss-row]')];
		expect(rows.map((row) => row.querySelector('[data-ss-changed]')?.textContent ?? null)).toEqual(['Changed', null, 'Edited']);
	});
});
