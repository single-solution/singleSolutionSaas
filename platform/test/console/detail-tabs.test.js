// @vitest-environment jsdom
/**
 * The tab strip of a detail beside a list (merchant, product, admin): one part at a time, the choice kept in the address
 * hash, a part kept once opened, and a hash that names no tab leaves the choice alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@ss/ui/testing';
import { DetailTabs } from '../../src/console/views/common.js';
import { openTab, resetHash } from './merchant-harness.js';

afterEach(() => {
	cleanup();
	resetHash();
});

/** @param {string} id */
const panel = (id) => document.getElementById(`dt-panel-${id}`);

describe('DetailTabs', () => {
	it('shows one part at a time, mounts a part when first opened, keeps it, and writes the hash', async () => {
		render(
			<DetailTabs
				label="Parts"
				tabs={[
					{ id: 'one', label: 'One', content: <p>first part</p> },
					{ id: 'two', label: 'Two · 2', content: <p>second part</p> },
					{ id: 'three', label: 'Three', content: <p>third part</p> },
				]}
			/>,
		);
		expect(panel('one')?.hidden).toBe(false);
		expect(panel('two')).toBeNull(); // not opened yet: not on the page
		await openTab('Two');
		expect(window.location.hash).toBe('#two');
		expect(panel('two')?.hidden).toBe(false);
		expect(panel('one')?.hidden).toBe(true); // kept, hidden
		expect(panel('three')).toBeNull();
		expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Two · 2');
		expect(panel('two')?.getAttribute('aria-labelledby')).toBe('dt-tab-two');
	});

	it('opens the part the hash names, and leaves the choice alone for a hash that names none', async () => {
		window.history.replaceState(null, '', '#three');
		render(
			<DetailTabs
				label="Parts"
				tabs={[
					{ id: 'one', label: 'One', content: <p>first part</p> },
					{ id: 'three', label: 'Three', content: <p>third part</p> },
				]}
			/>,
		);
		await act(async () => {});
		expect(panel('three')?.hidden).toBe(false);
		await act(async () => {
			window.history.replaceState(null, '', '#website-web_1');
			window.dispatchEvent(new HashChangeEvent('hashchange'));
		});
		expect(panel('three')?.hidden).toBe(false);
	});
});
