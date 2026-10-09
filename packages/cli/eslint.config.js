import { createEslintConfig } from '@ss/config/eslint';

// the product template mirrors a generated product's own config: ui/ runs in browsers, app/ holds React components
export default createEslintConfig({
	browserJsx: ['templates/product/ui/**/*.js', 'templates/product/app/**/*.js'],
	ignores: ['templates/product/server/widget-script.js'],
});
