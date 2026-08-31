import js from '@eslint/js';
import globals from 'globals';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default [
	{
		ignores: [
			'**/dist/**',
			'**/node_modules/**',
			'**/coverage/**',
			'**/.turbo/**',
			'**/.next/**',
			'portal/.next/**',
			'apps/*/.next/**',
		],
	},
	js.configs.recommended,
	{
		files: ['**/*.{js,jsx,mjs,cjs}'],
		plugins: {
			react: reactPlugin,
			'react-hooks': reactHooksPlugin,
		},
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: {
				ecmaFeatures: {
					jsx: true,
				},
			},
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es2021,
			},
		},
		settings: {
			react: {
				version: 'detect',
			},
		},
		rules: {
			'react/jsx-uses-react': 'error',
			'react/jsx-uses-vars': 'error',
			eqeqeq: ['error', 'smart'],
			'no-var': 'error',
			'prefer-const': 'error',
			'no-unused-vars': [
				'off',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			'no-empty': ['warn', { allowEmptyCatch: true }],
		},
	},
	prettier,
];
