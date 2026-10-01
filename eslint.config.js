import js from '@eslint/js';
import globals from 'globals';

/** Functional-core rules shared by every package. */
export default [
	{ ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**'] },
	js.configs.recommended,
	{
		files: ['**/*.js'],
		languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
		rules: {
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
		},
	},
	{
		// Next.js adapters (App Router components use JSX in .js files)
		files: ['platform/app/**/*.js'],
		languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
		rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z]', ignoreRestSiblings: true }] },
	},
	{
		// React components (JSX in .js): the UI library, the console and their tests; they run in browsers too
		files: ['packages/ui/**/*.js', 'platform/src/console/**/*.js', 'platform/test/console/**/*.js'],
		languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.node, ...globals.browser } },
		// core ESLint does not see JSX references: components (PascalCase) used only in JSX would read as unused
		rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z]', ignoreRestSiblings: true }] },
	},
	{
		files: ['**/test/**/*.js', '**/*.test.js'],
		languageOptions: { globals: { ...globals.node } },
		rules: { 'no-param-reassign': 'off' },
	},
];
