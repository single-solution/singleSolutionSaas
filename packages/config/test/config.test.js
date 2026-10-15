import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createEslintConfig } from '../eslint.js';
import * as mongoSetup from '../mongo-setup.js';
import { defineUnitConfig } from '../vitest.js';

const DIR = path.resolve('/repo/unit');
/** The coverage standard (README). */
const THRESHOLDS = { lines: 90, functions: 90, branches: 85 };
const MONGO_SETUP = fileURLToPath(new URL('../mongo-setup.js', import.meta.url));

describe('eslint config', () => {
	it('applies the functional rules and ignores build output', () => {
		const config = createEslintConfig();
		expect(config[0]).toEqual({ ignores: ['**/node_modules/**', '**/.next/**', '**/coverage/**'] });
		const rules = config.find((entry) => entry.files?.includes('**/*.js'))?.rules ?? {};
		expect(Object.keys(rules).sort()).toEqual(
			['eqeqeq', 'no-console', 'no-param-reassign', 'no-restricted-syntax', 'no-var', 'prefer-const'].sort(),
		);
		expect(JSON.stringify(rules['no-restricted-syntax'])).toContain('ClassDeclaration');
		expect(config.at(-1)?.rules).toEqual({ 'no-param-reassign': 'off' });
		expect(config).toHaveLength(4);
	});

	it('adds server and browser JSX variants and extra ignores', () => {
		const config = createEslintConfig({ jsx: ['app/**/*.js'], browserJsx: ['ui/**/*.js'], ignores: ['out/**'] });
		expect(config[0]?.ignores).toContain('out/**');
		expect(config).toHaveLength(6);
		expect(config[3]?.files).toEqual(['app/**/*.js']);
		expect(config[3]?.rules).toEqual({
			'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z]', ignoreRestSiblings: true }],
		});
		expect(config[3]?.languageOptions?.globals).toBeUndefined();
		expect(config[4]?.languageOptions?.globals).toHaveProperty('document');
		expect(config[4]?.languageOptions?.parserOptions).toEqual({ ecmaFeatures: { jsx: true } });
	});
});

describe('vitest preset', () => {
	it('defaults to plain node tests over src with the standard thresholds', () => {
		const config = defineUnitConfig({ dir: DIR });
		expect(config.root).toBe(DIR);
		expect(config.test?.name).toBe('unit');
		expect(config.test?.include).toEqual(['test/**/*.test.js']);
		expect(config.test?.globalSetup).toEqual([]);
		expect(config.test?.coverage).toMatchObject({ provider: 'v8', include: ['src/**'], thresholds: THRESHOLDS });
		expect(config.esbuild && /** @type {RegExp[]} */ (config.esbuild.include)).toHaveLength(1);
	});

	it('adds JSX folders, the Mongo setup and custom scopes', () => {
		const config = defineUnitConfig({
			dir: DIR,
			include: ['tests/**/*.test.js'],
			coverageInclude: ['core/**'],
			jsx: ['src/console'],
			mongo: true,
		});
		expect(config.test?.include).toEqual(['tests/**/*.test.js']);
		expect(config.test?.globalSetup).toEqual([MONGO_SETUP]);
		expect(config.test?.coverage).toMatchObject({ include: ['core/**'], thresholds: THRESHOLDS });
		const include = /** @type {RegExp[]} */ (config.esbuild && config.esbuild.include);
		expect(include[1]?.test(path.join(DIR, 'src/console/page.js'))).toBe(true);
		expect(include[1]?.test(path.join(DIR, 'src/other.js'))).toBe(false);
	});

	it('matches @ss/ui sources from the workspace and from node_modules', () => {
		const config = defineUnitConfig({ dir: DIR, jsx: ['a.b'] });
		const [ui, folders] = /** @type {RegExp[]} */ (config.esbuild && config.esbuild.include);
		expect(ui?.test('/repo/packages/ui/src/index.js')).toBe(true);
		expect(ui?.test('/app/node_modules/.pnpm/x/node_modules/@ss/ui/src/schema.js')).toBe(true);
		expect(ui?.test('/repo/packages/web/src/index.js')).toBe(false);
		// a folder name is matched as written (a dot is not any character)
		expect(folders?.test(path.join(DIR, 'a.b/x.js'))).toBe(true);
		expect(folders?.test(path.join(DIR, 'aXb/x.js'))).toBe(false);
	});
});

describe('mongo global setup', () => {
	it('provides a replica set for the run (TEST_MONGODB_URI)', async () => {
		const uri = process.env.TEST_MONGODB_URI;
		expect(uri).toMatch(/^mongodb:\/\//);
		const client = await new MongoClient(/** @type {string} */ (uri)).connect();
		try {
			const hello = await client.db('admin').command({ hello: 1 });
			expect(hello.setName).toBeTruthy();
		} finally {
			await client.close();
		}
	});

	it('starts its own replica set and stops it at teardown', async () => {
		const outer = process.env.TEST_MONGODB_URI;
		try {
			const teardown = await mongoSetup.setup();
			const own = /** @type {string} */ (process.env.TEST_MONGODB_URI);
			expect(own).toMatch(/^mongodb:\/\//);
			expect(own).not.toBe(outer);
			const client = await new MongoClient(own, { directConnection: true }).connect();
			try {
				const { config } = await client.db('admin').command({ replSetGetConfig: 1 });
				expect(config.writeConcernMajorityJournalDefault).toBe(false);
			} finally {
				await client.close();
			}
			await teardown();
			expect(process.env.TEST_MONGODB_URI).toBeUndefined();
		} finally {
			process.env.TEST_MONGODB_URI = outer;
		}
	}, 120_000);
});
