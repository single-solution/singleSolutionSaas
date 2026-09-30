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
		files: ['**/test/**/*.js', '**/*.test.js'],
		languageOptions: { globals: { ...globals.node } },
		rules: { 'no-param-reassign': 'off' },
	},
];
