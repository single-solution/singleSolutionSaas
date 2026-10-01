/**
 * Shared ESLint flat config: the functional-core rules every unit follows (no classes, no `console`, no mutation of
 * inputs, strict equality), plus a JSX variant for React components written in `.js` files.
 *
 *   import { createEslintConfig } from '@ss/config/eslint';
 *   export default createEslintConfig({ jsx: ['app/**\/*.js'], browserJsx: ['src/console/**\/*.js'] });
 * @module
 */
import js from '@eslint/js';
import globals from 'globals';

/** Output folders no unit lints. */
export const IGNORES = Object.freeze(['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**']);

/** Functional style: factories and plain objects only. */
export const FUNCTIONAL_RULES = /** @type {Readonly<import('eslint').Linter.RulesRecord>} */ ({
	'no-restricted-syntax': [
		'error',
		{ selector: 'ClassDeclaration', message: 'Functional style: use factory functions, not classes.' },
		{ selector: 'ClassExpression', message: 'Functional style: use factory functions, not classes.' },
	],
	'no-var': 'error',
	'prefer-const': 'error',
	'no-param-reassign': ['error', { props: true }],
	eqeqeq: ['error', 'always'],
	'no-console': 'error',
});

/**
 * JSX in `.js` files (React components). Core ESLint does not see JSX references, so PascalCase names used only in
 * JSX would read as unused.
 * @param {string[]} files globs relative to the unit
 * @param {{ browser?: boolean }} [options] `browser`: the files also run in browsers (browser globals)
 * @returns {import('eslint').Linter.Config}
 */
export const jsxConfig = (files, { browser = false } = {}) => ({
	files,
	languageOptions: {
		parserOptions: { ecmaFeatures: { jsx: true } },
		...(browser ? { globals: { ...globals.node, ...globals.browser } } : {}),
	},
	rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z]', ignoreRestSiblings: true }] },
});

/**
 * The flat config of one unit.
 * @param {{ jsx?: string[], browserJsx?: string[], ignores?: string[] }} [options]
 *   `jsx`: globs of server-side JSX files; `browserJsx`: globs of JSX files that also run in browsers;
 *   `ignores`: extra ignored globs
 * @returns {import('eslint').Linter.Config[]}
 */
export const createEslintConfig = ({ jsx = [], browserJsx = [], ignores = [] } = {}) => [
	{ ignores: [...IGNORES, ...ignores] },
	js.configs.recommended,
	{
		files: ['**/*.js'],
		// ES2025: JSON modules are imported with import attributes (`with { type: 'json' }`)
		languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { ...globals.node } },
		rules: { ...FUNCTIONAL_RULES },
	},
	...(jsx.length > 0 ? [jsxConfig(jsx)] : []),
	...(browserJsx.length > 0 ? [jsxConfig(browserJsx, { browser: true })] : []),
	{
		files: ['**/test/**/*.js', '**/*.test.js'],
		languageOptions: { globals: { ...globals.node } },
		rules: { 'no-param-reassign': 'off' },
	},
];

/** @type {ReturnType<typeof createEslintConfig>} */
const defaultConfig = createEslintConfig();

export default defaultConfig;
