import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: screens are built from the kit's parts only (see "How to build a screen" in the README). A screen never draws
 * a table (`DataTable`, `Table`, raw `<table>`), a closed box (`Disclosure`), small tabs (`PillTabs`) or a raw form field
 * (`<select>`, `<input>`, `<textarea>`). All screens in the repository are clean; any new offender fails this test immediately.
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

describe('kit only: screens are built from the kit', () => {
	it('finds the screens', () => {
		// a wrong folder would make the guard pass on nothing
		expect(SCREEN_FOLDERS.length).toBeGreaterThan(2);
		expect(jsFiles(path.join(ROOT, 'platform/src')).length).toBeGreaterThan(20);
	});

	it('no screen in the repository draws a banned component or raw field', () => {
		const problems = [];
		for (const [file, uses] of found) {
			problems.push(
				`${file} uses ${uses.join(', ')}: use Row/ListColumn/Card/the kit fields instead (see packages/ui/README.md, "How to build a screen")`,
			);
		}
		expect(problems).toEqual([]);
		expect([...found.entries()]).toEqual([]);
	});

	it('K-1e: allows FiguresTable while refusing DataTable, Table and raw <table>', () => {
		expect(BANNED_IMPORTS).toContain('DataTable');
		expect(BANNED_IMPORTS).toContain('Table');
		expect(BANNED_IMPORTS).not.toContain('FiguresTable');
		expect(BANNED_TAGS).toContain('<table');
		expect(offences("import { FiguresTable } from '@ss/ui';\nexport const x = <FiguresTable />;")).toEqual([]);
		expect(offences("import { DataTable } from '@ss/ui';\nexport const x = <DataTable />;")).toEqual(['DataTable']);
		expect(offences('export const x = <table><tbody /></table>;')).toEqual(['<table']);
		expect(offences('export const x = <select><option /></select>;')).toEqual(['<select']);
		expect(offences('export const x = <input type="text" />;')).toEqual(['<input']);
		expect(offences('export const x = <textarea />;')).toEqual(['<textarea']);
		expect(offences("import { Disclosure, PillTabs } from '@ss/ui';")).toEqual(['Disclosure', 'PillTabs']);
	});
});
