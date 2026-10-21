import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIT_ONLY_TODO } from './kit-only-todo.js';

/**
 * Guard: screens are built from the kit's parts only (see "How to build a screen" in the README). A screen never draws
 * a table, a closed box (`Disclosure`), small tabs (`PillTabs`) or a raw form field. The files that still do are in
 * `kit-only-todo.js`; the list may only shrink: a new offender fails, and so does a listed file that has been cleaned.
 */

/** The repository root. */
const ROOT = path.resolve(import.meta.dirname, '../../..');

/** Folders with screens, from the repository root (`products/*` is expanded to every product's `app`). */
const SCREEN_FOLDERS = [
	'platform/src',
	'platform/app',
	...readdirSync(path.join(ROOT, 'products')).map((p) => `products/${p}/app`),
];

/** Folders that are never screens. */
const SKIPPED = new Set(['test', 'tests', '__tests__', 'node_modules', '.next', 'coverage']);

/** Kit parts a screen does not use any more, found by their import from `@ss/ui` (or `@ss/ui/dashboard`, …). */
const BANNED_IMPORTS = ['DataTable', 'Table', 'Disclosure', 'PillTabs'];

/** Raw HTML a screen does not write, found as JSX tags. */
const BANNED_TAGS = ['<table', '<select', '<input', '<textarea'];

/** Every kind a file can be listed for, in the order `uses` is written. */
const KINDS = [...BANNED_IMPORTS, ...BANNED_TAGS];

const IMPORT_FROM_KIT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@ss\/ui(?:\/[^'"]*)?['"]/g;
const RAW_TAG = /<(table|select|input|textarea)(?=[\s/>])/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|\s)\/\/.*$/gm;

/**
 * The `.js` files of a folder, below any depth, without tests and build output.
 * @param {string} dir absolute folder
 * @param {string[]} [found]
 * @returns {string[]}
 */
const jsFiles = (dir, found = []) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED.has(entry.name)) jsFiles(full, found);
		} else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) found.push(full);
	}
	return found;
};

/**
 * What a file uses that a screen must not.
 * @param {string} source the file's text
 * @returns {string[]} kinds from `KINDS`, in that order
 */
const offences = (source) => {
	const code = source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1');
	/** @type {Set<string>} */
	const used = new Set();
	for (const [, names = ''] of code.matchAll(IMPORT_FROM_KIT)) {
		for (const name of names.split(',')) {
			const exported = name.trim().split(/\s+/)[0] ?? '';
			if (BANNED_IMPORTS.includes(exported)) used.add(exported);
		}
	}
	for (const [, tag = ''] of code.matchAll(RAW_TAG)) used.add(`<${tag}`);
	return KINDS.filter((kind) => used.has(kind));
};

/** Today's offenders: repository path (with `/`) → the kinds it uses. */
const found = new Map(
	SCREEN_FOLDERS.flatMap((folder) => {
		try {
			return jsFiles(path.join(ROOT, folder));
		} catch {
			return []; // a product without an `app` folder
		}
	})
		.map(
			(file) =>
				/** @type {[string, string[]]} */ ([
					path.relative(ROOT, file).split(path.sep).join('/'),
					offences(readFileSync(file, 'utf8')),
				]),
		)
		.filter(([, uses]) => uses.length > 0),
);

const todo = new Map(KIT_ONLY_TODO.map((entry) => [entry.file, entry.uses]));

describe('kit only: screens are built from the kit', () => {
	it('finds the screens', () => {
		// a wrong folder would make the guard pass on nothing
		expect(SCREEN_FOLDERS.length).toBeGreaterThan(2);
		expect(jsFiles(path.join(ROOT, 'platform/src')).length).toBeGreaterThan(20);
	});

	it('no file outside the todo list draws a table, a closed box, small tabs or a raw field', () => {
		const problems = [];
		for (const [file, uses] of found) {
			const listed = todo.get(file) ?? [];
			const added = uses.filter((kind) => !listed.includes(kind));
			if (added.length > 0)
				problems.push(
					`${file} uses ${added.join(', ')}: use Row/ListColumn/Card/the kit fields instead (see packages/ui/README.md, "How to build a screen")`,
				);
		}
		expect(problems).toEqual([]);
	});

	it('every file in the todo list still uses what it lists', () => {
		const problems = [];
		for (const { file, uses } of KIT_ONLY_TODO) {
			const now = found.get(file);
			if (!now) problems.push(`${file} no longer uses anything banned: remove it from kit-only-todo.js`);
			else {
				const gone = uses.filter((kind) => !now.includes(kind));
				if (gone.length > 0)
					problems.push(`${file} no longer uses ${gone.join(', ')}: remove that from its uses in kit-only-todo.js`);
			}
		}
		expect(problems).toEqual([]);
	});

	it('the todo list is sorted, has each file once and names known kinds', () => {
		const files = KIT_ONLY_TODO.map((entry) => entry.file);
		expect(files).toEqual([...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
		for (const { file, uses } of KIT_ONLY_TODO) {
			expect(uses.length, file).toBeGreaterThan(0);
			expect(
				uses.filter((kind) => !KINDS.includes(kind)),
				file,
			).toEqual([]);
			expect(uses, file).toEqual(KINDS.filter((kind) => uses.includes(kind)));
		}
	});
});
