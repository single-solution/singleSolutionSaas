/**
 * No leftovers of the old layout in the shared product dashboard (layout contract 2026-10-17, R2, R3, R5, R10): the
 * dashboard's files draw their pages with `Page`, their sub-pages with `InnerNav` and their lists with `DataTable` or
 * the overview blocks, so none of them names the old page header, title, section layout or row lists any more.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The files of the shared dashboard. */
const FILES = ['overview.js'];

/** The old pieces (LY-4 deletes them): none of these words may appear in a dashboard file. */
const OLD = [
	'PageHeader',
	'HeaderFact',
	'ViewTitle',
	'SectionLayout',
	'SectionNav',
	'PillTabs',
	'LinkTabs',
	'RowList',
	'ListRow',
];

describe('the shared dashboard files', () => {
	for (const file of FILES)
		it(`${file} uses none of the old layout pieces`, () => {
			const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
			const found = OLD.filter((name) => new RegExp(`\\b${name}\\b`).test(source));
			expect(found).toEqual([]);
		});
});
