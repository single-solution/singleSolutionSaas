import path from 'node:path';
import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createEslintConfig, FUNCTIONAL_RULES, IGNORES, jsxConfig } from '../eslint.js';
import * as mongoSetup from '../mongo-setup.js';
import { defineUnitConfig, folderPattern, MONGO_SETUP, THRESHOLDS, UI_SOURCES } from '../vitest.js';

const DIR = path.resolve('/repo/unit');

describe('eslint config', () => {
	it('applies the functional rules and ignores build output', () => {
		const config = createEslintConfig();
		expect(config[0]).toEqual({ ignores: [...IGNORES] });
		expect(config.find((entry) => entry.files?.includes('**/*.js'))?.rules).toEqual(FUNCTIONAL_RULES);
		expect(config.at(-1)?.rules).toEqual({ 'no-param-reassign': 'off' });
		expect(config).toHaveLength(4);
	});

	it('adds server and browser JSX variants and extra ignores', () => {
		const config = createEslintConfig({ jsx: ['app/**/*.js'], browserJsx: ['ui/**/*.js'], ignores: ['out/**'] });
		expect(config[0]?.ignores).toContain('out/**');
		expect(config).toHaveLength(6);
		expect(config[3]).toEqual(jsxConfig(['app/**/*.js']));
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
		expect(config.test?.coverage).toMatchObject({ provider: 'v8', include: ['src/**'], exclude: [], thresholds: THRESHOLDS });
		expect(config.esbuild && config.esbuild.include).toEqual([UI_SOURCES]);
	});

	it('adds JSX folders, the Mongo setup and custom scopes', () => {
		const config = defineUnitConfig({
			dir: DIR,
			name: 'custom',
			include: ['tests/**/*.test.js'],
			coverageInclude: ['core/**'],
			coverageExclude: ['core/gen.js'],
			jsx: ['src/console'],
			mongo: true,
			thresholds: { lines: 1, functions: 1, branches: 1 },
		});
		expect(config.test?.name).toBe('custom');
		expect(config.test?.globalSetup).toEqual([MONGO_SETUP]);
		expect(config.test?.coverage).toMatchObject({ include: ['core/**'], exclude: ['core/gen.js'], thresholds: { lines: 1 } });
		const include = /** @type {RegExp[]} */ (config.esbuild && config.esbuild.include);
		expect(include[1]?.test(path.join(DIR, 'src/console/page.js'))).toBe(true);
		expect(include[1]?.test(path.join(DIR, 'src/other.js'))).toBe(false);
	});

	it('matches @ss/ui sources from the workspace and from node_modules', () => {
		expect(UI_SOURCES.test('/repo/packages/ui/src/index.js')).toBe(true);
		expect(UI_SOURCES.test('/app/node_modules/.pnpm/x/node_modules/@ss/ui/src/schema.js')).toBe(true);
		expect(UI_SOURCES.test('/repo/packages/web/src/index.js')).toBe(false);
		expect(folderPattern(DIR, ['a.b']).test(path.join(DIR, 'aXb/x.js'))).toBe(false);
	});
});

describe('mongo global setup', () => {
	it('provides a replica set for the run (SS_TEST_MONGO_URI)', async () => {
		const uri = process.env.SS_TEST_MONGO_URI;
		expect(uri).toMatch(/^mongodb:\/\//);
		const client = await new MongoClient(/** @type {string} */ (uri)).connect();
		try {
			const hello = await client.db('admin').command({ hello: 1 });
			expect(hello.setName).toBeTruthy();
		} finally {
			await client.close();
		}
	});

	it('shares one replica set between setups, stops it after the last teardown and defers to an outer URI', async () => {
		const outer = process.env.SS_TEST_MONGO_URI;
		await mongoSetup.setup();
		expect(process.env.SS_TEST_MONGO_URI).toBe(outer);
		await mongoSetup.teardown();
		delete process.env.SS_TEST_MONGO_URI;
		try {
			await Promise.all([mongoSetup.setup(), mongoSetup.setup()]);
			const own = process.env.SS_TEST_MONGO_URI;
			expect(own).toMatch(/^mongodb:\/\//);
			expect(own).not.toBe(outer);
			await mongoSetup.teardown();
			expect(process.env.SS_TEST_MONGO_URI).toBe(own);
			await mongoSetup.teardown();
			expect(process.env.SS_TEST_MONGO_URI).toBeUndefined();
			await mongoSetup.teardown();
		} finally {
			process.env.SS_TEST_MONGO_URI = outer;
		}
	}, 120_000);
});
