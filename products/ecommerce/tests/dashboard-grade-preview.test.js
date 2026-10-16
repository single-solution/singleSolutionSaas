// @vitest-environment jsdom
/**
 * The condition grade dialog shows the grade's glossary page as a search result and a share card (R7 #105), with the
 * title pattern, the grade patterns and the fallbacks the server uses, redrawn as the merchant types.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { GradesEditor } from '../app/dashboard/grades.js';

const WEBSITE = 'web_1';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('a grade’s search result and share preview', () => {
	it('fills the title pattern and falls back as the glossary page does', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 })),
		);
		const { container } = render(
			<GradesEditor
				websiteId={WEBSITE}
				preview={{
					titleTemplate: '{name} | {business}',
					siteName: 'Northwind',
					defaultDescription: 'Phones and more.',
					defaultImage: 'https://cdn.example/share.png',
					gradeTitle: '{name} condition',
					gradeDescription: '',
				}}
			/>,
		);
		await settle();
		await act(async () => click(byText(container, 'Add grade', 'button')));
		const dialog = document.body;
		type(byLabel(dialog, 'Name'), 'Grade A');
		const title = () => dialog.querySelector('[data-part="result"] .ss-seo-title')?.textContent;
		const text = () => dialog.querySelector('[data-part="result"] .ss-seo-text')?.textContent;
		await settle();
		expect(title()).toBe('Grade A condition | Northwind');
		expect(text()).toBe('Phones and more.');
		expect(dialog.querySelector('[data-part="card"] img')?.getAttribute('src')).toBe('https://cdn.example/share.png');
		type(byLabel(dialog, 'Text of the page'), 'Like new, with no marks.');
		await settle();
		expect(text()).toBe('Like new, with no marks.');
		type(byLabel(dialog, 'Title'), 'Grade A phones');
		// the SEO description: the second field named Description (the first is the grade's own)
		const seoDescription = /** @type {HTMLLabelElement} */ (
			[...dialog.querySelectorAll('label')].filter((label) => label.textContent?.startsWith('Description'))[1]
		);
		type(/** @type {HTMLElement} */ (document.getElementById(seoDescription.htmlFor)), 'Tested and like new.');
		await settle();
		expect(title()).toBe('Grade A phones | Northwind');
		expect(text()).toBe('Tested and like new.');
	});
});
